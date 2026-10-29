import type { PlatformTargetDefinition } from "../types";

// 仕様値は未確認（verified: false）。YouTube の公式ドキュメントで確認したら specVersion を更新する。
export const youtubeShorts: PlatformTargetDefinition = {
  config: {
    id: "youtube_shorts",
    platform: "youtube",
    displayName: "YouTube Shorts",
    contentFamily: "SHORT_VERTICAL",
    specVersion: "2026-10-29-draft",
    verified: false,
    video: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      maxDurationSec: 180,
      recommendedDurationSec: { min: 20, max: 45 },
      maxFileSizeMb: 2048,
      loudnessLufs: -14,
      safeArea: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.15 },
    },
    text: {
      titleLimit: 100,
      captionLimit: null,
      descriptionLimit: 5000,
      hashtagLimit: 15,
      fixedHashtags: ["#Shorts"],
      recommendedHashtags: { min: 2, max: 3 },
      hashtagPlacement: "DESCRIPTION_END",
      textLengthUnit: "CHAR",
      requiredFields: ["title", "description", "hashtags"],
    },
    style: {
      captionStyle: "FRIENDLY",
      promptGuidance:
        "タイトルは検索も意識し、【初心者向け】のように対象を明示してよい。冒頭1秒で主題を示す。",
      hookEmphasis: "HIGH",
      hookMaxSec: 2,
      preferredHookTemplates: ["question_loss", "list_teaser", "conclusion_first"],
      subtitleStyle: "BOLD_CENTER",
      ctaGuidance: "チャンネル登録や関連動画への誘導",
    },
    features: { chapters: false, customThumbnail: false, scheduling: true },
  },
};
