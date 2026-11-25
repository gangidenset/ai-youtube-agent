import { describeIneligible, ineligibleReasons } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import { SelectionError, selectIdea } from "@aya/orchestrator";
import { enqueueJob } from "@aya/queue";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireChannelPermission } from "../auth/guards";
import { AppError } from "../errors";

const ChannelParams = z.object({ id: z.uuid() });
const RunParams = z.object({ id: z.uuid() });

const CreateBody = z
  .object({
    keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(5).optional(),
    lookbackDays: z.number().int().min(1).max(30).default(7),
  })
  .default({ lookbackDays: 7 });

/** 同じキーで再送されたら同じ分析を返す（docs/api.md: ジョブを起動する POST は Idempotency-Key 必須） */
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const notFound = () => new AppError(404, "NOT_FOUND", "見つかりません");

function idempotencyKeyOf(request: FastifyRequest): string {
  const parsed = IdempotencyKey.safeParse(request.headers["idempotency-key"]);
  if (!parsed.success) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key ヘッダ（8〜128 文字の英数字・記号 ._:-）が必要です",
    );
  }
  return parsed.data;
}

export async function researchRunRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  /** 市場分析を開始する。ジョブを登録して 202 を返す（処理は worker が行う）。 */
  app.post("/api/v1/channels/:id/research-runs", async (request, reply) => {
    const params = ChannelParams.safeParse(request.params);
    if (!params.success) throw notFound();
    const channelId = params.data.id;
    const { auth } = await requireChannelPermission(prisma, request, channelId, "channel:edit");
    const idempotencyKey = `market_research:${channelId}:${idempotencyKeyOf(request)}`;

    const body = CreateBody.safeParse(request.body ?? undefined);
    if (!body.success)
      throw new AppError(400, "INVALID_REQUEST", "入力が正しくありません", body.error.issues);

    const existing = await prisma.workflowJob.findUnique({ where: { idempotencyKey } });
    if (existing?.researchRunId) {
      return reply.status(202).send({ researchRunId: existing.researchRunId, jobId: existing.id });
    }

    const settings = await prisma.channelSettings.findUnique({ where: { channelId } });
    const keywords =
      body.data.keywords ??
      [settings?.genre, ...(settings?.subGenres ?? [])]
        .filter((k): k is string => !!k && k.trim() !== "")
        .slice(0, 5);
    if (keywords.length === 0) {
      throw new AppError(
        400,
        "KEYWORDS_REQUIRED",
        "キーワードを指定するか、チャンネル設定でジャンルを設定してください",
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.researchRun.create({
        data: {
          channelId,
          state: "MARKET_RESEARCH",
          keywords,
          region: settings?.region ?? "JP",
          params: { lookbackDays: body.data.lookbackDays },
        },
      });
      await tx.workflowTransition.create({
        data: {
          entityType: "RESEARCH_RUN",
          entityId: run.id,
          fromState: null,
          toState: "MARKET_RESEARCH",
          trigger: "USER",
          actorId: auth.userId,
        },
      });
      const { job } = await enqueueJob(tx, {
        jobType: "market_research",
        idempotencyKey,
        input: { researchRunId: run.id },
        channelId,
        researchRunId: run.id,
      });
      return { researchRunId: run.id, jobId: job.id };
    });
    return reply.status(202).send(result);
  });

  /** 閲覧権限のある市場分析を読む。所属していないチャンネルの分析は、存在も分からないよう 404 にする */
  async function loadRunForRead(request: FastifyRequest) {
    const params = RunParams.safeParse(request.params);
    if (!params.success) throw notFound();
    const run = await prisma.researchRun.findUnique({ where: { id: params.data.id } });
    if (!run) throw notFound();
    await requireChannelPermission(prisma, request, run.channelId, "channel:read").catch((err: unknown) => {
      if (err instanceof AppError && err.statusCode === 403) throw notFound();
      throw err;
    });
    return run;
  }

  /** 市場分析の状態・ジョブ・収集した動画の概要 */
  app.get("/api/v1/research-runs/:id", async (request) => {
    const run = await loadRunForRead(request);

    const [jobs, videoCount, shortCount, topVideos] = await Promise.all([
      prisma.workflowJob.findMany({ where: { researchRunId: run.id }, orderBy: { createdAt: "asc" } }),
      prisma.competitorVideo.count({ where: { researchRunId: run.id } }),
      prisma.competitorVideo.count({ where: { researchRunId: run.id, isShortEstimated: true } }),
      prisma.competitorVideo.findMany({
        where: { researchRunId: run.id },
        orderBy: { viewsPerHour: "desc" },
        take: 10,
      }),
    ]);

    return {
      id: run.id,
      channelId: run.channelId,
      state: run.state,
      keywords: run.keywords,
      region: run.region,
      params: run.params,
      quotaUsed: run.quotaUsed,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      jobs: jobs.map((j) => ({
        id: j.id,
        jobType: j.jobType,
        status: j.status,
        retryCount: j.retryCount,
        nextRunAt: j.nextRunAt,
        errorCode: j.errorCode,
        errorMessage: j.errorMessage,
      })),
      competitorVideos: {
        total: videoCount,
        shortsEstimated: shortCount,
        // 他人の動画のタイトルは外部データ。画面では必ずエスケープして表示する（React の既定動作）
        topByViewsPerHour: topVideos.map((v) => ({
          youtubeVideoId: v.youtubeVideoId,
          title: v.title,
          channelTitle: v.channelTitle,
          viewCount: Number(v.viewCount),
          viewsPerHour: v.viewsPerHour,
          isShortEstimated: v.isShortEstimated,
          publishedAt: v.publishedAt,
        })),
      },
    };
  });

  /**
   * トレンド分析の結果（Trend Score の高い順）。スコアには内訳・使ったデータ・不確実性・リスクを必ず付ける。
   * 予測は保証ではないこと、YouTube 以外の SNS への適合は推定であることを明示する（指示書 §14、docs/multi-platform.md §3.7）。
   */
  app.get("/api/v1/research-runs/:id/trends", async (request) => {
    const run = await loadRunForRead(request);
    const trends = await prisma.marketTrend.findMany({
      where: { researchRunId: run.id },
      orderBy: { trendScore: "desc" },
    });
    const evidenceIds = [...new Set(trends.flatMap((t) => t.evidenceVideoIds))];
    const videos = await prisma.competitorVideo.findMany({
      where: { researchRunId: run.id, youtubeVideoId: { in: evidenceIds } },
    });
    const byId = new Map(videos.map((v) => [v.youtubeVideoId, v]));

    return {
      researchRunId: run.id,
      state: run.state,
      notice:
        "Trend Score は収集したデータに基づく目安で、再生数を保証するものではありません。市場データは YouTube から取得しており、他の SNS への適合度は推定です。",
      trends: trends.map((t) => ({
        id: t.id,
        topic: t.topic,
        trendType: t.trendType,
        trendScore: t.trendScore,
        scoreBreakdown: t.scoreBreakdown,
        uncertainty: t.uncertainty,
        competitionLevel: t.competitionLevel,
        audienceNeeds: t.audienceNeeds,
        titlePatterns: t.titlePatterns,
        hookPatterns: t.hookPatterns,
        structurePatterns: t.structurePatterns,
        differentiation: t.differentiation,
        risks: t.risks,
        evidence: t.evidenceVideoIds.flatMap((id) => {
          const v = byId.get(id);
          return v
            ? [
                {
                  youtubeVideoId: v.youtubeVideoId,
                  title: v.title,
                  channelTitle: v.channelTitle,
                  viewCount: Number(v.viewCount),
                  viewsPerHour: v.viewsPerHour,
                  publishedAt: v.publishedAt,
                },
              ]
            : [];
        }),
      })),
    };
  });

  /** チャンネルの市場分析の一覧（新しい順） */
  app.get("/api/v1/channels/:id/research-runs", async (request) => {
    const params = ChannelParams.safeParse(request.params);
    if (!params.success) throw notFound();
    await requireChannelPermission(prisma, request, params.data.id, "channel:read");
    const runs = await prisma.researchRun.findMany({
      where: { channelId: params.data.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return {
      researchRuns: runs.map((r) => ({
        id: r.id,
        state: r.state,
        keywords: r.keywords,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
    };
  });

  /** 企画の一覧（A / B / C）と、採用の状況 */
  app.get("/api/v1/research-runs/:id/ideas", async (request) => {
    const run = await loadRunForRead(request);
    const [ideas, settings] = await Promise.all([
      prisma.videoIdea.findMany({ where: { researchRunId: run.id }, orderBy: { label: "asc" } }),
      prisma.channelSettings.findUnique({ where: { channelId: run.channelId } }),
    ]);
    const project = await prisma.videoProject.findFirst({
      where: { idea: { researchRunId: run.id }, deletedAt: null },
      include: { scripts: { select: { id: true }, take: 1 } },
    });
    const canSelect =
      (!project && run.state === "WAITING_IDEA_SELECTION") ||
      (!!project && project.state === "SCRIPT_GENERATION" && project.scripts.length === 0);

    return {
      researchRunId: run.id,
      state: run.state,
      selectionMode: settings?.ideaSelectionMode ?? "AUTO_TOP",
      canSelect,
      project: project
        ? { id: project.id, code: project.code, state: project.state, ideaId: project.ideaId }
        : null,
      notice: "Trend Score・Originality Score は目安です。採用前に内容とリスクを確認してください。",
      ideas: ideas.map((i) => {
        const reasons = ineligibleReasons(i);
        return {
          id: i.id,
          label: i.label,
          status: i.status,
          title: i.title,
          theme: i.theme,
          target: i.target,
          hook: i.hook,
          story: i.story,
          durationSec: i.durationSec,
          sceneCount: i.sceneCount,
          cta: i.cta,
          trendScore: i.trendScore,
          originalityScore: i.originalityScore,
          copyRisk: i.copyRisk,
          policyRisk: i.policyRisk,
          risks: i.risks,
          scoreRationale: i.scoreRationale,
          autoSelectable: reasons.length === 0,
          notAutoSelectableReason: reasons.length ? describeIneligible(reasons) : null,
        };
      }),
    };
  });

  /** 企画を選ぶ（手動選択、または自動採用された企画の差し替え） */
  app.post("/api/v1/ideas/:id/select", async (request, reply) => {
    const params = RunParams.safeParse(request.params);
    if (!params.success) throw notFound();
    const idea = await prisma.videoIdea.findUnique({ where: { id: params.data.id } });
    if (!idea) throw notFound();
    const { auth } = await requireChannelPermission(prisma, request, idea.channelId, "channel:edit").catch(
      (err: unknown) => {
        // 所属していないチャンネルの企画は存在も見せない。閲覧だけできる人には 403
        if (err instanceof AppError && err.statusCode === 403) {
          return prisma.channelMember
            .findUnique({
              where: { channelId_userId: { channelId: idea.channelId, userId: request.auth?.userId ?? "" } },
            })
            .then((m) => {
              throw m ? err : notFound();
            });
        }
        throw err;
      },
    );
    try {
      const result = await selectIdea(prisma, { ideaId: idea.id, trigger: "USER", actorId: auth.userId });
      // 台本生成は非同期で進むため 202
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof SelectionError) {
        throw new AppError(err.code === "IDEA_NOT_FOUND" ? 404 : 409, err.code, err.message);
      }
      throw err;
    }
  });
}
