import { ChaptersAdapter } from "../adapters/chapters-adapter";
import type { PlatformTargetDefinition } from "../types";

// 仕様値は未確認（verified: false）。YouTube の公式ドキュメントで確認したら specVersion を更新する。
// MVP ではショート用マスターを 16:9 にリフレームした簡易版。本格的な長尺は別系統のマスターで対応する。
export const youtubeVideo: PlatformTargetDefinition = {
  config: {
    id: "youtube_video",
    platform: "youtube",
    displayName: "YouTube（通常動画）",
    contentFamily: "LONG_HORIZONTAL",
    specVersion: "2026-10-29-draft",
    verified: false,
    video: {
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      fps: 30,
      maxDurationSec: 43200,
      recommendedDurationSec: { min: 180, max: 900 },
      maxFileSizeMb: 10240,
      loudnessLufs: -14,
      safeArea: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 },
    },
    text: {
      titleLimit: 100,
      captionLimit: null,
      descriptionLimit: 5000,
      hashtagLimit: 15,
      recommendedHashtags: { min: 3, max: 5 },
      hashtagPlacement: "DESCRIPTION_END",
      textLengthUnit: "CHAR",
      requiredFields: ["title", "description"],
    },
    style: {
      captionStyle: "INFORMATIVE",
      promptGuidance:
        "タイトルは検索キーワードを含めて内容を正確に表す。説明文は要点・目次・関連情報を整理して書く。",
      hookEmphasis: "MEDIUM",
      hookMaxSec: 5,
      preferredHookTemplates: ["problem_fact_conclusion", "conclusion_first", "before_after"],
      subtitleStyle: "CLEAN_BOTTOM",
      ctaGuidance: "チャンネル登録・高評価・コメントを促す",
    },
    features: { chapters: true, customThumbnail: true, scheduling: true },
  },
  createAdapter: (config) => new ChaptersAdapter(config),
};
