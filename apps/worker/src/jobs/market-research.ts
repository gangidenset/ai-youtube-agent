import { deriveVideoMetrics, isShortEstimated, nextPacificMidnight, pacificDate } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import {
  type GuardedYouTubeProvider,
  ProviderError,
  QuotaExceededError,
  type VideoDetails,
} from "@aya/providers";
import { applyTransition, enqueueJob, type JobHandler, NonRetryableError } from "@aya/queue";
import { z } from "zod";

export const MarketResearchInput = z.object({ researchRunId: z.uuid() });

export const DEFAULT_LOOKBACK_DAYS = 7;
/** 1 回の市場分析で使うキーワードの上限（search.list は 1 回 100 units。docs/design-proposal.md §14） */
export const MAX_KEYWORDS = 5;
/** 詳細を取得する動画の上限（videos.list は 50 件で 1 unit） */
export const MAX_VIDEOS = 300;
const DESCRIPTION_EXCERPT_LENGTH = 500;

const RunParams = z
  .object({ lookbackDays: z.number().int().min(1).max(30).optional() })
  .partial()
  .catch({});

export interface MarketResearchDeps {
  prisma: PrismaClient;
  /** ジョブごとに作る（クォータの使用量をジョブ単位で数えるため） */
  createYouTube: () => GuardedYouTubeProvider;
  language?: string;
  now?: () => Date;
}

/**
 * 市場分析ジョブ（docs/workflow.md: MARKET_RESEARCH）。
 * キーワード検索 + 地域の人気動画 → 動画の詳細 → チャンネル規模を取得し、派生指標と一緒に competitor_videos に保存する。
 * 終わったらトレンド分析（TREND_ANALYSIS）へ進め、次のジョブを登録する。
 * クォータが足りなければ PAUSED にして、太平洋時間の 0 時以降に自動で再開する。
 */
export function marketResearchHandler(deps: MarketResearchDeps): JobHandler {
  const now = deps.now ?? (() => new Date());

  return async (ctx) => {
    const { researchRunId } = MarketResearchInput.parse(ctx.input);
    const run = await deps.prisma.researchRun.findUnique({
      where: { id: researchRunId },
      include: { channel: { include: { settings: true } } },
    });
    if (!run) throw new NonRetryableError("RUN_NOT_FOUND", `市場分析 ${researchRunId} が見つかりません`);

    if (run.state === "PAUSED") {
      await deps.prisma.$transaction((tx) =>
        applyTransition(tx, {
          entityType: "RESEARCH_RUN",
          entityId: run.id,
          from: "PAUSED",
          to: "MARKET_RESEARCH",
          resumeTo: "MARKET_RESEARCH",
          trigger: "JOB",
          jobId: ctx.job.id,
        }),
      );
    } else if (run.state !== "MARKET_RESEARCH") {
      // 既に先へ進んでいる（同じジョブの再実行など）。何もしない
      return { outputRef: `skipped:${run.state}` };
    }
    if (!run.startedAt) {
      await deps.prisma.researchRun.update({ where: { id: run.id }, data: { startedAt: now() } });
    }

    const keywords = run.keywords.slice(0, MAX_KEYWORDS);
    const lookbackDays = RunParams.parse(run.params).lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const region = run.region;
    const language = run.channel.settings?.language ?? deps.language ?? "ja";
    const youtube = deps.createYouTube();

    let videos: VideoDetails[];
    let subscribers: Map<string, number | null>;
    try {
      const publishedAfter = new Date(now().getTime() - lookbackDays * 24 * 3_600_000);
      const ids = new Set<string>();
      for (const q of keywords) {
        const hits = await youtube.searchShortVideos({
          q,
          regionCode: region,
          relevanceLanguage: language,
          publishedAfter,
        });
        hits.forEach((h) => ids.add(h.videoId));
        await ctx.heartbeat();
      }
      const popular = await youtube.getMostPopular(region);
      const searched = await youtube.getVideos(
        [...ids].filter((id) => !popular.some((p) => p.videoId === id)),
      );
      videos = [...popular, ...searched].slice(0, MAX_VIDEOS);
      const channels = await youtube.getChannels(videos.map((v) => v.channelId));
      subscribers = new Map(channels.map((c) => [c.channelId, c.subscriberCount]));
    } catch (err) {
      if (err instanceof QuotaExceededError)
        return pauseForQuota(deps.prisma, run.id, ctx.job.id, youtube.unitsUsed, now());
      if (err instanceof ProviderError && !err.retryable)
        await failRun(deps.prisma, run.id, ctx.job.id, err.message);
      throw err;
    }

    const fetchedAt = now();
    const rows = videos.map((v) => {
      const channelSubscribers = subscribers.get(v.channelId) ?? null;
      const metrics = deriveVideoMetrics({
        publishedAt: v.publishedAt,
        fetchedAt,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
        channelSubscribers,
      });
      return {
        researchRunId: run.id,
        youtubeVideoId: v.videoId,
        title: v.title,
        descriptionExcerpt: v.description.slice(0, DESCRIPTION_EXCERPT_LENGTH),
        channelYoutubeId: v.channelId,
        channelTitle: v.channelTitle,
        channelSubscribers: channelSubscribers === null ? null : BigInt(channelSubscribers),
        publishedAt: v.publishedAt,
        durationSec: v.durationSec,
        isShortEstimated: isShortEstimated(v.durationSec),
        categoryId: v.categoryId,
        tags: v.tags.slice(0, 30),
        viewCount: BigInt(v.viewCount),
        likeCount: v.likeCount === null ? null : BigInt(v.likeCount),
        commentCount: v.commentCount === null ? null : BigInt(v.commentCount),
        fetchedAt,
        ...metrics,
      };
    });

    await deps.prisma.$transaction(async (tx) => {
      // 再実行しても重複しないよう、この分析の結果を入れ直す
      await tx.competitorVideo.deleteMany({ where: { researchRunId: run.id } });
      await tx.competitorVideo.createMany({ data: rows });
      await tx.researchRun.update({
        where: { id: run.id },
        data: { quotaUsed: { increment: youtube.unitsUsed } },
      });
      await applyTransition(tx, {
        entityType: "RESEARCH_RUN",
        entityId: run.id,
        from: "MARKET_RESEARCH",
        to: "TREND_ANALYSIS",
        trigger: "JOB",
        jobId: ctx.job.id,
      });
      await enqueueJob(tx, {
        jobType: "trend_analysis",
        idempotencyKey: `trend_analysis:${run.id}`,
        input: { researchRunId: run.id },
        channelId: run.channelId,
        researchRunId: run.id,
      });
    });

    return { outputRef: `competitor_videos:${rows.length}` };
  };
}

async function pauseForQuota(
  prisma: PrismaClient,
  runId: string,
  jobId: string,
  unitsUsed: number,
  at: Date,
) {
  const resumeAt = nextPacificMidnight(at);
  await prisma.$transaction(async (tx) => {
    await tx.researchRun.update({ where: { id: runId }, data: { quotaUsed: { increment: unitsUsed } } });
    await applyTransition(tx, {
      entityType: "RESEARCH_RUN",
      entityId: runId,
      from: "MARKET_RESEARCH",
      to: "PAUSED",
      trigger: "JOB",
      jobId,
    });
    const run = await tx.researchRun.findUniqueOrThrow({ where: { id: runId } });
    await enqueueJob(tx, {
      jobType: "market_research",
      // 再開ジョブは 1 日 1 件
      idempotencyKey: `market_research:${runId}:resume:${pacificDate(resumeAt)}`,
      input: { researchRunId: runId },
      channelId: run.channelId,
      researchRunId: runId,
      runAt: resumeAt,
    });
  });
  return { outputRef: `paused:quota:resume_at=${resumeAt.toISOString()}` };
}

async function failRun(prisma: PrismaClient, runId: string, jobId: string, reason: string) {
  await prisma
    .$transaction((tx) =>
      applyTransition(tx, {
        entityType: "RESEARCH_RUN",
        entityId: runId,
        from: "MARKET_RESEARCH",
        to: "FAILED",
        trigger: "JOB",
        jobId,
        failedReason: reason,
      }),
    )
    // 他の処理が先に状態を変えていた場合は、そちらを優先する
    .catch(() => undefined);
}
