import { computeTrendScore, findOverclaims, type MarketVideoSample } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import {
  buildTrendAnalysisTask,
  completeAndRecord,
  type TrendAnalysis,
  trendAnalysisTexts,
} from "@aya/orchestrator";
import type { ClaudeProvider } from "@aya/providers";
import { applyTransition, enqueueJob, type JobHandler, NonRetryableError } from "@aya/queue";
import { z } from "zod";

export const TrendAnalysisInput = z.object({ researchRunId: z.uuid() });

/** Claude に渡す動画の上限（再生速度の高い順。入力トークンを抑えるため） */
export const MAX_VIDEOS_FOR_ANALYSIS = 80;
const DEFAULT_LOOKBACK_DAYS = 7;
const RunParams = z.object({ lookbackDays: z.number().int().optional() }).catch({});

export interface TrendAnalysisDeps {
  prisma: PrismaClient;
  claude: ClaudeProvider;
}

/**
 * トレンド分析ジョブ（docs/workflow.md: TREND_ANALYSIS）。
 * 1. 収集した動画を Claude に渡し、伸びているテーマと「なぜ伸びているか」を分析させる
 * 2. テーマごとに Trend Score を決定論的に計算する（Claude の評価は新規性・需要の 2 要素だけ）
 * 3. market_trends に保存し、企画生成（IDEA_GENERATION）へ進める
 * 「必ずバズる」のような断定が含まれていたら 1 回だけ書き直しを求め、それでも残れば失敗にする。
 */
export function trendAnalysisHandler(deps: TrendAnalysisDeps): JobHandler {
  return async (ctx) => {
    const { researchRunId } = TrendAnalysisInput.parse(ctx.input);
    const run = await deps.prisma.researchRun.findUnique({
      where: { id: researchRunId },
      include: { channel: { include: { settings: true } } },
    });
    if (!run) throw new NonRetryableError("RUN_NOT_FOUND", `市場分析 ${researchRunId} が見つかりません`);
    if (run.state !== "TREND_ANALYSIS") return { outputRef: `skipped:${run.state}` };

    const videos = await deps.prisma.competitorVideo.findMany({
      where: { researchRunId: run.id },
      orderBy: { viewsPerHour: "desc" },
    });
    if (videos.length === 0) {
      throw new NonRetryableError("NO_MARKET_DATA", "分析できる動画がありません（市場分析の結果が空です）");
    }
    // Shorts と推定される動画を優先し、足りなければ他も使う
    const shorts = videos.filter((v) => v.isShortEstimated);
    const pool = (shorts.length >= 10 ? shorts : videos).slice(0, MAX_VIDEOS_FOR_ANALYSIS);

    const lookbackDays = RunParams.parse(run.params).lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const settings = run.channel.settings;
    const request = {
      channel: {
        genre: settings?.genre ?? null,
        subGenres: settings?.subGenres ?? [],
        targetAudience: settings?.targetAudience ?? null,
        tone: settings?.tone ?? null,
        ngWords: settings?.ngWords ?? [],
      },
      keywords: run.keywords,
      region: run.region,
      lookbackDays,
      videos: pool.map((v) => ({
        id: v.youtubeVideoId,
        title: v.title,
        channel: v.channelTitle,
        tags: v.tags,
        viewCount: Number(v.viewCount),
        viewsPerHour: v.viewsPerHour,
        viewsPerSubscriber: v.viewsPerSubscriber,
        likeRate: v.likeRate,
        commentRate: v.commentRate,
        ageHours: v.ageHours,
        durationSec: v.durationSec,
      })),
    };
    const callCtx = { jobId: ctx.job.id, channelId: run.channelId };

    let { result, costUsd } = await completeAndRecord(
      deps.prisma,
      deps.claude,
      buildTrendAnalysisTask(request),
      callCtx,
    );
    let overclaims = findOverclaims(trendAnalysisTexts(result.data));
    if (overclaims.length > 0) {
      const retry = await completeAndRecord(
        deps.prisma,
        deps.claude,
        buildTrendAnalysisTask({
          ...request,
          correction: `前回の出力に断定的な表現（${overclaims.join("、")}）が含まれていました。予測を保証する表現を使わずに書き直してください。`,
        }),
        callCtx,
      );
      result = retry.result;
      costUsd += retry.costUsd;
      overclaims = findOverclaims(trendAnalysisTexts(result.data));
      if (overclaims.length > 0) {
        throw new NonRetryableError(
          "OVERCLAIM",
          `断定的な表現が取り除けませんでした: ${overclaims.join("、")}`,
        );
      }
    }

    const byId = new Map(videos.map((v) => [v.youtubeVideoId, v]));
    const population = pool.map(toSample);
    const trends = scoreTopics(result.data, byId, population, lookbackDays * 24);
    if (trends.length === 0) {
      throw new NonRetryableError("NO_VALID_TOPICS", "根拠の動画を確認できるテーマがありませんでした");
    }

    await deps.prisma.$transaction(async (tx) => {
      // 再実行しても重複しないよう、この分析の結果を入れ直す
      await tx.marketTrend.deleteMany({ where: { researchRunId: run.id } });
      await tx.marketTrend.createMany({
        data: trends.map((t) => ({ researchRunId: run.id, ...t })),
      });
      await applyTransition(tx, {
        entityType: "RESEARCH_RUN",
        entityId: run.id,
        from: "TREND_ANALYSIS",
        to: "IDEA_GENERATION",
        trigger: "JOB",
        jobId: ctx.job.id,
      });
      await enqueueJob(tx, {
        jobType: "generate_idea",
        idempotencyKey: `generate_idea:${run.id}`,
        input: { researchRunId: run.id },
        channelId: run.channelId,
        researchRunId: run.id,
      });
    });

    return { outputRef: `market_trends:${trends.length}`, costUsd };
  };
}

type VideoRow = {
  viewsPerHour: number;
  viewsPerSubscriber: number | null;
  likeRate: number | null;
  commentRate: number | null;
  ageHours: number;
  viewCount: bigint;
  channelSubscribers: bigint | null;
};

function toSample(v: VideoRow): MarketVideoSample {
  return {
    viewsPerHour: v.viewsPerHour,
    viewsPerSubscriber: v.viewsPerSubscriber,
    likeRate: v.likeRate,
    commentRate: v.commentRate,
    ageHours: v.ageHours,
    viewCount: Number(v.viewCount),
    channelSubscribers: v.channelSubscribers === null ? null : Number(v.channelSubscribers),
  };
}

/** Claude が挙げたテーマに、入力データで確認できる根拠だけを使って Trend Score を付ける */
function scoreTopics(
  analysis: TrendAnalysis,
  byId: Map<string, VideoRow>,
  population: MarketVideoSample[],
  lookbackHours: number,
) {
  return analysis.topics.flatMap((t) => {
    // 入力に無い ID（Claude の取り違え）は根拠として使わない
    const evidenceIds = [...new Set(t.evidence_video_ids)].filter((id) => byId.has(id));
    if (evidenceIds.length === 0) return [];
    const evidence = evidenceIds.map((id) => toSample(byId.get(id) as VideoRow));
    const score = computeTrendScore({
      evidence,
      population,
      lookbackHours,
      novelty: t.novelty,
      demand: t.demand,
    });
    return [
      {
        topic: t.topic,
        trendType: t.trend_type,
        trendScore: score.score,
        scoreBreakdown: {
          points: score.breakdown,
          components: score.components,
          claude: { novelty: t.novelty, demand: t.demand },
          dataUsed: { evidenceVideos: evidence.length, populationVideos: population.length, lookbackHours },
        },
        competitionLevel: t.competition_level,
        audienceNeeds: t.audience_needs,
        titlePatterns: t.title_patterns,
        hookPatterns: t.hook_patterns,
        structurePatterns: t.structure_patterns,
        differentiation: t.differentiation,
        uncertainty: `${score.uncertainty.level}: ${[...score.uncertainty.reasons, t.uncertainty_note].filter(Boolean).join(" / ")}`,
        risks: t.risks,
        evidenceVideoIds: evidenceIds,
      },
    ];
  });
}
