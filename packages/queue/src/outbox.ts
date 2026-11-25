import type { PrismaClient } from "@aya/db";
import type { Queue } from "bullmq";
import { ENQUEUE_EVENT, type OutboxPayload } from "./enqueue";
import { isJobType, jobDefinition, type QueueName } from "./jobs";

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * outbox_events に溜まった「投入予定」をキュー（BullMQ）へ送る。
 * - 複数プロセスで動かしても同じ行を二重に処理しない（FOR UPDATE SKIP LOCKED）
 * - キューへの追加後にプロセスが落ちても、同じ queueJobId での再追加はキュー側で無視される。
 *   それでも二重に実行されそうな場合は、ワーカーが workflow_jobs の状態を見て弾く
 */
export class OutboxRelay {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queues: ReadonlyMap<QueueName, Queue>,
    private readonly options: { batchSize?: number; log?: (message: string) => void } = {},
  ) {}

  async pollOnce(): Promise<RelayResult> {
    const batchSize = this.options.batchSize ?? 50;
    return this.prisma.$transaction(async (tx) => {
      const events = await tx.$queryRaw<{ id: string; event_type: string; payload: unknown }[]>`
        SELECT id, event_type, payload FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;

      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          if (event.event_type !== ENQUEUE_EVENT)
            throw new Error(`unknown outbox event: ${event.event_type}`);
          const payload = event.payload as OutboxPayload;
          if (!isJobType(payload.jobType)) throw new Error(`unknown job type: ${payload.jobType}`);
          const def = jobDefinition(payload.jobType);
          const queue = this.queues.get(def.queue);
          if (!queue) throw new Error(`queue not configured: ${def.queue}`);

          const job = await tx.workflowJob.findUnique({ where: { id: payload.workflowJobId } });
          await queue.add(
            payload.jobType,
            { workflowJobId: payload.workflowJobId },
            {
              jobId: payload.queueJobId,
              // 試行回数は workflow_jobs 側で管理する（キュー側は上限まで再試行を許すだけ）
              attempts: def.maxAttempts,
              backoff: { type: "custom" },
              priority: Math.max(0, Math.min(2_097_152, job?.priority ?? 0)),
              removeOnComplete: 1000,
              removeOnFail: 5000,
            },
          );
          await tx.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
          published++;
        } catch (err) {
          failed++;
          await tx.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } });
          this.options.log?.(
            `outbox relay failed for ${event.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { published, failed };
    });
  }
}
