import { planRender } from "../render-spec";
import { countLength, normalizeHashtags } from "../text";
import type {
  MasterRenderInfo,
  MetadataField,
  PlatformAdapter,
  PlatformTargetConfig,
  PostText,
  RenderSpec,
  TargetMetadata,
  ValidationIssue,
} from "../types";

const captionStyleLabel: Record<PlatformTargetConfig["style"]["captionStyle"], string> = {
  CASUAL: "くだけた口語",
  FRIENDLY: "親しみやすい丁寧語",
  INFORMATIVE: "情報が整理された説明調",
  CONCISE: "短く簡潔",
};

type TextField = "title" | "caption" | "description";

/**
 * 設定（PlatformTargetConfig）だけで動く共通 Adapter。
 * SNS 固有の処理が必要な場合だけ、このクラスを継承して差分を上書きする。
 */
export class DefaultPlatformAdapter implements PlatformAdapter {
  constructor(readonly config: PlatformTargetConfig) {}

  protected length(text: string): number {
    return countLength(text, this.config.text.textLengthUnit);
  }

  normalizeMetadata(metadata: TargetMetadata): TargetMetadata {
    const trim = (s?: string) => (s === undefined ? undefined : s.trim());
    return {
      ...metadata,
      title: trim(metadata.title),
      caption: trim(metadata.caption),
      description: trim(metadata.description),
      cta: trim(metadata.cta),
      hashtags: normalizeHashtags(
        [...this.config.text.fixedHashtags, ...metadata.hashtags],
        this.config.text.hashtagLimit,
      ),
    };
  }

  validateMetadata(metadata: TargetMetadata): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { text, features } = this.config;

    for (const field of text.requiredFields) {
      if (isEmpty(metadata, field)) {
        issues.push({ field, code: "MISSING", message: `${this.config.displayName}: ${field} は必須です` });
      }
    }

    const limits: Record<TextField, number | null> = {
      title: text.titleLimit,
      caption: text.captionLimit,
      description: text.descriptionLimit,
    };
    for (const field of Object.keys(limits) as TextField[]) {
      const value = metadata[field];
      if (!value) continue;
      const limit = limits[field];
      if (limit === null) {
        issues.push({
          field,
          code: "NOT_SUPPORTED",
          message: `${this.config.displayName} は ${field} を使いません`,
        });
        continue;
      }
      const actual = this.length(value);
      if (actual > limit) {
        issues.push({ field, code: "TOO_LONG", message: `${field} が上限を超えています`, limit, actual });
      }
    }

    if (metadata.hashtags.length > text.hashtagLimit) {
      issues.push({
        field: "hashtags",
        code: "TOO_MANY_HASHTAGS",
        message: "ハッシュタグが多すぎます",
        limit: text.hashtagLimit,
        actual: metadata.hashtags.length,
      });
    }

    // ハッシュタグを本文に付ける SNS は、付けた後の全体長も上限内に収める
    const postLimit = this.postTextLimit();
    if (postLimit !== null && !issues.some((i) => i.code === "TOO_LONG")) {
      const actual = this.length(this.formatPostText(metadata).body);
      if (actual > postLimit) {
        issues.push({
          field: "postText",
          code: "TOO_LONG",
          message: "投稿文（ハッシュタグ込み）が上限を超えています",
          limit: postLimit,
          actual,
        });
      }
    }

    if (metadata.chapters && metadata.chapters.length > 0 && !features.chapters) {
      issues.push({
        field: "chapters",
        code: "NOT_SUPPORTED",
        message: `${this.config.displayName} はチャプターに対応していません`,
      });
    }

    return issues;
  }

  formatPostText(metadata: TargetMetadata): PostText {
    const { hashtagPlacement } = this.config.text;
    const tags = metadata.hashtags.join(" ");
    const join = (...parts: (string | undefined)[]) => parts.filter((p) => p && p.length > 0).join("\n\n");

    const mainText = hashtagPlacement === "DESCRIPTION_END" ? metadata.description : metadata.caption;
    const body = hashtagPlacement === "SEPARATE_FIELD" ? join(mainText) : join(mainText, tags);
    return metadata.title ? { title: metadata.title, body } : { body };
  }

  buildRenderSpec(master: MasterRenderInfo): RenderSpec {
    return planRender(this.config, master);
  }

  /** Claude へのメタデータ生成指示（設定から組み立てるので SNS ごとのプロンプト分岐は不要）。 */
  buildMetadataPromptHints(): string {
    const { id, displayName, text, style, video } = this.config;
    const unit = text.textLengthUnit === "WEIGHTED" ? "（全角は2文字として数える）" : "";
    const limit = (label: string, n: number | null) =>
      n === null ? `${label}: 使わない` : `${label}: ${n}文字以内${unit}`;
    return [
      `## ${displayName}（target_id: ${id}）`,
      `- 必須項目: ${text.requiredFields.join(", ")}`,
      `- ${limit("タイトル", text.titleLimit)}`,
      `- ${limit("投稿文/キャプション", text.captionLimit)}`,
      `- ${limit("説明文", text.descriptionLimit)}`,
      `- ハッシュタグ: ${text.recommendedHashtags.min}〜${text.recommendedHashtags.max}個（上限${text.hashtagLimit}個）`,
      `- 文体: ${captionStyleLabel[style.captionStyle]}`,
      `- 冒頭フック: 最初の${style.hookMaxSec}秒で引き込む。推奨テンプレート: ${style.preferredHookTemplates.join(", ")}`,
      `- CTA: ${style.ctaGuidance}`,
      `- 推奨尺: ${video.recommendedDurationSec.min}〜${video.recommendedDurationSec.max}秒`,
      `- 作法: ${style.promptGuidance}`,
    ].join("\n");
  }

  protected postTextLimit(): number | null {
    const { hashtagPlacement, captionLimit, descriptionLimit } = this.config.text;
    if (hashtagPlacement === "CAPTION_END") return captionLimit;
    if (hashtagPlacement === "DESCRIPTION_END") return descriptionLimit;
    return null;
  }
}

function isEmpty(metadata: TargetMetadata, field: MetadataField): boolean {
  if (field === "hashtags") return metadata.hashtags.length === 0;
  const value = metadata[field];
  return value === undefined || value.trim().length === 0;
}
