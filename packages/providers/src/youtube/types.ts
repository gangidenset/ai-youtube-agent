/**
 * YouTube Data API v3 の Adapter（docs/providers.md#youtube）。
 * ビジネスロジックはこのインターフェースだけを知り、API の形・クォータ・キャッシュの詳細は Adapter 側で扱う。
 */

/** 操作ごとのクォータ消費量（units）。docs/design-proposal.md §14 */
export const YOUTUBE_QUOTA_COST = {
  search: 100,
  videos: 1,
  channels: 1,
  mostPopular: 1,
} as const;
export type YouTubeOperation = keyof typeof YOUTUBE_QUOTA_COST;

/** videos.list / channels.list は 1 回で最大 50 件 */
export const YOUTUBE_MAX_IDS_PER_REQUEST = 50;

export interface SearchQuery {
  q: string;
  regionCode: string;
  relevanceLanguage: string;
  publishedAfter: Date;
  /** 既定 50（最大） */
  maxResults?: number;
}

export interface SearchHit {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: Date;
}

export interface VideoDetails {
  videoId: string;
  channelId: string;
  channelTitle: string | null;
  title: string;
  description: string;
  publishedAt: Date;
  durationSec: number | null;
  categoryId: string | null;
  tags: string[];
  viewCount: number;
  /** 非公開の場合は null */
  likeCount: number | null;
  commentCount: number | null;
}

export interface ChannelStats {
  channelId: string;
  title: string | null;
  /** 登録者数を非公開にしている場合は null */
  subscriberCount: number | null;
}

export interface YouTubeProvider {
  readonly mode: "live" | "mock";
  /** キーワード検索（Shorts 向けに 4 分未満の動画に絞る） */
  searchShortVideos(query: SearchQuery): Promise<SearchHit[]>;
  /** 動画の詳細と統計。ID は何件でもよい（50 件ずつに分けて取得する） */
  getVideos(videoIds: string[]): Promise<VideoDetails[]>;
  /** 地域の急上昇（人気）動画 */
  getMostPopular(regionCode: string, maxResults?: number): Promise<VideoDetails[]>;
  getChannels(channelIds: string[]): Promise<ChannelStats[]>;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
