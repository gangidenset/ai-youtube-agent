import type { PrismaClient, WorkflowJob } from "@aya/db";
import { type JobType, jobDefinition } from "./jobs";

/** Prisma のトランザクション内のクライアント（状態更新と同じトランザクションでジョブを登録するため） */
export type TxClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export const ENQUEUE_EVENT = "job.enqueue";

export interface OutboxPayload {
  workflowJobId: string;
  jobType: JobType;
  /** キュー上のジョブ ID。再投入のたびに変える（同じ ID だとキュー側で重複扱いになるため） */
  queueJobId: string;
}

export interface EnqueueRequest {
  jobType: JobType;
  /** 同じキーのジョブは 1 つしか作らない（例: `script:{projectId}:v2`） */
  idempotencyKey: string;
  input?: Record<string, unknown>;
  channelId?: string;
  projectId?: string;
  researchRunId?: string;
  priority?: number;
}

/**
 * workflow_jobs への登録と outbox への「投入予定」記録を同じトランザクションで行う（Transactional Outbox）。
 * 呼び出し側の状態更新と同じ tx を渡せば、状態だけ進んでジョブが消える、という事故が起きない。
 * 同じ idempotencyKey のジョブが既にあれば、それを返して何もしない。
 */
export async function enqueueJob(
  tx: TxClient,
  req: EnqueueRequest,
): Promise<{ job: WorkflowJob; created: boolean }> {
  const existing = await tx.workflowJob.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
  if (existing) return { job: existing, created: false };

  const job = await tx.workflowJob.create({
    data: {
      jobType: req.jobType,
      idempotencyKey: req.idempotencyKey,
      maxAttempts: jobDefinition(req.jobType).maxAttempts,
      priority: req.priority ?? 0,
      channelId: req.channelId ?? null,
      projectId: req.projectId ?? null,
      researchRunId: req.researchRunId ?? null,
      ...(req.input ? { input: req.input as object } : {}),
    },
  });
  const payload: OutboxPayload = { workflowJobId: job.id, jobType: req.jobType, queueJobId: job.id };
  await tx.outboxEvent.create({ data: { eventType: ENQUEUE_EVENT, payload: { ...payload } } });
  return { job, created: true };
}

/** 同時に別プロセスが同じキーで登録した場合（一意制約違反）も、既存のジョブを返す */
export async function enqueueJobOnce(
  prisma: PrismaClient,
  req: EnqueueRequest,
): Promise<{ job: WorkflowJob; created: boolean }> {
  try {
    return await prisma.$transaction((tx) => enqueueJob(tx, req));
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "P2002") {
      const job = await prisma.workflowJob.findUniqueOrThrow({
        where: { idempotencyKey: req.idempotencyKey },
      });
      return { job, created: false };
    }
    throw err;
  }
}
