import { createHash } from "node:crypto";

export interface RenderCacheInput {
  /** マスター素材（シーン動画・ナレーション・BGM 等）の sha256。 */
  masterAssetHashes: readonly string[];
  targetId: string;
  specVersion: string;
  /** フックのテロップ・字幕・CTA など、Target 別の後処理パラメータ。 */
  overlay: unknown;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Target 別レンダリングのキャッシュキー。
 * 入力が同じなら同じキーになり、再レンダリングを省略できる。
 */
export function renderCacheKey(input: RenderCacheInput): string {
  const payload = stableStringify({
    v: 1,
    assets: input.masterAssetHashes,
    target: input.targetId,
    spec: input.specVersion,
    overlay: input.overlay,
  });
  return createHash("sha256").update(payload).digest("hex");
}
