import type { PrismaClient, WorkflowJob } from "@aya/db";
import { UnrecoverableError } from "bullmq";
import { isJobType, type JobType } from "./jobs";
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  errorCodeOf,
  errorMessageOf,
  NonRetryableError,
  RetryLaterError,
  type RetryPolicy,
} from "./retry";

export interface JobContext {
  job: WorkflowJob;
  input: Record<string, unknown>;
  /** 長い処理の途中で呼ぶと、止まっていないことを記録できる（定期的にも自動で記録する） */
  heartbeat: () => Promise<void>;
}

export interface JobOutcome {
  outputRef?: string;
  /** このジョブで使った外部 API の費用（USD）。明細は ai_costs に別途記録する */
  costUsd?: number;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome | void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface RunnerOptions {
  retryPolicy?: RetryPolicy;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  random?: () => number;
}

export type RunResult =
  | { status: "SUCCEEDED" }
  | { status: "SKIPPED"; reason: string }
  | { status: "RETRY"; delayMs: number }
  | { status: "FAILED"; code: string };

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * workflow_jobs の 1 行を実行する。
 * - QUEUED のときだけ RUNNING にできる（二重実行の防止）。終わったジョブは何もしない（冪等）
 * - 完了・失敗の書き込みは「自分が取得したときの retry_count」と一致する場合だけ行う。
 *   reaper が再投入した後に、止まっていた古い実行が遅れて終わっても結果を上書きしない
 * - 実行中は heartbeat_at を定期的に更新する
 */
export class JobRunner {
  private readonly policy: RetryPolicy;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly handlers: JobHandlers,
    private readonly options: RunnerOptions = {},
  ) {
    this.policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.now = options.now ?? (() => new Date());
  }

  async run(workflowJobId: string): Promise<RunResult> {
    const job = await this.prisma.workflowJob.findUnique({ where: { id: workflowJobId } });
    if (!job) return { status: "SKIPPED", reason: "NOT_FOUND" };
    if (job.status !== "QUEUED") return { status: "SKIPPED", reason: job.status };

    const startedAt = this.now();
    const claimed = await this.prisma.workflowJob.updateMany({
      where: { id: job.id, status: "QUEUED", retryCount: job.retryCount },
      data: { status: "RUNNING", startedAt, heartbeatAt: startedAt, nextRunAt: null },
    });
    if (claimed.count === 0) return { status: "SKIPPED", reason: "CLAIMED_ELSEWHERE" };

    const owned = { id: job.id, status: "RUNNING" as const, retryCount: job.retryCount };
    const heartbeat = async () => {
      await this.prisma.workflowJob.updateMany({ where: owned, data: { heartbeatAt: this.now() } });
    };
    const timer = setInterval(
      () => void heartbeat().catch(() => undefined),
      this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );

    try {
      const handler = isJobType(job.jobType) ? this.handlers[job.jobType] : undefined;
      if (!handler)
        throw new NonRetryableError("NO_HANDLER", `ジョブ ${job.jobType} の処理が登録されていません`);

      const outcome = await handler({
        job: { ...job, status: "RUNNING", startedAt },
        input: (job.input as Record<string, unknown> | null) ?? {},
        heartbeat,
      });
      await this.prisma.workflowJob.updateMany({
        where: owned,
        data: {
          status: "SUCCEEDED",
          completedAt: this.now(),
          errorCode: null,
          errorMessage: null,
          ...(outcome?.outputRef ? { outputRef: outcome.outputRef } : {}),
          ...(outcome?.costUsd !== undefined ? { costUsd: { increment: outcome.costUsd } } : {}),
        },
      });
      return { status: "SUCCEEDED" };
    } catch (err) {
      const attempt = job.retryCount + 1;
      const retryable = !(err instanceof NonRetryableError) && attempt < job.maxAttempts;
      const common = { errorCode: errorCodeOf(err), errorMessage: errorMessageOf(err) };
      if (!retryable) {
        await this.prisma.workflowJob.updateMany({
          where: owned,
          data: { ...common, status: "FAILED", completedAt: this.now() },
        });
        return { status: "FAILED", code: common.errorCode };
      }
      const delayMs = computeBackoffMs(attempt, this.policy, this.options.random);
      await this.prisma.workflowJob.updateMany({
        where: owned,
        data: {
          ...common,
          status: "QUEUED",
          retryCount: attempt,
          nextRunAt: new Date(this.now().getTime() + delayMs),
        },
      });
      return { status: "RETRY", delayMs };
    } finally {
      clearInterval(timer);
    }
  }

  /** BullMQ の Worker に渡す処理。結果をキューが理解できる形（例外）に変換する。 */
  processor() {
    return async (bullJob: { data: { workflowJobId: string } }) => {
      const result = await this.run(bullJob.data.workflowJobId);
      if (result.status === "RETRY") throw new RetryLaterError("retry scheduled", result.delayMs);
      if (result.status === "FAILED") throw new UnrecoverableError(result.code);
      return result;
    };
  }
}

/** BullMQ の settings.backoffStrategy。JobRunner が決めた待ち時間をそのまま使う。 */
export function backoffFromError(policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
  return (attemptsMade: number, _type?: string, err?: Error) =>
    err instanceof RetryLaterError ? err.delayMs : computeBackoffMs(attemptsMade, policy);
}
