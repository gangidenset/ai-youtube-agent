import type { PlatformTargetDefinition } from "../types";

// 仕様値は未確認（verified: false）。Instagram の公式ドキュメントで確認したら specVersion を更新する。
export const instagramReels: PlatformTargetDefinition = {
  config: {
    id: "instagram_reels",
    platform: "instagram",
    displayName: "Instagram Reels",
    contentFamily: "SHORT_VERTICAL",
    specVersion: "2026-10-29-draft",
    verified: false,
    video: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      maxDurationSec: 180,
      recommendedDurationSec: { min: 15, max: 30 },
      maxFileSizeMb: 300,
      loudnessLufs: -14,
      safeArea: { top: 0.1, bottom: 0.25, left: 0.05, right: 0.12 },
    },
    text: {
      titleLimit: null,
      captionLimit: 2200,
      descriptionLimit: null,
      hashtagLimit: 5,
      recommendedHashtags: { min: 3, max: 5 },
      hashtagPlacement: "CAPTION_END",
      textLengthUnit: "CHAR",
      requiredFields: ["caption", "hashtags"],
    },
    style: {
      captionStyle: "FRIENDLY",
      promptGuidance: "キャプションの1行目で価値を伝え、改行で読みやすくする。世界観や共感を大切にする。",
      hookEmphasis: "HIGH",
      hookMaxSec: 2,
      preferredHookTemplates: ["problem_fact_conclusion", "conclusion_first"],
      subtitleStyle: "CLEAN_BOTTOM",
      ctaGuidance: "保存やシェアを促す",
    },
    features: { chapters: false, customThumbnail: true, scheduling: true },
  },
};
