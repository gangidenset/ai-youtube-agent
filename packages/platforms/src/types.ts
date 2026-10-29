import { z } from "zod";

/**
 * SNS 最適化レイヤーの型定義。
 * SNS ごとの仕様はすべて PlatformTargetConfig（データ）で表し、コード内で SNS 名による分岐はしない。
 * 詳細: docs/multi-platform.md
 */

const idPattern = /^[a-z][a-z0-9_]*$/;

export const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** 同じマスターを共有できるコンテンツの系統。 */
export const ContentFamilySchema = z.enum(["SHORT_VERTICAL", "LONG_HORIZONTAL", "FEED"]);
export type ContentFamily = z.infer<typeof ContentFamilySchema>;

export const MetadataFieldSchema = z.enum(["title", "caption", "description", "hashtags", "cta"]);
export type MetadataField = z.infer<typeof MetadataFieldSchema>;

const rangeSchema = z
  .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
  .refine((r) => r.min <= r.max, { message: "min must be <= max" });

const ratioValue: Record<AspectRatio, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };

export function aspectRatioValue(ratio: AspectRatio): number {
  return ratioValue[ratio];
}

export const VideoSpecSchema = z
  .object({
    aspectRatio: AspectRatioSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    maxDurationSec: z.number().positive(),
    recommendedDurationSec: rangeSchema,
    maxFileSizeMb: z.number().positive(),
    loudnessLufs: z.number().max(0),
    /** SNS の UI に隠れる領域（画面に対する比率）。字幕・テロップはこの内側に置く。 */
    safeArea: z.object({
      top: z.number().min(0).max(0.5),
      bottom: z.number().min(0).max(0.5),
      left: z.number().min(0).max(0.5),
      right: z.number().min(0).max(0.5),
    }),
  })
  .refine((v) => Math.abs(v.width / v.height - ratioValue[v.aspectRatio]) < 0.01, {
    message: "width/height does not match aspectRatio",
  })
  .refine((v) => v.recommendedDurationSec.max <= v.maxDurationSec, {
    message: "recommendedDurationSec.max must be <= maxDurationSec",
  });

export const TextSpecSchema = z
  .object({
    titleLimit: z.number().int().positive().nullable(),
    captionLimit: z.number().int().positive().nullable(),
    descriptionLimit: z.number().int().positive().nullable(),
    hashtagLimit: z.number().int().nonnegative(),
    /** 常に付けるハッシュタグ（生成分より前に置き、hashtagLimit に含める）。 */
    fixedHashtags: z.array(z.string()).default([]),
    recommendedHashtags: rangeSchema,
    /** ハッシュタグをどこに付けるか。 */
    hashtagPlacement: z.enum(["CAPTION_END", "DESCRIPTION_END", "SEPARATE_FIELD"]),
    /** 文字数の数え方。WEIGHTED は全角などを 2 として数える（X 方式）。 */
    textLengthUnit: z.enum(["CHAR", "WEIGHTED"]),
    requiredFields: z.array(MetadataFieldSchema).min(1),
  })
  .refine((t) => t.recommendedHashtags.max <= t.hashtagLimit, {
    message: "recommendedHashtags.max must be <= hashtagLimit",
  })
  .refine((t) => t.fixedHashtags.length <= t.hashtagLimit, {
    message: "fixedHashtags must fit within hashtagLimit",
  });

export const StyleSpecSchema = z.object({
  captionStyle: z.enum(["CASUAL", "FRIENDLY", "INFORMATIVE", "CONCISE"]),
  /** Claude に渡す SNS 別の作法（自然文）。 */
  promptGuidance: z.string().min(1),
  hookEmphasis: z.enum(["HIGH", "MEDIUM", "LOW"]),
  /** 冒頭フックに使える秒数。 */
  hookMaxSec: z.number().positive(),
  preferredHookTemplates: z.array(z.string()).min(1),
  subtitleStyle: z.enum(["BOLD_CENTER", "CLEAN_BOTTOM", "MINIMAL"]),
  ctaGuidance: z.string().min(1),
});

export const FeatureSpecSchema = z.object({
  chapters: z.boolean(),
  customThumbnail: z.boolean(),
  scheduling: z.boolean(),
});

export const PlatformTargetConfigSchema = z.object({
  /** 出力先の安定キー（例: youtube_shorts）。 */
  id: z.string().regex(idPattern),
  /** SNS（例: youtube）。1 つの SNS が複数の出力先を持てる。 */
  platform: z.string().regex(idPattern),
  displayName: z.string().min(1),
  contentFamily: ContentFamilySchema,
  /** 仕様を更新したら変える。レンダーキャッシュのキーにも含まれる。 */
  specVersion: z.string().min(1),
  /** 公式ドキュメントで仕様値を確認済みか。 */
  verified: z.boolean(),
  video: VideoSpecSchema,
  text: TextSpecSchema,
  style: StyleSpecSchema,
  features: FeatureSpecSchema,
});
export type PlatformTargetConfig = z.infer<typeof PlatformTargetConfigSchema>;
/** 定義ファイルで書く形（既定値のある項目は省略可）。 */
export type PlatformTargetConfigInput = z.input<typeof PlatformTargetConfigSchema>;

export const HookSchema = z.object({
  templateId: z.string().min(1),
  narration: z.string(),
  overlayText: z.string(),
});

export const ChapterSchema = z.object({
  startSec: z.number().nonnegative(),
  title: z.string().min(1),
});
export type Chapter = z.infer<typeof ChapterSchema>;

/** Claude が Target ごとに生成するテキスト類。 */
export const TargetMetadataSchema = z.object({
  targetId: z.string().regex(idPattern),
  title: z.string().optional(),
  caption: z.string().optional(),
  description: z.string().optional(),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().optional(),
  hook: HookSchema.optional(),
  chapters: z.array(ChapterSchema).optional(),
});
export type TargetMetadata = z.infer<typeof TargetMetadataSchema>;

export type ValidationIssueCode =
  "MISSING" | "TOO_LONG" | "TOO_MANY_HASHTAGS" | "NOT_SUPPORTED" | "INVALID_CHAPTERS";

export interface ValidationIssue {
  field: MetadataField | "chapters" | "postText";
  code: ValidationIssueCode;
  message: string;
  limit?: number;
  actual?: number;
}

export type ScenePriority = "CORE" | "OPTIONAL";

/** マスター動画の情報（Target 別レンダリングの入力）。 */
export interface MasterRenderInfo {
  width: number;
  height: number;
  scenes: { sceneNumber: number; durationSec: number; priority: ScenePriority }[];
}

export type ReframeMode = "NONE" | "SCALE" | "CENTER_CROP" | "BLUR_PAD";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** FFmpeg レンダラへの指示（AI 呼び出しを伴わない後処理だけで作る）。 */
export interface RenderSpec {
  targetId: string;
  specVersion: string;
  output: { width: number; height: number; fps: number; loudnessLufs: number; maxFileSizeMb: number };
  reframe: { mode: ReframeMode; crop?: CropRect };
  includedScenes: number[];
  durationSec: number;
  subtitle: {
    style: PlatformTargetConfig["style"]["subtitleStyle"];
    safeArea: PlatformTargetConfig["video"]["safeArea"];
  };
  hookMaxSec: number;
  warnings: RenderWarning[];
}

export type RenderWarning =
  | { code: "OPTIONAL_SCENES_DROPPED"; scenes: number[] }
  | { code: "TRUNCATED"; fromSec: number; toSec: number }
  | { code: "OUTSIDE_RECOMMENDED_DURATION"; durationSec: number; min: number; max: number };

export interface PostText {
  title?: string;
  body: string;
}

export interface PlatformAdapter {
  readonly config: PlatformTargetConfig;
  normalizeMetadata(metadata: TargetMetadata): TargetMetadata;
  validateMetadata(metadata: TargetMetadata): ValidationIssue[];
  formatPostText(metadata: TargetMetadata): PostText;
  buildRenderSpec(master: MasterRenderInfo): RenderSpec;
  buildMetadataPromptHints(): string;
}

export type AdapterFactory = (config: PlatformTargetConfig) => PlatformAdapter;

/** Target の登録単位。新しい SNS はこれを 1 つ追加するだけで対応できる。 */
export interface PlatformTargetDefinition {
  config: PlatformTargetConfigInput;
  /** 省略時は DefaultPlatformAdapter を使う。 */
  createAdapter?: AdapterFactory;
}
