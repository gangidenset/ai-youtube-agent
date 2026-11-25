/**
 * Trend Score / Originality Score（docs/ai-orchestrator.md）。
 * 数値はできるだけ収集データから決定論的に計算し、Claude の定性評価（新規性・需要・類似度）は 0〜1 で受け取って合成する。
 * 「必ずバズる」といった断定はしない。スコアには必ず根拠（内訳）と不確実性を付ける。
 */

// ---------------------------------------------------------------- 共通

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** 母集団の中での位置（0〜1）。同じ値は中央の順位として扱う。 */
export function percentileRank(value: number, population: readonly number[]): number {
  if (population.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const p of population) {
    if (p < value) below++;
    else if (p === value) equal++;
  }
  return (below + equal / 2) / population.length;
}

// ---------------------------------------------------------------- Trend Score

/** 重み（合計 100）。チャンネル設定で調整できるようにし、Phase 4 で実績から補正する */
export const DEFAULT_TREND_WEIGHTS = {
  velocity: 25,
  sizeRatio: 15,
  likeRate: 10,
  commentRate: 10,
  growth: 15,
  competition: 10,
  novelty: 5,
  demand: 5,
  ownFit: 5,
} as const;
export type TrendComponent = keyof typeof DEFAULT_TREND_WEIGHTS;
export type TrendWeights = Record<TrendComponent, number>;

export interface MarketVideoSample {
  viewsPerHour: number;
  viewsPerSubscriber: number | null;
  likeRate: number | null;
  commentRate: number | null;
  ageHours: number;
  viewCount: number;
  channelSubscribers: number | null;
}

export interface TrendScoreInput {
  /** テーマの根拠になった動画 */
  evidence: readonly MarketVideoSample[];
  /** その市場分析で集めた全動画（比較の母集団） */
  population: readonly MarketVideoSample[];
  lookbackHours: number;
  /** Claude の評価（0〜1） */
  novelty: number;
  demand: number;
  /** 自チャンネルの類似テーマの実績（0〜1）。Phase 4 までは不明なので null（中立 0.5 として扱う） */
  ownFit?: number | null;
  weights?: TrendWeights;
}

export type UncertaintyLevel = "LOW" | "MEDIUM" | "HIGH";

export interface TrendScoreResult {
  /** 0〜100 */
  score: number;
  /** 要素ごとの点数（重み × 0〜1） */
  breakdown: Record<TrendComponent, number>;
  /** 要素ごとの 0〜1 の値（説明用） */
  components: Record<TrendComponent, number>;
  uncertainty: { level: UncertaintyLevel; reasons: string[] };
}

/** チャンネル規模が大きいとみなす登録者数（競合の強さの目安） */
export const LARGE_CHANNEL_SUBSCRIBERS = 100_000;
const NEUTRAL = 0.5;

function rankOfMedian(
  evidence: readonly MarketVideoSample[],
  population: readonly MarketVideoSample[],
  pick: (v: MarketVideoSample) => number | null,
): number | null {
  const values = evidence.map(pick).filter((v): v is number => v !== null);
  const m = median(values);
  if (m === null) return null;
  return percentileRank(
    m,
    population.map(pick).filter((v): v is number => v !== null),
  );
}

export function computeTrendScore(input: TrendScoreInput): TrendScoreResult {
  const weights = input.weights ?? DEFAULT_TREND_WEIGHTS;
  const { evidence, population } = input;
  const reasons: string[] = [];

  const velocity = rankOfMedian(evidence, population, (v) => v.viewsPerHour);
  const sizeRatio = rankOfMedian(evidence, population, (v) => v.viewsPerSubscriber);
  const likeRate = rankOfMedian(evidence, population, (v) => v.likeRate);
  const commentRate = rankOfMedian(evidence, population, (v) => v.commentRate);
  if (sizeRatio === null) reasons.push("登録者数が非公開の動画が多く、チャンネル規模比を評価できません");
  if (likeRate === null || commentRate === null)
    reasons.push("高評価数・コメント数が非公開の動画が多く、反応率の評価が不十分です");

  // 成長: 期間の後半（新しい側）に公開された動画が再生の何割を占めるか
  const totalViews = evidence.reduce((s, v) => s + v.viewCount, 0);
  const recentViews = evidence
    .filter((v) => v.ageHours <= input.lookbackHours / 2)
    .reduce((s, v) => s + v.viewCount, 0);
  const growth = totalViews > 0 ? recentViews / totalViews : NEUTRAL;

  // 競合: テーマが市場に占める割合と、大手チャンネルの割合が高いほど競合が多い
  const share = population.length > 0 ? evidence.length / population.length : 0;
  const withSubs = evidence.filter((v) => v.channelSubscribers !== null);
  const largeShare =
    withSubs.length > 0
      ? withSubs.filter((v) => (v.channelSubscribers ?? 0) >= LARGE_CHANNEL_SUBSCRIBERS).length /
        withSubs.length
      : NEUTRAL;
  const density = clamp01(0.5 * Math.min(1, share / 0.3) + 0.5 * largeShare);
  const competition = 1 - density;

  const ownFit = input.ownFit ?? null;
  if (ownFit === null) reasons.push("自チャンネルの実績データがまだ無いため、適合度は中立値で計算しています");

  const components: Record<TrendComponent, number> = {
    velocity: velocity ?? NEUTRAL,
    sizeRatio: sizeRatio ?? NEUTRAL,
    likeRate: likeRate ?? NEUTRAL,
    commentRate: commentRate ?? NEUTRAL,
    growth: clamp01(growth),
    competition,
    novelty: clamp01(input.novelty),
    demand: clamp01(input.demand),
    ownFit: ownFit === null ? NEUTRAL : clamp01(ownFit),
  };

  const breakdown = Object.fromEntries(
    (Object.keys(components) as TrendComponent[]).map((k) => [k, round1(components[k] * weights[k])]),
  ) as Record<TrendComponent, number>;
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  const raw = (Object.keys(components) as TrendComponent[]).reduce(
    (s, k) => s + components[k] * weights[k],
    0,
  );
  const score = round1((raw / totalWeight) * 100);

  let level: UncertaintyLevel = evidence.length >= 8 ? "LOW" : evidence.length >= 3 ? "MEDIUM" : "HIGH";
  if (evidence.length < 8)
    reasons.unshift(`根拠の動画が ${evidence.length} 本と少ないため、偶然の影響を受けやすい状態です`);
  if (evidence.length > 0 && evidence.every((v) => v.ageHours < 48)) {
    reasons.push("根拠の動画がすべて公開から 48 時間未満で、伸びが続くかは判断できません");
    if (level === "LOW") level = "MEDIUM";
  }
  if (reasons.length >= 3 && level === "LOW") level = "MEDIUM";

  return { score, breakdown, components, uncertainty: { level, reasons } };
}

// ---------------------------------------------------------------- Originality Score

/** 比較のために、空白・記号を除き、英字を小文字にする */
export function normalizeForSimilarity(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 文字 n-gram の Jaccard 係数（0〜1）。日本語でも分かち書きなしで使える。 */
export function ngramJaccard(a: string, b: string, n = 2): number {
  const grams = (s: string) => {
    const chars = [...normalizeForSimilarity(s)];
    const set = new Set<string>();
    if (chars.length > 0 && chars.length < n) set.add(chars.join(""));
    for (let i = 0; i + n <= chars.length; i++) set.add(chars.slice(i, i + n).join(""));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 && gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

export interface SimilarityComparison {
  /** 比較した既存動画の ID */
  videoId: string;
  /** タイトル・フックの文字 n-gram 類似度（コードで計算） */
  textSimilarity: number;
  /** 構成・主張・ストーリーの類似度（Claude の評価 0〜1） */
  semanticSimilarity: number;
}

export interface OriginalityResult {
  /** 0〜100 */
  score: number;
  /** 最も似ている既存動画 */
  closest: (SimilarityComparison & { combined: number }) | null;
  copyRisk: UncertaintyLevel;
}

export const TEXT_SIMILARITY_WEIGHT = 0.4;
export const SEMANTIC_SIMILARITY_WEIGHT = 0.6;
/** 差別化要素 1 つあたりの加点と上限 */
export const DIFFERENTIATION_BONUS = 2;
export const DIFFERENTIATION_BONUS_MAX = 10;
/** これ未満の企画は提示しない（docs/ai-orchestrator.md） */
export const MIN_ORIGINALITY_SCORE = 60;

/**
 * Originality = 100 × (1 − 最も似ている動画との類似度) + 差別化の加点。
 * 類似度 = 0.4 × 文字の類似度 + 0.6 × 内容の類似度（Claude）。
 */
export function computeOriginalityScore(
  comparisons: readonly SimilarityComparison[],
  differentiationCount: number,
): OriginalityResult {
  const scored = comparisons.map((c) => ({
    ...c,
    combined:
      TEXT_SIMILARITY_WEIGHT * clamp01(c.textSimilarity) +
      SEMANTIC_SIMILARITY_WEIGHT * clamp01(c.semanticSimilarity),
  }));
  const closest = scored.reduce<(typeof scored)[number] | null>(
    (best, c) => (best === null || c.combined > best.combined ? c : best),
    null,
  );
  const maxSimilarity = closest?.combined ?? 0;
  const bonus = Math.min(
    DIFFERENTIATION_BONUS_MAX,
    Math.max(0, differentiationCount) * DIFFERENTIATION_BONUS,
  );
  const score = round1(Math.min(100, 100 * (1 - maxSimilarity) + bonus));
  const copyRisk: UncertaintyLevel = maxSimilarity >= 0.7 ? "HIGH" : maxSimilarity >= 0.45 ? "MEDIUM" : "LOW";
  return { score, closest, copyRisk };
}

// ---------------------------------------------------------------- 断定表現のチェック

/** 予測を保証するような表現（指示書 §14・§43: 「必ずバズる」と断定しない） */
const OVERCLAIM_PATTERNS: readonly RegExp[] = [
  /(必ず|絶対(に)?|確実に|100\s*[%％]|間違いなく)\s*(バズ|伸び|ヒット|稼げ|儲か|成功|再生され)/u,
  /(バズ|ヒット|成功|収益)(は|が)?\s*(保証|確定)/u,
  /(guaranteed?|definitely|certainly)\s+(to\s+)?(go\s+viral|viral|succeed|hit)/iu,
];

/** 断定表現が含まれる箇所を返す（無ければ空配列） */
export function findOverclaims(texts: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const pattern of OVERCLAIM_PATTERNS) {
      const m = pattern.exec(text);
      if (m) found.push(m[0]);
    }
  }
  return found;
}
