import type { PlatformTargetDefinition } from "../types";

// 仕様値は未確認（verified: false）。TikTok の公式ドキュメントで確認したら specVersion を更新する。
export const tiktok: PlatformTargetDefinition = {
  config: {
    id: "tiktok",
    platform: "tiktok",
    displayName: "TikTok",
    contentFamily: "SHORT_VERTICAL",
    specVersion: "2026-10-29-draft",
    verified: false,
    video: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      maxDurationSec: 600,
      recommendedDurationSec: { min: 15, max: 45 },
      maxFileSizeMb: 500,
      loudnessLufs: -14,
      safeArea: { top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 },
    },
    text: {
      titleLimit: null,
      captionLimit: 4000,
      descriptionLimit: null,
      hashtagLimit: 10,
      recommendedHashtags: { min: 3, max: 5 },
      hashtagPlacement: "CAPTION_END",
      textLengthUnit: "CHAR",
      requiredFields: ["caption", "hashtags"],
    },
    style: {
      captionStyle: "CASUAL",
      promptGuidance:
        "最初の1〜2秒で結論か意外な事実を見せる。投稿文は短い話し言葉にし、ハッシュタグは少数に絞る。",
      hookEmphasis: "HIGH",
      hookMaxSec: 2,
      preferredHookTemplates: ["shock_fact", "question_loss", "list_teaser"],
      subtitleStyle: "BOLD_CENTER",
      ctaGuidance: "フォローや保存を自然に促す",
    },
    features: { chapters: false, customThumbnail: false, scheduling: true },
  },
};
