import { findNgWords, findOverclaims, scriptTexts } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import {
  buildGenerateScriptTask,
  completeAndRecord,
  type GenerateScriptRequest,
  lockProject,
  saveScriptVersion,
  type ScriptChannelInput,
  type ScriptIdeaInput,
} from "@aya/orchestrator";
import type { ClaudeProvider, LlmTask } from "@aya/providers";
import { type JobHandler, NonRetryableError } from "@aya/queue";
import type { Script } from "@aya/schemas";
import { z } from "zod";

export const GenerateScriptInput = z.object({ projectId: z.uuid(), ideaId: z.uuid().optional() });

export interface GenerateScriptDeps {
  prisma: PrismaClient;
  claude: ClaudeProvider;
}

type ChannelSettingsLike = {
  genre: string | null;
  targetAudience: string | null;
  tone: string | null;
  ngWords: string[];
  brandGuidelines: string | null;
} | null;

export function toChannelInput(settings: ChannelSettingsLike): ScriptChannelInput {
  return {
    genre: settings?.genre ?? null,
    targetAudience: settings?.targetAudience ?? null,
    tone: settings?.tone ?? null,
    ngWords: settings?.ngWords ?? [],
    brandGuidelines: settings?.brandGuidelines ?? null,
  };
}

export function toIdeaInput(idea: {
  title: string;
  theme: string;
  target: string;
  hook: string;
  story: string;
  durationSec: number;
  sceneCount: number;
  cta: string;
  scoreRationale: unknown;
}): ScriptIdeaInput {
  const rationale = (idea.scoreRationale ?? {}) as { originalAngle?: unknown; differentiation?: unknown };
  return {
    title: idea.title,
    theme: idea.theme,
    target: idea.target,
    hook: idea.hook,
    story: idea.story,
    durationSec: idea.durationSec,
    sceneCount: idea.sceneCount,
    cta: idea.cta,
    originalAngle: typeof rationale.originalAngle === "string" ? rationale.originalAngle : null,
    differentiation: Array.isArray(rationale.differentiation)
      ? rationale.differentiation.filter((d): d is string => typeof d === "string")
      : [],
  };
}

/** NG ワード・断定表現の問題点。無ければ null */
export function scriptProblems(script: Script, ngWords: readonly string[]): string | null {
  const texts = scriptTexts(script);
  const ng = findNgWords(texts, ngWords);
  const over = findOverclaims(texts);
  const problems = [
    ...(ng.length ? [`NG ワード（${ng.join("、")}）`] : []),
    ...(over.length ? [`断定的な表現（${over.join("、")}）`] : []),
  ];
  return problems.length ? problems.join("、") : null;
}

/**
 * Claude に台本を頼み、NG ワード・断定表現があれば 1 回だけ書き直しを求める。残れば失敗（リトライしても同じため）。
 * 形式（ScriptSchema: シーンの連番・尺の合計など）が合わない場合の再要求（最大 2 回）は Claude Provider が行う。
 */
export async function completeCheckedScript<T>(
  deps: GenerateScriptDeps,
  build: (correction?: string) => LlmTask<T>,
  pick: (data: T) => Script,
  ngWords: readonly string[],
  callCtx: { jobId: string; channelId: string; projectId: string },
): Promise<{ data: T; costUsd: number }> {
  const first = await completeAndRecord(deps.prisma, deps.claude, build(), callCtx);
  let data = first.result.data;
  let costUsd = first.costUsd;
  const problem = scriptProblems(pick(data), ngWords);
  if (problem) {
    const retry = await completeAndRecord(
      deps.prisma,
      deps.claude,
      build(`前回の出力に ${problem} が含まれていました。使わずに書き直してください。`),
      callCtx,
    );
    data = retry.result.data;
    costUsd += retry.costUsd;
    const still = scriptProblems(pick(data), ngWords);
    if (still) throw new NonRetryableError("SCRIPT_CHECK_FAILED", `台本から ${still} を取り除けませんでした`);
  }
  return { data, costUsd };
}

/**
 * 台本生成ジョブ（docs/workflow.md: SCRIPT_GENERATION）。
 * 採用された企画から SNS 中立のマスター台本（§17）を作り、版 1 として保存する。
 * 次の工程（SNS 別テキスト: PLATFORM_OPTIMIZATION）への接続は Issue #14 で行う。それまではこの状態で修正を受け付ける。
 */
export function generateScriptHandler(deps: GenerateScriptDeps): JobHandler {
  return async (ctx) => {
    const input = GenerateScriptInput.parse(ctx.input);
    const project = await deps.prisma.videoProject.findUnique({
      where: { id: input.projectId },
      include: {
        idea: true,
        channel: { include: { settings: true } },
        scripts: { select: { version: true }, take: 1 },
      },
    });
    if (!project || project.deletedAt) {
      throw new NonRetryableError(
        "PROJECT_NOT_FOUND",
        `動画プロジェクト ${input.projectId} が見つかりません`,
      );
    }
    // 状態が進んでいる・既に台本がある・企画が差し替えられた場合は何もしない（冪等）
    if (project.state !== "SCRIPT_GENERATION") return { outputRef: `skipped:${project.state}` };
    if (project.scripts.length > 0) return { outputRef: "skipped:script_exists" };
    if (!project.idea) throw new NonRetryableError("NO_IDEA", "採用された企画がありません");
    if (input.ideaId && project.ideaId !== input.ideaId) return { outputRef: "skipped:idea_swapped" };

    const channel = toChannelInput(project.channel.settings);
    const request: GenerateScriptRequest = { channel, idea: toIdeaInput(project.idea) };
    const { data: script, costUsd } = await completeCheckedScript(
      deps,
      (correction) => buildGenerateScriptTask(correction ? { ...request, correction } : request),
      (s) => s,
      channel.ngWords,
      { jobId: ctx.job.id, channelId: project.channelId, projectId: project.id },
    );

    const ideaId = project.ideaId;
    const saved = await deps.prisma.$transaction(async (tx) => {
      // 企画の差し替えと同時に保存しないよう、ロックしてから確かめ直す
      await lockProject(tx, project.id);
      const fresh = await tx.videoProject.findUniqueOrThrow({
        where: { id: project.id },
        include: { scripts: { select: { version: true }, take: 1 } },
      });
      if (fresh.state !== "SCRIPT_GENERATION" || fresh.scripts.length > 0 || fresh.ideaId !== ideaId)
        return null;
      // 企画の target は台本でも変えない
      return saveScriptVersion(tx, {
        projectId: project.id,
        script: { ...script, target: project.idea?.target ?? script.target },
        createdBy: "AI",
      });
    });
    if (!saved) return { outputRef: "skipped:changed_while_generating", costUsd };
    return { outputRef: `scripts:${saved.scriptId}:v${saved.version}`, costUsd };
  };
}
