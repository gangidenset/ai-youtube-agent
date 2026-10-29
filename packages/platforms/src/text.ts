import type { PlatformTargetConfig } from "./types";

type LengthUnit = PlatformTargetConfig["text"]["textLengthUnit"];

const URL_PATTERN = /https?:\/\/\S+/g;
/** URL は短縮後の長さとして数える（X 方式）。 */
const URL_WEIGHT = 23;

/** 1 として数える文字範囲（X の weighted length に準拠。その他は 2）。 */
const SINGLE_WEIGHT_RANGES: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

function codePointWeight(cp: number): number {
  return SINGLE_WEIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
}

/** 文字数を数える。CHAR はコードポイント数、WEIGHTED は全角等を 2・URL を 23 として数える。 */
export function countLength(text: string, unit: LengthUnit): number {
  if (unit === "CHAR") return [...text].length;
  let total = 0;
  const withoutUrls = text.replace(URL_PATTERN, () => {
    total += URL_WEIGHT;
    return "";
  });
  for (const ch of withoutUrls) total += codePointWeight(ch.codePointAt(0) ?? 0);
  return total;
}

// ハッシュタグに使えない文字（空白・記号）。日本語・英数字・アンダースコアは残す。
const HASHTAG_INVALID = /[\s#!-/:-@[-^`{-~、。・「」『』（）！？]+/gu;

/** "#AI 副業" → "#AI副業"。使える文字が残らなければ null。 */
export function normalizeHashtag(tag: string): string | null {
  const body = tag.replace(HASHTAG_INVALID, "");
  return body.length > 0 ? `#${body}` : null;
}

/** 正規化・重複除去（大文字小文字を区別しない）したうえで limit 件までに絞る。 */
export function normalizeHashtags(tags: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = normalizeHashtag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result.slice(0, limit);
}
