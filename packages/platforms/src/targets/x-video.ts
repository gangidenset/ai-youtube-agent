import type { PlatformTargetDefinition } from "../types";

// 仕様値は未確認（verified: false）。X の公式ドキュメントで確認したら specVersion を更新する。
// 投稿文は加重文字数（全角 = 2）で 280 まで。尺の上限は一般アカウントの値。
export const xVideo: PlatformTargetDefinition = {
  config: {
    id: "x_video",
    platform: "x",
    displayName: "X",
    contentFamily: "FEED",
    specVersion: "2026-10-29-draft",
    verified: false,
    video: {
      aspectRatio: "1:1",
      width: 1080,
      height: 1080,
      fps: 30,
      maxDurationSec: 140,
      recommendedDurationSec: { min: 15, max: 45 },
      maxFileSizeMb: 512,
      loudnessLufs: -14,
      safeArea: { top: 0.03, bottom: 0.08, left: 0.03, right: 0.03 },
    },
    text: {
      titleLimit: null,
      captionLimit: 280,
      descriptionLimit: null,
      hashtagLimit: 2,
      recommendedHashtags: { min: 1, max: 2 },
      hashtagPlacement: "CAPTION_END",
      textLengthUnit: "WEIGHTED",
      requiredFields: ["caption"],
    },
    style: {
      captionStyle: "CONCISE",
      promptGuidance:
        "投稿文は1〜2文で要点だけを書く。ミュート再生が前提なので映像内の字幕で内容が伝わるようにする。",
      hookEmphasis: "HIGH",
      hookMaxSec: 2,
      preferredHookTemplates: ["shock_fact", "conclusion_first"],
      subtitleStyle: "BOLD_CENTER",
      ctaGuidance: "リプライや引用で意見を募る",
    },
    features: { chapters: false, customThumbnail: false, scheduling: true },
  },
};
