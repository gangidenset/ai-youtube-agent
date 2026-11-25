import { describe, expect, it } from "vitest";
import {
  type CacheStore,
  DataApiYouTubeProvider,
  GuardedYouTubeProvider,
  MockYouTubeProvider,
  QuotaExceededError,
  type QuotaStore,
} from "../src";

const API_KEY = "test-api-key-123";

/** 偽の fetch: 呼ばれた URL・ヘッダを記録し、パスに応じた応答を返す */
function fakeFetch(handler: (url: URL) => { status?: number; body: unknown }) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const videoItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  snippet: {
    publishedAt: "2026-11-24T00:00:00Z",
    channelId: `ch-${id}`,
    channelTitle: "チャンネル",
    title: `動画 ${id}`,
    description: "説明",
    tags: ["AI"],
    categoryId: "22",
  },
  contentDetails: { duration: "PT45S" },
  statistics: { viewCount: "1000", likeCount: "50", commentCount: "3" },
  ...extra,
});

describe("DataApiYouTubeProvider", () => {
  it("searches Shorts in Japan with the key in a header, never in the URL", async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: {
        items: [
          {
            id: { videoId: "v1" },
            snippet: { publishedAt: "2026-11-24T00:00:00Z", channelId: "c1", title: "t" },
          },
        ],
      },
    }));
    const yt = new DataApiYouTubeProvider({ apiKey: API_KEY, fetch: fn });
    const hits = await yt.searchShortVideos({
      q: "AI 副業",
      regionCode: "JP",
      relevanceLanguage: "ja",
      publishedAfter: new Date("2026-11-18T00:00:00Z"),
    });
    expect(hits).toEqual([
      { videoId: "v1", channelId: "c1", title: "t", publishedAt: new Date("2026-11-24T00:00:00Z") },
    ]);

    const { url, headers } = calls[0]!;
    expect(url.pathname).toBe("/youtube/v3/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      type: "video",
      q: "AI 副業",
      regionCode: "JP",
      relevanceLanguage: "ja",
      videoDuration: "short",
      order: "viewCount",
      publishedAfter: "2026-11-18T00:00:00.000Z",
    });
    expect(url.toString()).not.toContain(API_KEY);
    expect(headers["X-Goog-Api-Key"]).toBe(API_KEY);
  });

  it("fetches video details in batches of 50 and parses durations and hidden counts", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const { fn, calls } = fakeFetch((url) => ({
      body: {
        items: (url.searchParams.get("id") ?? "")
          .split(",")
          .map((id) => (id === "v0" ? videoItem(id, { statistics: { viewCount: "10" } }) : videoItem(id))),
      },
    }));
    const videos = await new DataApiYouTubeProvider({ apiKey: API_KEY, fetch: fn }).getVideos(ids);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.url.searchParams.get("id")?.split(",").length)).toEqual([50, 50, 20]);
    expect(videos).toHaveLength(120);
    expect(videos[0]).toMatchObject({
      videoId: "v0",
      viewCount: 10,
      likeCount: null,
      commentCount: null,
      durationSec: 45,
    });
    expect(videos[1]).toMatchObject({ viewCount: 1000, likeCount: 50, commentCount: 3, tags: ["AI"] });
  });

  it("returns null subscribers for channels that hide them", async () => {
    const { fn } = fakeFetch(() => ({
      body: {
        items: [
          {
            id: "c1",
            snippet: { title: "A" },
            statistics: { subscriberCount: "1200", hiddenSubscriberCount: false },
          },
          { id: "c2", snippet: { title: "B" }, statistics: { hiddenSubscriberCount: true } },
        ],
      },
    }));
    expect(
      await new DataApiYouTubeProvider({ apiKey: API_KEY, fetch: fn }).getChannels(["c1", "c2"]),
    ).toEqual([
      { channelId: "c1", title: "A", subscriberCount: 1200 },
      { channelId: "c2", title: "B", subscriberCount: null },
    ]);
  });

  it("classifies API errors for retries", async () => {
    const error = (status: number, reason: string) =>
      new DataApiYouTubeProvider({
        apiKey: API_KEY,
        fetch: fakeFetch(() => ({ status, body: { error: { code: status, errors: [{ reason }] } } })).fn,
      }).getMostPopular("JP");
    await expect(error(403, "quotaExceeded")).rejects.toMatchObject({
      code: "YOUTUBE_QUOTA_EXCEEDED",
      retryable: false,
    });
    await expect(error(403, "rateLimitExceeded")).rejects.toMatchObject({
      code: "YOUTUBE_RATE_LIMITED",
      retryable: true,
    });
    await expect(error(503, "backendError")).rejects.toMatchObject({ retryable: true });
    await expect(error(400, "keyInvalid")).rejects.toMatchObject({
      code: "YOUTUBE_REQUEST_FAILED",
      retryable: false,
    });
    const err = await error(400, "keyInvalid").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(API_KEY);
  });
});

function memoryQuota(limit: number): QuotaStore & { used: number } {
  return {
    used: 0,
    async reserve(units) {
      if (this.used + units > limit) return { ok: false, remaining: limit - this.used };
      this.used += units;
      return { ok: true };
    },
  };
}

function memoryCache(): CacheStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

describe("GuardedYouTubeProvider", () => {
  const now = () => new Date("2026-11-25T00:00:00Z");
  const query = {
    q: "AI",
    regionCode: "JP",
    relevanceLanguage: "ja",
    publishedAfter: new Date("2026-11-18T00:12:34Z"),
  };

  it("reserves quota per API call and serves repeats from the cache for free", async () => {
    const quota = memoryQuota(10_000);
    const cache = memoryCache();
    const yt = new GuardedYouTubeProvider(new MockYouTubeProvider(now), quota, cache);

    const first = await yt.searchShortVideos(query);
    expect(quota.used).toBe(100);
    const again = await yt.searchShortVideos({ ...query, publishedAfter: new Date("2026-11-18T00:40:00Z") });
    expect(again).toEqual(first);
    expect(again[0]?.publishedAt).toBeInstanceOf(Date);
    expect(quota.used).toBe(100);

    await yt.getVideos(Array.from({ length: 60 }, (_, i) => `id${i}`));
    expect(quota.used).toBe(102); // 50 件ずつ 2 回
    await yt.getMostPopular("JP");
    await yt.getChannels(["a", "b"]);
    expect(quota.used).toBe(104);
    expect(yt.unitsUsed).toBe(104);
  });

  it("does not call the API when the quota would be exceeded", async () => {
    let called = false;
    const inner = new MockYouTubeProvider(now);
    const spy = Object.assign(Object.create(inner) as MockYouTubeProvider, {
      searchShortVideos: async () => {
        called = true;
        return [];
      },
    });
    const yt = new GuardedYouTubeProvider(spy, memoryQuota(99), null);
    const err = await yt.searchShortVideos(query).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err).toMatchObject({ retryable: false, operation: "search", remaining: 99 });
    expect(called).toBe(false);
  });

  it("keeps working when the cache is unavailable", async () => {
    const broken: CacheStore = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
    };
    const yt = new GuardedYouTubeProvider(new MockYouTubeProvider(now), memoryQuota(10_000), broken);
    expect((await yt.getMostPopular("JP")).length).toBeGreaterThan(0);
  });
});

describe("MockYouTubeProvider", () => {
  it("returns deterministic data", async () => {
    const now = () => new Date("2026-11-25T00:00:00Z");
    const a = await new MockYouTubeProvider(now).getVideos(["mock-x-1"]);
    const b = await new MockYouTubeProvider(now).getVideos(["mock-x-1"]);
    expect(a).toEqual(b);
  });
});
