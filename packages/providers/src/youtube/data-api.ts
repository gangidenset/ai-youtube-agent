import { parseIsoDuration } from "@aya/core";
import { z } from "zod";
import { ProviderError } from "../errors";
import {
  type ChannelStats,
  chunk,
  type SearchHit,
  type SearchQuery,
  type VideoDetails,
  YOUTUBE_MAX_IDS_PER_REQUEST,
  type YouTubeProvider,
} from "./types";

const API_BASE = "https://www.googleapis.com/youtube/v3";

const count = z.string().regex(/^\d+$/).transform(Number);

const SearchResponse = z.object({
  items: z.array(
    z.object({
      id: z.object({ videoId: z.string().optional() }),
      snippet: z.object({ publishedAt: z.string(), channelId: z.string(), title: z.string() }),
    }),
  ),
});

const VideoItem = z.object({
  id: z.string(),
  snippet: z.object({
    publishedAt: z.string(),
    channelId: z.string(),
    channelTitle: z.string().optional(),
    title: z.string(),
    description: z.string().default(""),
    tags: z.array(z.string()).optional(),
    categoryId: z.string().optional(),
  }),
  contentDetails: z.object({ duration: z.string() }).optional(),
  statistics: z
    .object({ viewCount: count.optional(), likeCount: count.optional(), commentCount: count.optional() })
    .default({}),
});
const VideosResponse = z.object({ items: z.array(VideoItem) });

const ChannelsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({ title: z.string() }).optional(),
      statistics: z
        .object({ subscriberCount: count.optional(), hiddenSubscriberCount: z.boolean().optional() })
        .default({}),
    }),
  ),
});

const ErrorResponse = z.object({
  error: z.object({
    code: z.number(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

function toVideo(item: z.infer<typeof VideoItem>): VideoDetails {
  return {
    videoId: item.id,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle ?? null,
    title: item.snippet.title,
    description: item.snippet.description,
    publishedAt: new Date(item.snippet.publishedAt),
    durationSec: item.contentDetails ? parseIsoDuration(item.contentDetails.duration) : null,
    categoryId: item.snippet.categoryId ?? null,
    tags: item.snippet.tags ?? [],
    viewCount: item.statistics.viewCount ?? 0,
    likeCount: item.statistics.likeCount ?? null,
    commentCount: item.statistics.commentCount ?? null,
  };
}

export interface DataApiOptions {
  apiKey: string;
  /** テスト用 */
  fetch?: typeof fetch;
}

/**
 * YouTube Data API v3 の実装。
 * API キーは URL ではなく X-Goog-Api-Key ヘッダで送る（アクセスログやエラーメッセージに残さないため）。
 * Web 画面のスクレイピングはしない（指示書 §43）。
 */
export class DataApiYouTubeProvider implements YouTubeProvider {
  readonly mode = "live" as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: DataApiOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = `${API_BASE}/${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { "X-Goog-Api-Key": this.options.apiKey, accept: "application/json" },
      });
    } catch {
      throw new ProviderError("YOUTUBE_CONNECTION", "YouTube Data API に接続できませんでした", true);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = ErrorResponse.safeParse(body);
      const reason = parsed.success ? (parsed.data.error.errors?.[0]?.reason ?? "") : "";
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        throw new ProviderError(
          "YOUTUBE_QUOTA_EXCEEDED",
          "YouTube API の 1 日のクォータを使い切りました",
          false,
        );
      }
      if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || res.status >= 500) {
        throw new ProviderError(
          "YOUTUBE_RATE_LIMITED",
          `YouTube API が一時的に利用できません（${res.status}）`,
          true,
        );
      }
      throw new ProviderError(
        "YOUTUBE_REQUEST_FAILED",
        `YouTube API エラー（${res.status}${reason ? ` ${reason}` : ""}）`,
        false,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError("YOUTUBE_UNEXPECTED_RESPONSE", "YouTube API の応答が想定と異なります", false);
    }
    return parsed.data;
  }

  async searchShortVideos(query: SearchQuery): Promise<SearchHit[]> {
    const data = await this.get(
      "search",
      {
        part: "snippet",
        type: "video",
        q: query.q,
        regionCode: query.regionCode,
        relevanceLanguage: query.relevanceLanguage,
        // short = 4 分未満
        videoDuration: "short",
        publishedAfter: query.publishedAfter.toISOString(),
        order: "viewCount",
        maxResults: String(query.maxResults ?? 50),
      },
      SearchResponse,
    );
    return data.items.flatMap((item) =>
      item.id.videoId
        ? [
            {
              videoId: item.id.videoId,
              channelId: item.snippet.channelId,
              title: item.snippet.title,
              publishedAt: new Date(item.snippet.publishedAt),
            },
          ]
        : [],
    );
  }

  async getVideos(videoIds: string[]): Promise<VideoDetails[]> {
    const results: VideoDetails[] = [];
    for (const ids of chunk([...new Set(videoIds)], YOUTUBE_MAX_IDS_PER_REQUEST)) {
      const data = await this.get(
        "videos",
        { part: "snippet,contentDetails,statistics", id: ids.join(","), maxResults: String(ids.length) },
        VideosResponse,
      );
      results.push(...data.items.map(toVideo));
    }
    return results;
  }

  async getMostPopular(regionCode: string, maxResults = 50): Promise<VideoDetails[]> {
    const data = await this.get(
      "videos",
      {
        part: "snippet,contentDetails,statistics",
        chart: "mostPopular",
        regionCode,
        maxResults: String(maxResults),
      },
      VideosResponse,
    );
    return data.items.map(toVideo);
  }

  async getChannels(channelIds: string[]): Promise<ChannelStats[]> {
    const results: ChannelStats[] = [];
    for (const ids of chunk([...new Set(channelIds)], YOUTUBE_MAX_IDS_PER_REQUEST)) {
      const data = await this.get(
        "channels",
        { part: "snippet,statistics", id: ids.join(",") },
        ChannelsResponse,
      );
      results.push(
        ...data.items.map((item) => ({
          channelId: item.id,
          title: item.snippet?.title ?? null,
          subscriberCount: item.statistics.hiddenSubscriberCount
            ? null
            : (item.statistics.subscriberCount ?? null),
        })),
      );
    }
    return results;
  }
}
