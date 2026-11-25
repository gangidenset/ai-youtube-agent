import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors";
import type { SessionInfo, SessionStore } from "./session";
import { deriveCsrfToken, safeEqual } from "./tokens";

export const SESSION_COOKIE = "aya_sid";
export const CSRF_HEADER = "x-csrf-token";

export interface AuthContext extends SessionInfo {
  /** Cookie のセッショントークン（CSRF トークンの導出にだけ使う） */
  token: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AuthPluginOptions {
  sessions: SessionStore;
  sessionSecret: string;
  /** 状態を変えるリクエストを受け付けるオリジン（APP_BASE_URL） */
  allowedOrigin: string;
  secureCookie: boolean;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (origin) return origin;
  const referer = request.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(secureCookie: boolean, expires?: Date) {
  return {
    path: "/",
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax" as const,
    ...(expires ? { expires } : {}),
  };
}

/**
 * - Cookie のセッションを解決して request.auth に入れる
 * - 状態を変えるリクエスト（POST/PUT/PATCH/DELETE）は Origin を検証し、
 *   ログイン済みなら X-CSRF-Token も検証する（docs/security.md の CSRF 対策）
 */
export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  const allowedOrigin = new URL(options.allowedOrigin).origin;
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    request.auth = null;
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = await options.sessions.resolve(token);
      if (session) {
        request.auth = { ...session, token };
      } else {
        reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(options.secureCookie));
      }
    }

    if (!UNSAFE_METHODS.has(request.method)) return;

    if (requestOrigin(request) !== allowedOrigin) {
      throw new AppError(403, "INVALID_ORIGIN", "許可されていないオリジンからのリクエストです");
    }
    if (request.auth) {
      const sent = request.headers[CSRF_HEADER];
      const expected = deriveCsrfToken(request.auth.token, options.sessionSecret);
      if (typeof sent !== "string" || !safeEqual(sent, expected)) {
        throw new AppError(
          403,
          "INVALID_CSRF_TOKEN",
          "CSRF トークンが不正です。画面を再読み込みしてください",
        );
      }
    }
  });
}
