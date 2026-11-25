import { ConfigError, loadConfig } from "@aya/config";
import { createPrismaClient } from "@aya/db";
import { createDefaultRegistry } from "@aya/platforms";
import { type JobHandlers, QUEUE_NAMES, startQueueRuntime } from "@aya/queue";

/**
 * ジョブの処理。Phase 1 の各 Issue（市場分析・トレンド分析・企画・台本…）で追加していく。
 * 登録されていないジョブは NO_HANDLER として FAILED になる。
 */
const handlers: JobHandlers = {};

async function main() {
  const config = loadConfig();
  for (const warning of config.providers.warnings) console.warn(`[worker] ${warning}`);

  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const runtime = startQueueRuntime({
    prisma,
    redisUrl: config.env.REDIS_URL,
    handlers,
    log: (message) => console.error(`[worker] ${message}`),
  });

  const targets = createDefaultRegistry()
    .list()
    .map((c) => c.id);
  console.log(
    `[worker] started (queues: ${QUEUE_NAMES.join(", ")}; video: ${config.providers.video.join(" > ")}, tts: ${config.providers.tts.join(" > ")}, targets: ${targets.join(", ")})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
    await runtime.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
