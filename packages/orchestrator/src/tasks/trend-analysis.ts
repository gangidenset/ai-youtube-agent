import { EXTERNAL_DATA_POLICY, type LlmTask, wrapExternalData } from "@aya/providers";
import { z } from "zod";

export const TREND_ANALYSIS_PROMPT_VERSION = "trend-analysis@v1";

const Level = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const TrendTopicSchema = z.object({
  topic: z.string().min(1).max(80),
  trend_type: z.enum(["RISING", "SURGING", "EVERGREEN", "SHORT_LIVED"]),
  /** 根拠にした動画（入力データの id のみ） */
  evidence_video_ids: z.array(z.string()).min(1).max(30),
  audience_needs: z.array(z.string()).max(6),
  title_patterns: z.array(z.string()).max(6),
  hook_patterns: z.array(z.string()).max(6),
  structure_patterns: z.array(z.string()).max(6),
  /** 既存動画との差別化の方向（コピーではなく「なぜ伸びているか」から別の切り口を作るため） */
  differentiation: z.array(z.string()).max(6),
  competition_level: Level,
  /** 0〜1。目新しさ */
  novelty: z.number().min(0).max(1),
  /** 0〜1。視聴者の需要（コメント傾向・検索意図から） */
  demand: z.number().min(0).max(1),
  risks: z.array(z.string()).max(6),
  /** 判断が難しい点・データの限界 */
  uncertainty_note: z.string().max(400),
});
export type TrendTopic = z.infer<typeof TrendTopicSchema>;

export const TrendAnalysisSchema = z.object({
  topics: z.array(TrendTopicSchema).min(1).max(8),
  market_summary: z.string().max(1000),
});
export type TrendAnalysis = z.infer<typeof TrendAnalysisSchema>;

/** 役割とルール（変わらないのでプロンプトキャッシュの対象） */
export const TREND_ANALYSIS_SYSTEM = `あなたは YouTube Shorts を中心とした短尺動画の市場アナリストです。
与えられた市場データ（直近に公開された動画の統計）から、伸びているテーマを分析します。

ルール:
- 「何が伸びているか」だけでなく「なぜ伸びているか」（フック・構成・視聴者ニーズ）を抽出してください。
- 他人の動画のタイトルや構成をそのまま真似る提案はしないでください。差別化の方向を示してください。
- 「必ずバズる」「確実に伸びる」のような断定はしないでください。可能性・傾向として述べ、データの限界は uncertainty_note に書いてください。
- evidence_video_ids には入力データにある id だけを使ってください。根拠が乏しいテーマは無理に挙げないでください。
- novelty と demand は 0〜1 で、根拠となるデータから判断してください。
- 実在の人物・企業に関する誤解を招く内容、誤情報につながる内容はリスクとして挙げてください。
- 出力は日本語で、指定の JSON Schema に従ってください。

${EXTERNAL_DATA_POLICY}`;

export interface TrendAnalysisVideo {
  id: string;
  title: string;
  channel: string | null;
  tags: string[];
  viewCount: number;
  viewsPerHour: number;
  viewsPerSubscriber: number | null;
  likeRate: number | null;
  commentRate: number | null;
  ageHours: number;
  durationSec: number | null;
}

export interface TrendAnalysisRequest {
  channel: {
    genre: string | null;
    subGenres: string[];
    targetAudience: string | null;
    tone: string | null;
    ngWords: string[];
  };
  keywords: string[];
  region: string;
  lookbackDays: number;
  videos: TrendAnalysisVideo[];
  /** 断定表現などで再要求するときの注意 */
  correction?: string;
}

const round = (n: number | null, d = 4) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function buildTrendAnalysisTask(req: TrendAnalysisRequest): LlmTask<TrendAnalysis> {
  const channel = [
    "# チャンネル設定",
    `- ジャンル: ${req.channel.genre ?? "未設定"}${req.channel.subGenres.length ? `（${req.channel.subGenres.join("、")}）` : ""}`,
    `- ターゲット: ${req.channel.targetAudience ?? "未設定"}`,
    `- トーン: ${req.channel.tone ?? "未設定"}`,
    `- NG ワード: ${req.channel.ngWords.length ? req.channel.ngWords.join("、") : "なし"}`,
  ].join("\n");

  const data = req.videos.map((v) => ({
    id: v.id,
    title: v.title,
    channel: v.channel,
    tags: v.tags.slice(0, 10),
    views: v.viewCount,
    views_per_hour: Math.round(v.viewsPerHour),
    views_per_subscriber: round(v.viewsPerSubscriber, 2),
    like_rate: round(v.likeRate),
    comment_rate: round(v.commentRate),
    age_hours: Math.round(v.ageHours),
    duration_sec: v.durationSec,
  }));

  const prompt = [
    `市場: ${req.region} / 期間: 直近 ${req.lookbackDays} 日 / 検索キーワード: ${req.keywords.join("、")}`,
    `動画数: ${req.videos.length}（再生速度の高い順）`,
    "",
    "以下の市場データから、チャンネルに合う伸びているテーマを 3〜8 個挙げて分析してください。",
    wrapExternalData("youtube", data),
    ...(req.correction ? ["", req.correction] : []),
  ].join("\n");

  return {
    operation: "trend_analysis",
    schema: TrendAnalysisSchema,
    system: [
      { text: TREND_ANALYSIS_SYSTEM, cache: true },
      { text: channel, cache: true },
    ],
    prompt,
    effort: "high",
    maxTokens: 16_000,
  };
}

/** Claude の出力に含まれる文章（断定表現のチェック用） */
export function trendAnalysisTexts(result: TrendAnalysis): string[] {
  return [
    result.market_summary,
    ...result.topics.flatMap((t) => [
      t.topic,
      t.uncertainty_note,
      ...t.audience_needs,
      ...t.title_patterns,
      ...t.hook_patterns,
      ...t.structure_patterns,
      ...t.differentiation,
      ...t.risks,
    ]),
  ];
}
