import { describe, expect, it } from "vitest";
import { createDefaultRegistry, formatTimestamp } from "../src";

const registry = createDefaultRegistry();

describe("metadata per platform", () => {
  it("adds fixed hashtags from config (YouTube Shorts adds #Shorts)", () => {
    const adapter = registry.getAdapter("youtube_shorts");
    const m = adapter.normalizeMetadata({
      targetId: "youtube_shorts",
      title: " 【初心者向け】AI副業で最初にやるべき3つ ",
      description: "説明",
      hashtags: ["AI副業", "#shorts"],
    });
    expect(m.title).toBe("【初心者向け】AI副業で最初にやるべき3つ");
    expect(m.hashtags).toEqual(["#Shorts", "#AI副業"]);
    expect(adapter.validateMetadata(m)).toEqual([]);
    expect(adapter.formatPostText(m)).toEqual({
      title: "【初心者向け】AI副業で最初にやるべき3つ",
      body: "説明\n\n#Shorts #AI副業",
    });
  });

  it("reports missing required fields and unsupported fields", () => {
    const adapter = registry.getAdapter("tiktok");
    const issues = adapter.validateMetadata({ targetId: "tiktok", title: "タイトル", hashtags: [] });
    expect(issues.map((i) => [i.field, i.code])).toEqual([
      ["caption", "MISSING"],
      ["hashtags", "MISSING"],
      ["title", "NOT_SUPPORTED"],
    ]);
  });

  it("checks X post text with weighted length including hashtags", () => {
    const adapter = registry.getAdapter("x_video");
    const ok = adapter.normalizeMetadata({
      targetId: "x_video",
      caption: "あ".repeat(130),
      hashtags: ["AI副業"],
    });
    expect(adapter.validateMetadata(ok)).toEqual([]);

    // 本文 140 文字（=280）だけなら上限内だが、ハッシュタグを付けると超える
    const tooLong = adapter.normalizeMetadata({
      targetId: "x_video",
      caption: "あ".repeat(140),
      hashtags: ["AI"],
    });
    const issues = adapter.validateMetadata(tooLong);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "postText", code: "TOO_LONG", limit: 280 });
  });

  it("flags too many hashtags before normalization trims them", () => {
    const adapter = registry.getAdapter("instagram_reels");
    const issues = adapter.validateMetadata({
      targetId: "instagram_reels",
      caption: "キャプション",
      hashtags: ["#a", "#b", "#c", "#d", "#e", "#f"],
    });
    expect(issues).toEqual([expect.objectContaining({ code: "TOO_MANY_HASHTAGS", limit: 5, actual: 6 })]);
  });

  it("rejects chapters on targets that do not support them", () => {
    const adapter = registry.getAdapter("tiktok");
    const issues = adapter.validateMetadata({
      targetId: "tiktok",
      caption: "c",
      hashtags: ["#a"],
      chapters: [{ startSec: 0, title: "a" }],
    });
    expect(issues).toEqual([expect.objectContaining({ field: "chapters", code: "NOT_SUPPORTED" })]);
  });

  it("formats and validates chapters for YouTube long-form", () => {
    const adapter = registry.getAdapter("youtube_video");
    const chapters = [
      { startSec: 0, title: "はじめに" },
      { startSec: 30, title: "1つ目" },
      { startSec: 75, title: "まとめ" },
    ];
    const m = adapter.normalizeMetadata({
      targetId: "youtube_video",
      title: "t",
      description: "説明",
      hashtags: ["AI"],
      chapters,
    });
    expect(adapter.validateMetadata(m)).toEqual([]);
    expect(adapter.formatPostText(m).body).toBe("説明\n\n00:00 はじめに\n00:30 1つ目\n01:15 まとめ\n\n#AI");

    const bad = adapter.validateMetadata({ ...m, chapters: chapters.slice(0, 2) });
    expect(bad).toEqual([expect.objectContaining({ code: "INVALID_CHAPTERS" })]);
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });

  it("builds prompt hints from config only", () => {
    const hints = registry.getAdapter("x_video").buildMetadataPromptHints();
    expect(hints).toContain("target_id: x_video");
    expect(hints).toContain("280文字以内（全角は2文字として数える）");
    expect(hints).toContain("タイトル: 使わない");
  });
});
