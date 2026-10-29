import { describe, expect, it } from "vitest";
import {
  ChaptersAdapter,
  createDefaultRegistry,
  DefaultPlatformAdapter,
  PlatformRegistry,
  type PlatformTargetDefinition,
} from "../src";

const EXPECTED_TARGETS = [
  "tiktok",
  "instagram_reels",
  "youtube_shorts",
  "youtube_video",
  "x_video",
  "facebook_reels",
];

describe("PlatformRegistry", () => {
  it("registers the six builtin targets in UI order", () => {
    const registry = createDefaultRegistry();
    expect(registry.list().map((c) => c.id)).toEqual(EXPECTED_TARGETS);
    expect(registry.listPlatforms()).toEqual(["tiktok", "instagram", "youtube", "x", "facebook"]);
  });

  it("supports 9:16, 16:9 and 1:1 among builtin targets", () => {
    const ratios = new Set(
      createDefaultRegistry()
        .list()
        .map((c) => c.video.aspectRatio),
    );
    expect(ratios).toEqual(new Set(["9:16", "16:9", "1:1"]));
  });

  it("uses the default adapter unless a target provides its own", () => {
    const registry = createDefaultRegistry();
    expect(registry.getAdapter("tiktok")).toBeInstanceOf(DefaultPlatformAdapter);
    expect(registry.getAdapter("youtube_video")).toBeInstanceOf(ChaptersAdapter);
  });

  it("rejects duplicate and unknown targets", () => {
    const registry = createDefaultRegistry();
    expect(() => registry.getConfig("myspace")).toThrow(/Unknown platform target/);
    const tiktokConfig = registry.getConfig("tiktok");
    expect(() => registry.register({ config: tiktokConfig })).toThrow(/already registered/);
  });

  it("validates selection and removes duplicates", () => {
    const registry = createDefaultRegistry();
    const selected = registry.resolveSelection(["tiktok", "instagram_reels", "tiktok"]);
    expect(selected.map((c) => c.id)).toEqual(["tiktok", "instagram_reels"]);
    expect(() => registry.resolveSelection([])).toThrow(/At least one/);
    expect(() => registry.resolveSelection(["tiktok", "nope"])).toThrow(/nope/);
  });

  it("applies runtime overrides without touching code, and rejects invalid ones", () => {
    const registry = createDefaultRegistry();
    const merged = registry.setOverride("instagram_reels", {
      specVersion: "2027-01-01",
      video: { maxDurationSec: 240 },
    });
    expect(merged.video.maxDurationSec).toBe(240);
    expect(merged.video.width).toBe(1080);
    expect(registry.getConfig("instagram_reels").specVersion).toBe("2027-01-01");

    expect(() => registry.setOverride("tiktok", { video: { width: 1000 } })).toThrow();
    expect(registry.getConfig("tiktok").video.width).toBe(1080);
    expect(() => registry.setOverride("tiktok", { id: "other" })).toThrow(/target id/);

    registry.clearOverride("instagram_reels");
    expect(registry.getConfig("instagram_reels").video.maxDurationSec).toBe(180);
  });

  it("rejects configs referring to unknown hook templates", () => {
    const registry = new PlatformRegistry();
    const config = { ...createDefaultRegistry().getConfig("tiktok"), id: "tiktok2" };
    config.style = { ...config.style, preferredHookTemplates: ["does_not_exist"] };
    expect(() => registry.register({ config })).toThrow(/unknown hook templates/);
  });
});

describe("adding a new SNS", () => {
  // Threads を Config だけで追加できること（既存コードの変更なし）を確認する
  const threads: PlatformTargetDefinition = {
    config: {
      id: "threads",
      platform: "threads",
      displayName: "Threads",
      contentFamily: "FEED",
      specVersion: "test",
      verified: false,
      video: {
        aspectRatio: "9:16",
        width: 1080,
        height: 1920,
        fps: 30,
        maxDurationSec: 300,
        recommendedDurationSec: { min: 10, max: 60 },
        maxFileSizeMb: 1024,
        loudnessLufs: -14,
        safeArea: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 },
      },
      text: {
        titleLimit: null,
        captionLimit: 500,
        descriptionLimit: null,
        hashtagLimit: 1,
        recommendedHashtags: { min: 0, max: 1 },
        hashtagPlacement: "CAPTION_END",
        textLengthUnit: "CHAR",
        requiredFields: ["caption"],
      },
      style: {
        captionStyle: "CASUAL",
        promptGuidance: "会話のきっかけになる一言で始める。",
        hookEmphasis: "MEDIUM",
        hookMaxSec: 3,
        preferredHookTemplates: ["question_loss"],
        subtitleStyle: "MINIMAL",
        ctaGuidance: "返信を促す",
      },
      features: { chapters: false, customThumbnail: false, scheduling: false },
    },
  };

  it("works end to end with only a config definition", () => {
    const registry = createDefaultRegistry();
    registry.register(threads);

    expect(registry.list().map((c) => c.id)).toContain("threads");
    const adapter = registry.getAdapter("threads");
    const metadata = adapter.normalizeMetadata({
      targetId: "threads",
      caption: "AI副業、最初に何をした？",
      hashtags: ["AI副業", "副業"],
    });
    expect(metadata.hashtags).toEqual(["#AI副業"]);
    expect(adapter.validateMetadata(metadata)).toEqual([]);
    expect(adapter.formatPostText(metadata).body).toBe("AI副業、最初に何をした？\n\n#AI副業");
    expect(adapter.buildMetadataPromptHints()).toContain("Threads");
    expect(adapter.buildRenderSpec({ width: 1080, height: 1920, scenes: [] }).reframe.mode).toBe("NONE");
  });
});
