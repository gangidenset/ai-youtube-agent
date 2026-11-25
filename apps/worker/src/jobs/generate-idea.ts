import {
  computeOriginalityScore,
  findOverclaims,
  ngramJaccard,
  type SimilarityComparison,
  selectAutoTop,
} from "@aya/core";
import type { PrismaClient } from "@aya/db";
import {
  buildGenerateIdeaTask,
  completeAndRecord,
  type Decision,
  GENERATE_IDEA_PROMPT_VERSION,
  type GenerateIdeaRequest,
  ideaTexts,
  type IdeaSet,
  recordDecision,
  selectIdea,
} from "@aya/orchestrator";
import type { ClaudeProvider } from "@aya/providers";
import { applyTransition, type JobHandler, NonRetryableError } from "@aya/queue";
import { z } from "zod";

export const GenerateIdeaInput = z.object({ researchRunId: z.uuid() });

/** 企画の元にするトレンドの数（Trend Score の高い順） */
export const TRENDS_FOR_IDEAS = 3;
const EVIDENCE_PER_TREND = 8;
const RECENT_IDEAS = 30;

export interface GenerateIdeaDeps {
  prisma: PrismaClient;
  claude: ClaudeProvider;
}

/**
 * 企画生成ジョブ（docs/workflow.md: IDEA_GENERATION）。
 * 1. 上位のトレンドから Claude が A / B / C の 3 案を作る
 * 2. 各案の Originality Score を計算する（集めた全動画とのタイトル・フックの文字の類似度 + Claude の内容の類似度）
 * 3. video_ideas に保存し、企画選択待ち（WAITING_IDEA_SELECTION）にする
 * 4. 自動採用（AUTO_TOP）なら条件を満たす最良の案を採用して動画プロジェクトを作る。条件を満たす案が無ければ担当者の選択を待つ
 */
export function generateIdeaHandler(deps: GenerateIdeaDeps): JobHandler {
  return async (ctx) => {
    const { researchRunId } = GenerateIdeaInput.parse(ctx.input);
    const run = await deps.prisma.researchRun.findUnique({
      where: { id: researchRunId },
      include: { channel: { include: { settings: true } } },
    });
    if (!run) throw new NonRetryableError("RUN_NOT_FOUND", `市場分析 ${researchRunId} が見つかりません`);
    if (run.state !== "IDEA_GENERATION") return { outputRef: `skipped:${run.state}` };

    const trends = await deps.prisma.marketTrend.findMany({
      where: { researchRunId: run.id },
      orderBy: { trendScore: "desc" },
      take: TRENDS_FOR_IDEAS,
    });
    if (trends.length === 0) throw new NonRetryableError("NO_TRENDS", "企画の元になるトレンドがありません");
    const videos = await deps.prisma.competitorVideo.findMany({ where: { researchRunId: run.id } });
    const videoById = new Map(videos.map((v) => [v.youtubeVideoId, v]));
    const recent = await deps.prisma.videoIdea.findMany({
      where: { channelId: run.channelId, researchRunId: { not: run.id } },
      orderBy: { createdAt: "desc" },
      take: RECENT_IDEAS,
      select: { title: true },
    });

    const settings = run.channel.settings;
    const request: GenerateIdeaRequest = {
      channel: {
        genre: settings?.genre ?? null,
        targetAudience: settings?.targetAudience ?? null,
        tone: settings?.tone ?? null,
        ngWords: settings?.ngWords ?? [],
        defaultDurationSec: settings?.defaultDurationSec ?? 30,
        brandGuidelines: settings?.brandGuidelines ?? null,
      },
      trends: trends.map((t) => ({
        id: t.id,
        topic: t.topic,
        trendScore: t.trendScore,
        audienceNeeds: t.audienceNeeds,
        titlePatterns: t.titlePatterns,
        hookPatterns: t.hookPatterns,
        structurePatterns: t.structurePatterns,
        differentiation: t.differentiation,
        evidence: t.evidenceVideoIds.slice(0, EVIDENCE_PER_TREND).flatMap((id) => {
          const v = videoById.get(id);
          return v ? [{ id, title: v.title, viewsPerHour: v.viewsPerHour }] : [];
        }),
      })),
      recentIdeaTitles: recent.map((r) => r.title),
    };
    const callCtx = { jobId: ctx.job.id, channelId: run.channelId };

    const first = await completeAndRecord(deps.prisma, deps.claude, buildGenerateIdeaTask(request), callCtx);
    let set: IdeaSet = first.result.data;
    let costUsd = first.costUsd;
    let overclaims = findOverclaims(ideaTexts(set));
    if (overclaims.length > 0) {
      const retry = await completeAndRecord(
        deps.prisma,
        deps.claude,
        buildGenerateIdeaTask({
          ...request,
          correction: `前回の出力に断定的な表現（${overclaims.join("、")}）が含まれていました。予測や成果を保証する表現を使わずに書き直してください。`,
        }),
        callCtx,
      );
      set = retry.result.data;
      costUsd += retry.costUsd;
      overclaims = findOverclaims(ideaTexts(set));
      if (overclaims.length > 0) {
        throw new NonRetryableError(
          "OVERCLAIM",
          `断定的な表現が取り除けませんでした: ${overclaims.join("、")}`,
        );
      }
    }
    if (new Set(set.ideas.map((i) => i.label)).size !== set.ideas.length) {
      throw new NonRetryableError("INVALID_IDEAS", "企画のラベル（A / B / C）が重複しています");
    }

    const trendById = new Map(trends.map((t) => [t.id, t]));
    const fallbackTrend = trends[0];
    const rows = set.ideas.map((idea) => {
      // 存在しない trend_id は、最も Trend Score の高いトレンドに寄せる
      const trend = trendById.get(idea.trend_id) ?? fallbackTrend;
      const semantic = new Map(
        idea.similar_videos.filter((s) => videoById.has(s.video_id)).map((s) => [s.video_id, s]),
      );
      // 集めた全動画とタイトル・フックの文字の類似度を比べ、Claude が評価した動画は内容の類似度も使う
      const comparisons: SimilarityComparison[] = videos.map((v) => {
        const text = Math.max(ngramJaccard(idea.title, v.title), ngramJaccard(idea.hook, v.title));
        return {
          videoId: v.youtubeVideoId,
          textSimilarity: text,
          // Claude が似ていると挙げなかった動画は、文字の類似度と同程度とみなす
          semanticSimilarity: semantic.get(v.youtubeVideoId)?.similarity ?? text,
        };
      });
      const originality = computeOriginalityScore(comparisons, idea.differentiation.length);
      const closest = originality.closest ? videoById.get(originality.closest.videoId) : undefined;
      return {
        researchRunId: run.id,
        channelId: run.channelId,
        label: idea.label,
        title: idea.title,
        theme: idea.theme,
        target: idea.target,
        hook: idea.hook,
        story: idea.story,
        durationSec: idea.duration_sec,
        sceneCount: idea.scene_count,
        cta: idea.cta,
        trendScore: trend?.trendScore ?? 0,
        originalityScore: originality.score,
        scoreRationale: {
          trendId: trend?.id ?? null,
          trendTopic: trend?.topic ?? null,
          commonPatterns: idea.common_patterns,
          originalAngle: idea.original_angle,
          differentiation: idea.differentiation,
          closestVideo: originality.closest
            ? { ...originality.closest, title: closest?.title ?? null }
            : null,
          promptVersion: GENERATE_IDEA_PROMPT_VERSION,
        },
        similarVideos: idea.similar_videos,
        copyRisk: originality.copyRisk,
        policyRisk: idea.policy_risk,
        risks: idea.risks,
      };
    });

    const saved = await deps.prisma.$transaction(async (tx) => {
      // 再実行しても重複しないよう入れ直す（採用前なので安全）
      await tx.videoIdea.deleteMany({ where: { researchRunId: run.id } });
      const created = [];
      for (const row of rows) created.push(await tx.videoIdea.create({ data: row }));
      await applyTransition(tx, {
        entityType: "RESEARCH_RUN",
        entityId: run.id,
        from: "IDEA_GENERATION",
        to: "WAITING_IDEA_SELECTION",
        trigger: "JOB",
        jobId: ctx.job.id,
      });
      return created;
    });

    const mode = settings?.ideaSelectionMode ?? "AUTO_TOP";
    if (mode !== "AUTO_TOP") return { outputRef: `video_ideas:${saved.length}:manual`, costUsd };

    const auto = selectAutoTop(saved);
    const decision: Decision = auto.selected
      ? {
          next_action: "GENERATE_SCRIPT",
          reason: auto.reason,
          confidence: 1,
          parameters: { idea_id: auto.selected.id },
          risks: [],
          data_refs: saved.map((i) => `video_idea:${i.id}`),
        }
      : {
          next_action: "ESCALATE_TO_HUMAN",
          reason: auto.reason,
          confidence: 1,
          parameters: {},
          risks: [],
          data_refs: saved.map((i) => `video_idea:${i.id}`),
        };
    // 自動採用はルールによる判断（Claude ではない）。監査ログには同じ形で残す
    const decisionId = await recordDecision(deps.prisma, {
      decision,
      verdict: auto.selected
        ? { accepted: true, toState: "SCRIPT_GENERATION" }
        : { accepted: false, code: "ESCALATED_BY_AI", reason: auto.reason, escalate: true },
      state: "WAITING_IDEA_SELECTION",
      model: "rule:auto_top",
      promptVersion: "auto_top@v1",
      channelId: run.channelId,
      researchRunId: run.id,
    });
    if (!auto.selected) return { outputRef: `video_ideas:${saved.length}:waiting_selection`, costUsd };

    const selected = await selectIdea(deps.prisma, {
      ideaId: auto.selected.id,
      trigger: "SYSTEM",
      decisionId,
    });
    return { outputRef: `video_project:${selected.projectCode}`, costUsd };
  };
}
