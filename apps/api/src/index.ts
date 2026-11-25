import { ConfigError, loadConfig } from "@aya/config";
import { createPrismaClient } from "@aya/db";
import { Redis } from "ioredis";
import { buildServer } from "./server";

async function start() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const redis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const app = await buildServer({ config, prisma, rateLimitRedis: redis, logger: true });

  for (const warning of config.providers.warnings) app.log.warn(warning);
  app.log.info({ providers: { ...config.providers, warnings: undefined } }, "provider plan");

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));

  await app.listen({ port: config.env.API_PORT, host: "0.0.0.0" });
}

start().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
