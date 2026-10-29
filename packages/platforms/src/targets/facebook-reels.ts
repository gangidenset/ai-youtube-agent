import type { PlatformTargetDefinition } from "../types";

// 仕様値は未確認（verified: false）。Facebook の公式ドキュメントで確認したら specVersion を更新する。
export const facebookReels: PlatformTargetDefinition = {
  config: {
    id: "facebook_reels",
    platform: "facebook",
    displayName: "Facebook Reels",
    contentFamily: "SHORT_VERTICAL",
    specVersion: "2026-10-29-draft",
    verified: false,
    video: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      maxDurationSec: 90,
      recommendedDurationSec: { min: 15, max: 30 },
      maxFileSizeMb: 1024,
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
      requiredFields: ["caption"],
    },
    style: {
      captionStyle: "FRIENDLY",
      promptGuidance: "幅広い年齢層を想定し、わかりやすい言葉で書く。共感を呼ぶ一言から始める。",
      hookEmphasis: "MEDIUM",
      hookMaxSec: 3,
      preferredHookTemplates: ["problem_fact_conclusion", "question_loss"],
      subtitleStyle: "CLEAN_BOTTOM",
      ctaGuidance: "シェアやコメントを促す",
    },
    features: { chapters: false, customThumbnail: false, scheduling: true },
  },
};
