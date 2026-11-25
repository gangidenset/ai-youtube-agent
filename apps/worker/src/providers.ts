import type { AppConfig } from "@aya/config";
import { type PrismaClient, PrismaQuotaStore } from "@aya/db";
import {
  type CacheStore,
  DataApiYouTubeProvider,
  GuardedYouTubeProvider,
  MockYouTubeProvider,
  type YouTubeProvider,
} from "@aya/providers";

/** API キーがあれば実際の YouTube Data API、無ければ mock（packages/config の planProviders）。 */
export function createYouTubeFactory(config: AppConfig, prisma: PrismaClient, cache: CacheStore | null) {
  const inner: YouTubeProvider =
    config.providers.youtube === "live" && config.env.YOUTUBE_API_KEY
      ? new DataApiYouTubeProvider({ apiKey: config.env.YOUTUBE_API_KEY })
      : new MockYouTubeProvider();
  const quota = new PrismaQuotaStore(prisma, {
    provider: "youtube",
    // mock は本物のクォータと別に数える
    bucket: inner.mode === "live" ? "youtube:default" : "youtube:mock",
    dailyLimit: config.env.YOUTUBE_DAILY_QUOTA,
  });
  return () => new GuardedYouTubeProvider(inner, quota, cache);
}
