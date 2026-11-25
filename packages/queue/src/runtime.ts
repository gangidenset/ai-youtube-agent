import type { PrismaClient } from "@aya/db";
import { Queue, Worker } from "bullmq";
import { QUEUE_NAMES, QUEUE_SETTINGS, type QueueName } from "./jobs";
import { OutboxRelay } from "./outbox";
import { reapStalledJobs } from "./reaper";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry";
import { backoffFromError, type JobHandlers, JobRunner } from "./runner";

export interface QueueRuntimeOptions {
  prisma: PrismaClient;
  redisUrl: string;
  handlers: JobHandlers;
  /** Redis キーの接頭辞（テストや環境ごとの分離に使う） */
  prefix?: string;
  queues?: readonly QueueName[];
  retryPolicy?: RetryPolicy;
  heartbeatIntervalMs?: number;
  relayIntervalMs?: number;
  reaperIntervalMs?: number;
  staleAfterMs?: number;
  log?: (message: string) => void;
}

export interface QueueRuntime {
  queues: ReadonlyMap<QueueName, Queue>;
  runner: JobRunner;
  relay: OutboxRelay;
  close: () => Promise<void>;
}

/** 前回の実行が終わってから次を始める定期実行（処理が長引いても重ならない） */
function every(intervalMs: number, task: () => Promise<unknown>, log?: (m: string) => void) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async () => {
    try {
      await task();
    } catch (err) {
      log?.(err instanceof Error ? err.message : String(err));
    }
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
  };
  timer = setTimeout(() => void loop(), 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** ワーカープロセスで動かす一式（キュー・ワーカー・outbox の中継・止まったジョブの回収）。 */
export function startQueueRuntime(options: QueueRuntimeOptions): QueueRuntime {
  const connection = { url: options.redisUrl, maxRetriesPerRequest: null };
  const prefix = options.prefix ?? "aya";
  const names = options.queues ?? QUEUE_NAMES;
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;

  const queues = new Map(names.map((name) => [name, new Queue(name, { connection, prefix })] as const));
  const runner = new JobRunner(options.prisma, options.handlers, {
    retryPolicy,
    ...(options.heartbeatIntervalMs ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
  });
  const workers = names.map((name) => {
    const settings = QUEUE_SETTINGS[name];
    const worker = new Worker(name, runner.processor(), {
      connection,
      prefix,
      concurrency: settings.concurrency,
      ...(settings.limiter
        ? { limiter: { max: settings.limiter.max, duration: settings.limiter.durationMs } }
        : {}),
      settings: { backoffStrategy: backoffFromError(retryPolicy) },
    });
    worker.on("error", (err) => options.log?.(`worker ${name}: ${err.message}`));
    return worker;
  });

  const relay = new OutboxRelay(options.prisma, queues, options.log ? { log: options.log } : {});
  const stopRelay = every(options.relayIntervalMs ?? 1_000, () => relay.pollOnce(), options.log);
  const stopReaper = every(
    options.reaperIntervalMs ?? 60_000,
    () => reapStalledJobs(options.prisma, options.staleAfterMs ? { staleAfterMs: options.staleAfterMs } : {}),
    options.log,
  );

  return {
    queues,
    runner,
    relay,
    close: async () => {
      stopRelay();
      stopReaper();
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}
