import { ProviderError } from "../errors";
import {
  type ChannelStats,
  chunk,
  type SearchHit,
  type SearchQuery,
  type VideoDetails,
  YOUTUBE_MAX_IDS_PER_REQUEST,
  YOUTUBE_QUOTA_COST,
  type YouTubeOperation,
  type YouTubeProvider,
} from "./types";

/**
 * クォータの台帳（実装は packages/db の PrismaQuotaStore）。
 * reserve は「使ってよいなら使用量を加算して true」を 1 回の原子的な操作で行う。
 */
export interface QuotaStore {
  reserve(units: number): Promise<{ ok: true } | { ok: false; remaining: number }>;
}

/** キャッシュ（実装は Redis）。値は JSON にして保存する。 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** キャッシュの保持時間（docs/providers.md: 検索 6〜24h、統計 1h） */
export const YOUTUBE_CACHE_TTL_SECONDS = {
  search: 6 * 3600,
  videos: 3600,
  mostPopular: 3600,
  channels: 24 * 3600,
} as const;

export class QuotaExceededError extends ProviderError {
  constructor(
    readonly operation: YouTubeOperation,
    readonly remaining: number,
  ) {
    super(
      "YOUTUBE_QUOTA_EXCEEDED",
      `YouTube API のクォータが足りません（${operation}、残り ${remaining} units）`,
      false,
      {
        operation,
        remaining,
      },
    );
    this.name = "QuotaExceededError";
  }
}

const dateReviver = (key: string, value: unknown) =>
  key === "publishedAt" && typeof value === "string" ? new Date(value) : value;

/**
 * 呼び出しの前にクォータを予約し、結果をキャッシュする YouTubeProvider のラッパー。
 * - キャッシュにあればクォータを使わない
 * - 予約できなければ API を呼ばずに QuotaExceededError（ジョブは翌日に延期する）
 * - 失敗したリクエストにもクォータが課されるため、予約は取り消さない
 */
export class GuardedYouTubeProvider implements YouTubeProvider {
  readonly mode: "live" | "mock";
  /** このインスタンスで予約したクォータの合計（ジョブごとに作れば、そのジョブの使用量になる） */
  unitsUsed = 0;

  constructor(
    private readonly inner: YouTubeProvider,
    private readonly quota: QuotaStore,
    private readonly cache: CacheStore | null,
    private readonly cachePrefix = "aya:youtube:",
  ) {
    this.mode = inner.mode;
  }

  private async reserve(operation: YouTubeOperation, times = 1) {
    const units = YOUTUBE_QUOTA_COST[operation] * times;
    const result = await this.quota.reserve(units);
    if (!result.ok) throw new QuotaExceededError(operation, result.remaining);
    this.unitsUsed += units;
  }

  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const fullKey = `${this.cachePrefix}${this.inner.mode}:${key}`;
    const hit = await this.cache?.get(fullKey).catch(() => null);
    if (hit) return JSON.parse(hit, dateReviver) as T;
    const value = await load();
    // キャッシュの書き込み失敗では処理を止めない
    await this.cache?.set(fullKey, JSON.stringify(value), ttl).catch(() => undefined);
    return value;
  }

  searchShortVideos(query: SearchQuery): Promise<SearchHit[]> {
    // 公開日の条件は時間単位に丸めてキャッシュを効かせる
    const after = new Date(Math.floor(query.publishedAfter.getTime() / 3_600_000) * 3_600_000);
    const key = `search:${query.regionCode}:${query.relevanceLanguage}:${after.toISOString()}:${query.maxResults ?? 50}:${query.q}`;
    return this.cached(key, YOUTUBE_CACHE_TTL_SECONDS.search, async () => {
      await this.reserve("search");
      return this.inner.searchShortVideos({ ...query, publishedAfter: after });
    });
  }

  async getVideos(videoIds: string[]): Promise<VideoDetails[]> {
    const results: VideoDetails[] = [];
    for (const ids of chunk([...new Set(videoIds)].sort(), YOUTUBE_MAX_IDS_PER_REQUEST)) {
      results.push(
        ...(await this.cached(`videos:${ids.join(",")}`, YOUTUBE_CACHE_TTL_SECONDS.videos, async () => {
          await this.reserve("videos");
          return this.inner.getVideos(ids);
        })),
      );
    }
    return results;
  }

  getMostPopular(regionCode: string, maxResults = 50): Promise<VideoDetails[]> {
    return this.cached(
      `popular:${regionCode}:${maxResults}`,
      YOUTUBE_CACHE_TTL_SECONDS.mostPopular,
      async () => {
        await this.reserve("mostPopular");
        return this.inner.getMostPopular(regionCode, maxResults);
      },
    );
  }

  async getChannels(channelIds: string[]): Promise<ChannelStats[]> {
    const results: ChannelStats[] = [];
    for (const ids of chunk([...new Set(channelIds)].sort(), YOUTUBE_MAX_IDS_PER_REQUEST)) {
      results.push(
        ...(await this.cached(`channels:${ids.join(",")}`, YOUTUBE_CACHE_TTL_SECONDS.channels, async () => {
          await this.reserve("channels");
          return this.inner.getChannels(ids);
        })),
      );
    }
    return results;
  }
}
