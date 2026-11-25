import type { AppConfig } from "@aya/config";
import type { PrismaClient } from "@aya/db";
import { createDefaultRegistry, type PlatformRegistry } from "@aya/platforms";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { LoginService } from "./auth/login";
import { registerAuth } from "./auth/plugin";
import { SessionStore } from "./auth/session";
import { registerErrorHandler } from "./errors";
import { authRoutes } from "./routes/auth";
import { platformTargetRoutes } from "./routes/platform-targets";
import { projectRoutes } from "./routes/projects";
import { researchRunRoutes } from "./routes/research-runs";

export interface ServerDeps {
  config: AppConfig;
  prisma: PrismaClient;
  logger?: boolean;
  platforms?: PlatformRegistry;
  /** Rate Limit の共有ストア。省略時はプロセス内メモリ（テスト・単一インスタンス用） */
  rateLimitRedis?: Redis;
  now?: () => Date;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { env } = deps.config;
  const app = Fastify({
    logger: deps.logger ?? false,
    // 手前のプロキシ TRUST_PROXY_HOPS 段だけを信用して X-Forwarded-For からクライアント IP を得る
    trustProxy:
      env.TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS : false,
    bodyLimit: 1024 * 1024,
  });
  const secureCookie = env.NODE_ENV === "production";
  const sessions = new SessionStore(deps.prisma, deps.now);
  const login = new LoginService(deps.prisma, deps.now);

  registerErrorHandler(app);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/healthz",
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis, nameSpace: "aya:ratelimit:" } : {}),
  });

  registerAuth(app, {
    sessions,
    sessionSecret: env.SESSION_SECRET,
    allowedOrigin: env.APP_BASE_URL,
    secureCookie,
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  await authRoutes(app, {
    prisma: deps.prisma,
    sessions,
    login,
    sessionSecret: env.SESSION_SECRET,
    secureCookie,
  });
  await platformTargetRoutes(app, deps.platforms ?? createDefaultRegistry());
  await researchRunRoutes(app, deps.prisma);
  await projectRoutes(app, deps.prisma);

  return app;
}
