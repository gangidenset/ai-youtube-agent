import { EXTERNAL_DATA_POLICY, type LlmTask } from "@aya/providers";
import { type Script, ScriptSchema } from "@aya/schemas";
import { z } from "zod";

export const GENERATE_SCRIPT_PROMPT_VERSION = "generate-script@v1";
export const REVISE_SCRIPT_PROMPT_VERSION = "revise-script@v1";

/** 台本の共通ルール（生成・修正で同じものを使い、キャッシュを効かせる） */
export const SCRIPT_RULES = `あなたは短尺動画（YouTube Shorts / TikTok / Instagram Reels など）の台本作家です。
SNS に依存しない「マスター台本」を指定の JSON 形式で書きます。後で SNS ごとにタイトル・説明文・冒頭のフックを作り分けます。

ルール:
- 最初の 3 秒で視聴者を引き止めるフックを scene 1 に置き、scene 1 の priority は CORE にしてください。
- 尺の短い SNS で省いても話が通じるシーンだけ priority を OPTIONAL にしてください。
- 各シーンの duration（秒）の合計を duration_seconds に一致させてください。scene_number は 1 から連番にしてください。
- visual_prompt は動画生成 AI への指示です。映像の内容・構図・動きを具体的に書き、実在の人物・ブランド・ロゴ・他人の作品は描かせないでください。
- narration は読み上げる文、subtitle は画面に出す短い字幕です。1 シーンのナレーションは尺に収まる長さ（目安 1 秒 6〜8 文字）にしてください。
- 指定された NG ワードは、言い換えも含めて使わないでください。
- 「必ずバズる」「確実に稼げる」のような断定、誇大な表現、誤情報、医療・金融の断定的な助言は書かないでください。
- 出力は日本語で、指定の JSON Schema に従ってください。

${EXTERNAL_DATA_POLICY}`;

export interface ScriptChannelInput {
  genre: string | null;
  targetAudience: string | null;
  tone: string | null;
  ngWords: string[];
  brandGuidelines: string | null;
}

/** 企画の核（修正でも変えない） */
export interface ScriptIdeaInput {
  title: string;
  theme: string;
  target: string;
  hook: string;
  story: string;
  durationSec: number;
  sceneCount: number;
  cta: string;
  originalAngle: string | null;
  differentiation: string[];
}

export interface GenerateScriptRequest {
  channel: ScriptChannelInput;
  idea: ScriptIdeaInput;
  correction?: string;
}

function channelBlock(c: ScriptChannelInput): string {
  return [
    "# チャンネル設定",
    `- ジャンル: ${c.genre ?? "未設定"}`,
    `- ターゲット: ${c.targetAudience ?? "未設定"}`,
    `- トーン: ${c.tone ?? "未設定"}`,
    `- NG ワード: ${c.ngWords.length ? c.ngWords.join("、") : "なし"}`,
    ...(c.brandGuidelines ? [`- ブランドの方針: ${c.brandGuidelines}`] : []),
  ].join("\n");
}

function ideaBlock(idea: ScriptIdeaInput): string {
  return JSON.stringify(
    {
      title: idea.title,
      theme: idea.theme,
      target: idea.target,
      hook: idea.hook,
      story: idea.story,
      duration_sec: idea.durationSec,
      scene_count: idea.sceneCount,
      cta: idea.cta,
      original_angle: idea.originalAngle,
      differentiation: idea.differentiation,
    },
    null,
    2,
  );
}

export function buildGenerateScriptTask(req: GenerateScriptRequest): LlmTask<Script> {
  const prompt = [
    "# 採用された企画",
    ideaBlock(req.idea),
    "",
    `この企画の台本を書いてください。尺は ${req.idea.durationSec} 秒（±1 秒）、シーン数は ${req.idea.sceneCount} 前後を目安にしてください。`,
    "target は企画の target をそのまま使ってください。",
    ...(req.correction ? ["", req.correction] : []),
  ].join("\n");
  return {
    operation: "generate_script",
    schema: ScriptSchema,
    system: [
      { text: SCRIPT_RULES, cache: true },
      { text: channelBlock(req.channel), cache: true },
    ],
    prompt,
    effort: "high",
    maxTokens: 16_000,
  };
}

// ---------------------------------------------------------------- 修正

/** 修正の範囲。METADATA = タイトル・説明文・ハッシュタグ・CTA だけ、SCENES = フック・尺・シーンだけ、SCRIPT = 全体 */
export const REVISION_SCOPES = ["SCRIPT", "SCENES", "METADATA"] as const;
export type RevisionScope = (typeof REVISION_SCOPES)[number];

export const ReviseScriptOutputSchema = z.object({
  /** 実際に変えた範囲（Claude の判断。保存時はリクエストの範囲で機械的に制限する） */
  scope: z.enum(REVISION_SCOPES),
  /** 何をどう変えたか（担当者に見せる。日本語 1〜3 文） */
  change_summary: z.string().min(1).max(500),
  new_script: ScriptSchema,
});
export type ReviseScriptOutput = z.infer<typeof ReviseScriptOutputSchema>;

export interface ReviseScriptRequest {
  channel: ScriptChannelInput;
  idea: ScriptIdeaInput;
  current: Script;
  instruction: string;
  scope: RevisionScope;
  correction?: string;
}

const SCOPE_TEXT: Record<RevisionScope, string> = {
  SCRIPT: "台本全体を変えてかまいません。",
  SCENES:
    "フック・尺・シーンだけを変えてください。title / description / hashtags / cta は今のままにしてください。",
  METADATA:
    "title / description / hashtags / cta だけを変えてください。hook・duration_seconds・scenes は今のままにしてください。",
};

export function buildReviseScriptTask(req: ReviseScriptRequest): LlmTask<ReviseScriptOutput> {
  const prompt = [
    "# 企画の核（変えないこと）",
    ideaBlock(req.idea),
    "",
    "# 今の台本",
    JSON.stringify(req.current, null, 2),
    "",
    "# 担当者の修正指示",
    // 担当者の入力は区切って渡す（台本の一部として扱わせない）
    "<instruction>",
    req.instruction,
    "</instruction>",
    "",
    "修正指示に沿って台本を直し、new_script に全体を出力してください。",
    `修正の範囲: ${SCOPE_TEXT[req.scope]}`,
    "企画のテーマ・切り口・target は変えないでください。指示がそれらを変える内容なら、核を保てる範囲で反映し、change_summary にその旨を書いてください。",
    "指示に関係ないシーンは一字一句変えないでください（変更していないシーンの動画・音声を再利用するため）。",
    ...(req.correction ? ["", req.correction] : []),
  ].join("\n");
  return {
    operation: "revise",
    schema: ReviseScriptOutputSchema,
    system: [
      { text: SCRIPT_RULES, cache: true },
      { text: channelBlock(req.channel), cache: true },
    ],
    prompt,
    effort: "high",
    maxTokens: 16_000,
  };
}

/**
 * 修正の範囲と企画の核を機械的に守る（Claude の出力をそのまま信用しない）。
 * - target はいつも今の台本のまま
 * - METADATA: フック・尺・シーンは今の台本のまま
 * - SCENES: タイトル・説明文・ハッシュタグ・CTA は今の台本のまま
 */
export function applyRevisionScope(current: Script, revised: Script, scope: RevisionScope): Script {
  const merged: Script = { ...revised, target: current.target };
  if (scope === "METADATA") {
    return {
      ...merged,
      hook: current.hook,
      duration_seconds: current.duration_seconds,
      scenes: current.scenes,
    };
  }
  if (scope === "SCENES") {
    return {
      ...merged,
      title: current.title,
      description: current.description,
      hashtags: current.hashtags,
      cta: current.cta,
    };
  }
  return merged;
}
