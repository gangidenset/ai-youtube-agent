import type { PrismaClient } from "@aya/db";
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

  /** 市場分析の状態・ジョブ・収集した動画の概要 */
  app.get("/api/v1/research-runs/:id", async (request) => {
    const params = RunParams.safeParse(request.params);
    if (!params.success) throw notFound();
    const run = await prisma.researchRun.findUnique({ where: { id: params.data.id } });
    if (!run) throw notFound();
    // 所属していないチャンネルの分析は、存在も分からないよう 404 にする
    await requireChannelPermission(prisma, request, run.channelId, "channel:read").catch((err: unknown) => {
      if (err instanceof AppError && err.statusCode === 403) throw notFound();
      throw err;
    });

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
}
