import { ConfigError, loadConfig } from "@aya/config";
import { createPrismaClient } from "@aya/db";
import { createDefaultRegistry } from "@aya/platforms";
import { RedisCacheStore } from "@aya/providers";
import { type JobHandlers, QUEUE_NAMES, startQueueRuntime } from "@aya/queue";
import { Redis } from "ioredis";
import { marketResearchHandler } from "./jobs/market-research";
import { createYouTubeFactory } from "./providers";

async function main() {
  const config = loadConfig();
  for (const warning of config.providers.warnings) console.warn(`[worker] ${warning}`);

  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const redis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const createYouTube = createYouTubeFactory(config, prisma, new RedisCacheStore(redis));

  /**
   * ジョブの処理。Phase 1 の各 Issue（トレンド分析・企画・台本…）で追加していく。
   * 登録されていないジョブは NO_HANDLER として FAILED になる。
   */
  const handlers: JobHandlers = {
    market_research: marketResearchHandler({ prisma, createYouTube, language: config.env.DEFAULT_LANGUAGE }),
  };

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
    `[worker] started (queues: ${QUEUE_NAMES.join(", ")}; youtube: ${config.providers.youtube}, claude: ${config.providers.claude}, video: ${config.providers.video.join(" > ")}, tts: ${config.providers.tts.join(" > ")}, targets: ${targets.join(", ")})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
    await runtime.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
