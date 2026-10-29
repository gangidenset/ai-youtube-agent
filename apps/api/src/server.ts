import { createDefaultRegistry, type PlatformRegistry } from "@aya/platforms";
import Fastify, { type FastifyInstance } from "fastify";

export interface ServerOptions {
  logger?: boolean;
  platforms?: PlatformRegistry;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const platforms = options.platforms ?? createDefaultRegistry();

  app.get("/healthz", async () => ({ status: "ok" }));

  // 出力先 SNS の一覧（UI のチェックボックスはこの一覧から描画する。docs/api.md）
  app.get("/api/v1/platform-targets", async () => ({
    targets: platforms.list().map((c) => ({
      id: c.id,
      platform: c.platform,
      displayName: c.displayName,
      contentFamily: c.contentFamily,
      aspectRatio: c.video.aspectRatio,
      maxDurationSec: c.video.maxDurationSec,
      recommendedDurationSec: c.video.recommendedDurationSec,
      specVersion: c.specVersion,
      verified: c.verified,
    })),
  }));

  return app;
}
