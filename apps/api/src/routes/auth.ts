import type { PrismaClient } from "@aya/db";
import { permissionsOf } from "@aya/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAuditLog } from "../audit";
import { requireAuth } from "../auth/guards";
import type { LoginService } from "../auth/login";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/plugin";
import type { SessionStore } from "../auth/session";
import { deriveCsrfToken } from "../auth/tokens";
import { AppError } from "../errors";

const LoginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});

/** 失敗理由は区別せずに返す（アカウントの有無やロック状態を推測させない） */
const LOGIN_FAILED = new AppError(
  401,
  "LOGIN_FAILED",
  "メールアドレスまたはパスワードが違います。連続で失敗すると一定時間ログインできなくなります",
);

export interface AuthRouteDeps {
  prisma: PrismaClient;
  sessions: SessionStore;
  login: LoginService;
  sessionSecret: string;
  secureCookie: boolean;
}

async function loadProfile(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { memberships: { include: { channel: true }, orderBy: { createdAt: "asc" } } },
  });
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    channels: user.memberships
      .filter((m) => !m.channel.deletedAt)
      .map((m) => ({
        id: m.channelId,
        name: m.channel.name,
        role: m.role,
        permissions: permissionsOf(m.role),
      })),
  };
}

export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  app.post(
    "/api/v1/auth/login",
    // 認証 API は IP ごとに 1 分 5 回まで（docs/api.md）
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(400, "INVALID_REQUEST", "メールアドレスとパスワードを入力してください");
      const { email, password } = parsed.data;

      const result = await deps.login.attempt(email, password);
      if (!result.ok) {
        await writeAuditLog(deps.prisma, request, {
          level: "WARN",
          category: "AUTH",
          message: `login failed: ${result.reason}`,
          actorId: result.userId ?? null,
          // パスワードは記録しない
          context: { email: email.toLowerCase(), reason: result.reason },
        });
        throw LOGIN_FAILED;
      }

      // ログインごとに新しいトークンを発行する（セッション固定攻撃の防止）
      const previous = request.auth;
      if (previous) await deps.sessions.revoke(previous.sessionId);
      const session = await deps.sessions.create(result.userId, {
        ip: request.ip,
        ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      });
      reply.setCookie(
        SESSION_COOKIE,
        session.token,
        sessionCookieOptions(deps.secureCookie, session.expiresAt),
      );
      await writeAuditLog(deps.prisma, request, {
        level: "INFO",
        category: "AUTH",
        message: "login succeeded",
        actorId: result.userId,
      });

      return {
        user: await loadProfile(deps.prisma, result.userId),
        csrfToken: deriveCsrfToken(session.token, deps.sessionSecret),
      };
    },
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const auth = requireAuth(request);
    await deps.sessions.revoke(auth.sessionId);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(deps.secureCookie));
    await writeAuditLog(deps.prisma, request, {
      level: "INFO",
      category: "AUTH",
      message: "logout",
      actorId: auth.userId,
    });
    return reply.status(204).send();
  });

  app.get("/api/v1/auth/me", async (request) => {
    const auth = requireAuth(request);
    return {
      user: await loadProfile(deps.prisma, auth.userId),
      csrfToken: deriveCsrfToken(auth.token, deps.sessionSecret),
    };
  });
}
