import { createHash } from "node:crypto";
import type { ChannelStats, SearchHit, SearchQuery, VideoDetails, YouTubeProvider } from "./types";

/** 文字列から決まる疑似乱数（同じ入力なら毎回同じデータになる） */
function seeded(key: string): () => number {
  let counter = 0;
  return () => {
    const hash = createHash("sha256").update(`${key}:${counter++}`).digest();
    return hash.readUInt32BE(0) / 0xffffffff;
  };
}

const MOCK_CHANNELS = 12;

/**
 * API キーなしで動く YouTubeProvider（ローカル開発・CI 用）。
 * 実在の動画・チャンネルではなく、決まった規則で作った架空のデータを返す。
 */
export class MockYouTubeProvider implements YouTubeProvider {
  readonly mode = "mock" as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private video(videoId: string): VideoDetails {
    const rand = seeded(videoId);
    const channel = Math.floor(rand() * MOCK_CHANNELS);
    const ageHours = 2 + rand() * 24 * 6;
    const views = Math.floor(1000 + rand() * rand() * 500_000);
    return {
      videoId,
      channelId: `mock-channel-${channel}`,
      channelTitle: `サンプルチャンネル ${channel}`,
      title: `【サンプル】${videoId.replace(/^mock-/, "").replaceAll("-", " ")}`,
      description: "モックデータです",
      publishedAt: new Date(this.now().getTime() - ageHours * 3_600_000),
      durationSec: Math.floor(15 + rand() * 165),
      categoryId: "22",
      tags: ["サンプル"],
      viewCount: views,
      likeCount: rand() < 0.1 ? null : Math.floor(views * (0.01 + rand() * 0.06)),
      commentCount: rand() < 0.1 ? null : Math.floor(views * rand() * 0.004),
    };
  }

  async searchShortVideos(query: SearchQuery): Promise<SearchHit[]> {
    const n = Math.min(query.maxResults ?? 50, 20);
    return Array.from({ length: n }, (_, i) => {
      const v = this.video(`mock-${query.q}-${i}`);
      return { videoId: v.videoId, channelId: v.channelId, title: v.title, publishedAt: v.publishedAt };
    });
  }

  async getVideos(videoIds: string[]): Promise<VideoDetails[]> {
    return [...new Set(videoIds)].map((id) => this.video(id));
  }

  async getMostPopular(regionCode: string, maxResults = 50): Promise<VideoDetails[]> {
    return Array.from({ length: Math.min(maxResults, 10) }, (_, i) =>
      this.video(`mock-popular-${regionCode}-${i}`),
    );
  }

  async getChannels(channelIds: string[]): Promise<ChannelStats[]> {
    return [...new Set(channelIds)].map((channelId) => {
      const rand = seeded(channelId);
      return {
        channelId,
        title: channelId,
        subscriberCount: rand() < 0.1 ? null : Math.floor(500 + rand() * rand() * 1_000_000),
      };
    });
  }
}
