import type { PrismaClient } from "@aya/db";
import { ENQUEUE_EVENT, type OutboxPayload } from "./enqueue";
import { isJobType } from "./jobs";

/** heartbeat がこれ以上途絶えたジョブは止まったとみなす（docs/workflow.md: 30 秒ごと更新、5 分途絶で再投入） */
export const STALE_AFTER_MS = 5 * 60_000;

export interface ReapResult {
  requeued: number;
  failed: number;
}

/**
 * RUNNING のまま heartbeat が途絶えたジョブ（プロセスの強制終了・Redis のデータ消失など）を回収する。
 * 試行回数が残っていれば QUEUED に戻して再投入し、使い切っていれば FAILED にする。
 */
export async function reapStalledJobs(
  prisma: PrismaClient,
  options: { now?: Date; staleAfterMs?: number; limit?: number } = {},
): Promise<ReapResult> {
  const now = options.now ?? new Date();
  const threshold = new Date(now.getTime() - (options.staleAfterMs ?? STALE_AFTER_MS));
  const stalled = await prisma.workflowJob.findMany({
    where: { status: "RUNNING", heartbeatAt: { lt: threshold } },
    orderBy: { heartbeatAt: "asc" },
    take: options.limit ?? 100,
  });

  let requeued = 0;
  let failed = 0;
  for (const job of stalled) {
    const attempt = job.retryCount + 1;
    const owned = { id: job.id, status: "RUNNING" as const, retryCount: job.retryCount };
    const message = "heartbeat が途絶えたため停止したとみなしました";

    if (attempt >= job.maxAttempts || !isJobType(job.jobType)) {
      const res = await prisma.workflowJob.updateMany({
        where: owned,
        data: { status: "FAILED", errorCode: "STALLED", errorMessage: message, completedAt: now },
      });
      failed += res.count;
      continue;
    }

    const jobType = job.jobType;
    const done = await prisma.$transaction(async (tx) => {
      const res = await tx.workflowJob.updateMany({
        where: owned,
        data: {
          status: "QUEUED",
          retryCount: attempt,
          errorCode: "STALLED",
          errorMessage: message,
          nextRunAt: now,
        },
      });
      if (res.count === 0) return false;
      const payload: OutboxPayload = { workflowJobId: job.id, jobType, queueJobId: `${job.id}-r${attempt}` };
      await tx.outboxEvent.create({ data: { eventType: ENQUEUE_EVENT, payload: { ...payload } } });
      return true;
    });
    if (done) requeued++;
  }
  return { requeued, failed };
}
