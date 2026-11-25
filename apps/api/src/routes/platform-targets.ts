import type { PlatformRegistry } from "@aya/platforms";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/guards";

export async function platformTargetRoutes(app: FastifyInstance, platforms: PlatformRegistry): Promise<void> {
  // 出力先 SNS の一覧（UI のチェックボックスはこの一覧から描画する。docs/api.md）
  app.get("/api/v1/platform-targets", async (request) => {
    requireAuth(request);
    return {
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
    };
  });
}
