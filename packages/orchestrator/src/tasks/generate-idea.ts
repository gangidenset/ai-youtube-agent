import { EXTERNAL_DATA_POLICY, type LlmTask, wrapExternalData } from "@aya/providers";
import { z } from "zod";

export const GENERATE_IDEA_PROMPT_VERSION = "generate-idea@v1";
export const IDEA_LABELS = ["A", "B", "C"] as const;

const Level = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const IdeaSchema = z.object({
  label: z.enum(IDEA_LABELS),
  /** 元にしたトレンド（入力の trend_id） */
  trend_id: z.string(),
  title: z.string().min(1).max(100),
  theme: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  hook: z.string().min(1).max(200),
  story: z.string().min(1).max(1000),
  duration_sec: z.number().int().min(10).max(180),
  scene_count: z.number().int().min(2).max(20),
  cta: z.string().min(1).max(200),
  /** 伸びている動画の共通点（なぜ伸びているか） */
  common_patterns: z.array(z.string()).max(6),
  /** 共通点を生かした、この企画ならではの切り口 */
  original_angle: z.string().min(1).max(400),
  differentiation: z.array(z.string()).max(6),
  /** 内容（構成・主張・ストーリー）が似ている既存動画と、その類似度 0〜1 */
  similar_videos: z
    .array(
      z.object({ video_id: z.string(), similarity: z.number().min(0).max(1), note: z.string().max(200) }),
    )
    .max(10),
  policy_risk: Level,
  risks: z.array(z.string()).max(6),
});
export type Idea = z.infer<typeof IdeaSchema>;

export const IdeaSetSchema = z.object({
  ideas: z.array(IdeaSchema).length(3),
});
export type IdeaSet = z.infer<typeof IdeaSetSchema>;

export const GENERATE_IDEA_SYSTEM = `あなたは YouTube Shorts などの短尺動画の企画者です。
市場分析で見つかったトレンドから、チャンネルに合うオリジナルの動画企画を 3 案（A / B / C）作ります。

ルール:
- 伸びている動画の共通点（なぜ伸びているか）を common_patterns に抽出し、それを生かした別の切り口（original_angle）で企画してください。
- 他人の動画のタイトル・構成・ストーリーをそのまま使わないでください。差別化のポイントを differentiation に挙げてください。
- similar_videos には、入力データの中で内容（構成・主張・ストーリー）が似ている動画と、その類似度（0〜1。1 = ほぼ同じ）を正直に書いてください。似ている動画が無ければ空にしてください。
- 3 案は互いに切り口が重ならないようにしてください。過去の企画と同じ内容も避けてください。
- 「必ずバズる」「確実に稼げる」のような断定、誇大な表現、誤情報、実在の人物・企業についての誤解を招く内容は使わないでください。
- YouTube のポリシー（誤解を招く内容・危険な行為・著作権）に触れる可能性があれば policy_risk と risks に書いてください。
- 尺は指定の目安に合わせてください。出力は日本語で、指定の JSON Schema に従ってください。

${EXTERNAL_DATA_POLICY}`;

export interface IdeaTrendInput {
  id: string;
  topic: string;
  trendScore: number;
  audienceNeeds: unknown;
  titlePatterns: unknown;
  hookPatterns: unknown;
  structurePatterns: unknown;
  differentiation: unknown;
  /** 根拠の動画（外部データ） */
  evidence: { id: string; title: string; viewsPerHour: number }[];
}

export interface GenerateIdeaRequest {
  channel: {
    genre: string | null;
    targetAudience: string | null;
    tone: string | null;
    ngWords: string[];
    defaultDurationSec: number;
    brandGuidelines: string | null;
  };
  trends: IdeaTrendInput[];
  /** 最近の企画のタイトル（重複を避けるため） */
  recentIdeaTitles: string[];
  correction?: string;
}

export function buildGenerateIdeaTask(req: GenerateIdeaRequest): LlmTask<IdeaSet> {
  const channel = [
    "# チャンネル設定",
    `- ジャンル: ${req.channel.genre ?? "未設定"}`,
    `- ターゲット: ${req.channel.targetAudience ?? "未設定"}`,
    `- トーン: ${req.channel.tone ?? "未設定"}`,
    `- NG ワード: ${req.channel.ngWords.length ? req.channel.ngWords.join("、") : "なし"}`,
    `- 尺の目安: ${req.channel.defaultDurationSec} 秒`,
    ...(req.channel.brandGuidelines ? [`- ブランドの方針: ${req.channel.brandGuidelines}`] : []),
  ].join("\n");

  const trends = req.trends.map((t) => ({
    trend_id: t.id,
    topic: t.topic,
    trend_score: t.trendScore,
    audience_needs: t.audienceNeeds,
    title_patterns: t.titlePatterns,
    hook_patterns: t.hookPatterns,
    structure_patterns: t.structurePatterns,
    differentiation: t.differentiation,
  }));
  // 他人の動画のタイトルは外部データとして隔離する
  const evidence = req.trends.flatMap((t) =>
    t.evidence.map((v) => ({
      trend_id: t.id,
      id: v.id,
      title: v.title,
      views_per_hour: Math.round(v.viewsPerHour),
    })),
  );

  const prompt = [
    "# トレンド分析の結果（Trend Score の高い順）",
    JSON.stringify(trends, null, 2),
    "",
    "# 各トレンドの根拠になった動画",
    wrapExternalData("youtube", evidence),
    "",
    "# 最近の企画（重複を避ける）",
    req.recentIdeaTitles.length ? req.recentIdeaTitles.map((t) => `- ${t}`).join("\n") : "なし",
    "",
    "上のトレンドから企画を 3 案作ってください。trend_id は上の一覧から選んでください。",
    ...(req.correction ? ["", req.correction] : []),
  ].join("\n");

  return {
    operation: "generate_idea",
    schema: IdeaSetSchema,
    system: [
      { text: GENERATE_IDEA_SYSTEM, cache: true },
      { text: channel, cache: true },
    ],
    prompt,
    effort: "high",
    maxTokens: 16_000,
  };
}

/** 断定表現のチェック対象 */
export function ideaTexts(set: IdeaSet): string[] {
  return set.ideas.flatMap((i) => [
    i.title,
    i.theme,
    i.target,
    i.hook,
    i.story,
    i.cta,
    i.original_angle,
    ...i.common_patterns,
    ...i.differentiation,
    ...i.risks,
  ]);
}
