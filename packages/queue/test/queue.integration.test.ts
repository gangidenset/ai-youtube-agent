import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@aya/db";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyTransition,
  enqueueJob,
  enqueueJobOnce,
  type JobHandlers,
  JobRunner,
  NonRetryableError,
  OutboxRelay,
  type QueueRuntime,
  reapStalledJobs,
  startQueueRuntime,
  TransitionError,
} from "../src";

// 実際の PostgreSQL と Redis に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
const redisUrl = process.env["REDIS_URL"];
if (process.env["CI"] && (!databaseUrl || !redisUrl))
  throw new Error("CI では DATABASE_URL と REDIS_URL が必要です");

const fastRetry = { baseMs: 20, factor: 2, maxMs: 100 };

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.runIf(databaseUrl && redisUrl)("queue (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const runId = randomUUID();
  const key = (name: string) => `test:${runId}:${name}`;
  let runtime: QueueRuntime | undefined;

  beforeAll(async () => {
    // 他のテストが残した未送信の outbox を、このテストの中継が拾わないようにする
    await prisma.outboxEvent.updateMany({ where: { publishedAt: null }, data: { publishedAt: new Date() } });
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  afterAll(async () => {
    const jobs = await prisma.workflowJob.findMany({
      where: { idempotencyKey: { startsWith: `test:${runId}:` } },
    });
    const ids = jobs.map((j) => j.id);
    for (const id of ids) {
      await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["workflowJobId"], equals: id } } });
    }
    await prisma.workflowJob.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  function start(handlers: JobHandlers) {
    runtime = startQueueRuntime({
      prisma,
      redisUrl: redisUrl ?? "",
      handlers,
      prefix: `aya-test-${runId}`,
      retryPolicy: fastRetry,
      relayIntervalMs: 50,
      reaperIntervalMs: 60_000,
    });
    return runtime;
  }

  const statusOf = (id: string) => prisma.workflowJob.findUniqueOrThrow({ where: { id } });

  it("creates one job and one outbox event per idempotency key", async () => {
    const req = { jobType: "generate_script" as const, idempotencyKey: key("idem"), input: { a: 1 } };
    const first = await enqueueJobOnce(prisma, req);
    const second = await enqueueJobOnce(prisma, req);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(first.job).toMatchObject({ status: "QUEUED", maxAttempts: 3, retryCount: 0 });
    const events = await prisma.outboxEvent.count({
      where: { payload: { path: ["workflowJobId"], equals: first.job.id } },
    });
    expect(events).toBe(1);
    // 後続のテストで処理されないよう送信済みにしておく
    await prisma.outboxEvent.updateMany({
      where: { payload: { path: ["workflowJobId"], equals: first.job.id } },
      data: { publishedAt: new Date() },
    });
  });

  it("relays the outbox to BullMQ and records success with cost", async () => {
    const seen: unknown[] = [];
    start({
      generate_script: async (ctx) => {
        seen.push(ctx.input);
        return { outputRef: "script:v1", costUsd: 0.14 };
      },
    });
    const { job } = await enqueueJobOnce(prisma, {
      jobType: "generate_script",
      idempotencyKey: key("success"),
      input: { ideaId: "x" },
    });
    const done = await waitFor(
      () => statusOf(job.id),
      (j) => j.status === "SUCCEEDED",
    );
    expect(done).toMatchObject({ outputRef: "script:v1", retryCount: 0, errorMessage: null });
    expect(done.costUsd.toString()).toBe("0.14");
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(seen).toEqual([{ ideaId: "x" }]);
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { payload: { path: ["workflowJobId"], equals: job.id } },
    });
    expect(event.publishedAt).not.toBeNull();
  });

  it("retries retryable failures with backoff and then succeeds", async () => {
    let calls = 0;
    start({
      trend_analysis: async () => {
        calls++;
        if (calls === 1) throw new Error("upstream 503");
        return {};
      },
    });
    const { job } = await enqueueJobOnce(prisma, { jobType: "trend_analysis", idempotencyKey: key("retry") });
    const done = await waitFor(
      () => statusOf(job.id),
      (j) => j.status === "SUCCEEDED",
    );
    expect(calls).toBe(2);
    expect(done.retryCount).toBe(1);
  });

  it("fails immediately on non-retryable errors and after max attempts otherwise", async () => {
    let calls = 0;
    start({
      generate_idea: async () => {
        calls++;
        throw new NonRetryableError("INVALID_INPUT", "企画の入力が不正です");
      },
      revise: async () => {
        throw new Error("always failing");
      },
    });
    const bad = await enqueueJobOnce(prisma, { jobType: "generate_idea", idempotencyKey: key("nonretry") });
    const failed = await waitFor(
      () => statusOf(bad.job.id),
      (j) => j.status === "FAILED",
    );
    expect(failed).toMatchObject({ errorCode: "INVALID_INPUT", retryCount: 0 });
    expect(calls).toBe(1);

    const flaky = await enqueueJobOnce(prisma, { jobType: "revise", idempotencyKey: key("exhaust") });
    const exhausted = await waitFor(
      () => statusOf(flaky.job.id),
      (j) => j.status === "FAILED",
    );
    expect(exhausted).toMatchObject({ retryCount: 2, errorMessage: "always failing" });
  });

  it("fails jobs without a registered handler", async () => {
    start({});
    const { job } = await enqueueJobOnce(prisma, { jobType: "learn", idempotencyKey: key("nohandler") });
    const failed = await waitFor(
      () => statusOf(job.id),
      (j) => j.status === "FAILED",
    );
    expect(failed.errorCode).toBe("NO_HANDLER");
  });

  it("does not run a job twice when the outbox event is relayed again", async () => {
    let calls = 0;
    const handlers: JobHandlers = {
      quality_check: async () => {
        calls++;
        return {};
      },
    };
    const { job } = await enqueueJobOnce(prisma, { jobType: "quality_check", idempotencyKey: key("dup") });
    const runner = new JobRunner(prisma, handlers);
    expect(await runner.run(job.id)).toEqual({ status: "SUCCEEDED" });
    expect(await runner.run(job.id)).toEqual({ status: "SKIPPED", reason: "SUCCEEDED" });
    expect(calls).toBe(1);
    await prisma.outboxEvent.updateMany({
      where: { payload: { path: ["workflowJobId"], equals: job.id } },
      data: { publishedAt: new Date() },
    });
  });

  it("reaps stalled jobs and ignores late results from the stalled run", async () => {
    const { job } = await enqueueJobOnce(prisma, {
      jobType: "trend_analysis",
      idempotencyKey: key("stalled"),
    });
    await prisma.outboxEvent.updateMany({
      where: { payload: { path: ["workflowJobId"], equals: job.id } },
      data: { publishedAt: new Date() },
    });

    // 1 回目の実行が途中で止まった状態を作る
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const runner = new JobRunner(prisma, {
      trend_analysis: () => blocked.then(() => ({ outputRef: "stale" })),
    });
    const running = runner.run(job.id);
    await waitFor(
      () => statusOf(job.id),
      (j) => j.status === "RUNNING",
    );
    await prisma.workflowJob.update({
      where: { id: job.id },
      data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const reaped = await reapStalledJobs(prisma);
    expect(reaped.requeued).toBeGreaterThanOrEqual(1);
    const requeued = await statusOf(job.id);
    expect(requeued).toMatchObject({ status: "QUEUED", retryCount: 1, errorCode: "STALLED" });
    const events = await prisma.outboxEvent.findMany({
      where: { payload: { path: ["workflowJobId"], equals: job.id }, publishedAt: null },
    });
    expect(events.map((e) => (e.payload as { queueJobId: string }).queueJobId)).toEqual([`${job.id}-r1`]);

    // 止まっていた実行が遅れて終わっても、再投入後の状態を上書きしない
    release();
    await running;
    expect(await statusOf(job.id)).toMatchObject({ status: "QUEUED", outputRef: null });
    await prisma.outboxEvent.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: { publishedAt: new Date() },
    });
  });

  it("fails stalled jobs that used all attempts", async () => {
    const { job } = await enqueueJobOnce(prisma, { jobType: "learn", idempotencyKey: key("stalled-final") });
    await prisma.workflowJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", retryCount: 2, heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    await reapStalledJobs(prisma);
    expect(await statusOf(job.id)).toMatchObject({ status: "FAILED", errorCode: "STALLED" });
    await prisma.outboxEvent.updateMany({
      where: { payload: { path: ["workflowJobId"], equals: job.id } },
      data: { publishedAt: new Date() },
    });
  });

  it("delays jobs scheduled for later (runAt)", async () => {
    const prefix = `aya-test-${runId}-delay`;
    const queue = new Queue("youtube", {
      connection: { url: redisUrl ?? "", maxRetriesPerRequest: null },
      prefix,
    });
    try {
      const runAt = new Date(Date.now() + 60 * 60_000);
      const { job } = await enqueueJobOnce(prisma, {
        jobType: "market_research",
        idempotencyKey: key("delayed"),
        runAt,
      });
      expect(job.nextRunAt?.getTime()).toBe(runAt.getTime());
      await new OutboxRelay(prisma, new Map([["youtube", queue]])).pollOnce();
      const queued = await queue.getJob(job.id);
      expect(await queued?.getState()).toBe("delayed");
      expect(queued?.opts.delay).toBeGreaterThan(59 * 60_000);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("keeps relayed jobs unique in BullMQ even if the relay runs twice", async () => {
    const prefix = `aya-test-${runId}-relay`;
    const queue = new Queue("llm", {
      connection: { url: redisUrl ?? "", maxRetriesPerRequest: null },
      prefix,
    });
    try {
      const { job } = await enqueueJobOnce(prisma, {
        jobType: "generate_script",
        idempotencyKey: key("relay"),
      });
      const relay = new OutboxRelay(prisma, new Map([["llm", queue]]));
      await relay.pollOnce();
      // 送信済みの印が付かなかった（例: 直後にプロセスが落ちた）場合を再現して、もう一度中継する
      await prisma.outboxEvent.updateMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
        data: { publishedAt: null },
      });
      await relay.pollOnce();
      const queued = await queue.getJobs(["waiting", "prioritized", "delayed"]);
      expect(queued.filter((j) => j.data.workflowJobId === job.id)).toHaveLength(1);
      expect((await queue.getJob(job.id))?.data).toEqual({ workflowJobId: job.id });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

describe.runIf(databaseUrl)("applyTransition (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  let channelId = "";
  let projectId = "";

  beforeAll(async () => {
    const channel = await prisma.channel.create({ data: { name: `transition-${randomUUID()}` } });
    const project = await prisma.videoProject.create({
      data: { channelId: channel.id, code: `VP-T-${randomUUID().slice(0, 8)}`, state: "SCRIPT_GENERATION" },
    });
    channelId = channel.id;
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.workflowTransition.deleteMany({ where: { entityId: projectId } });
    await prisma.workflowJob.deleteMany({ where: { projectId } });
    await prisma.channel.delete({ where: { id: channelId } });
    await prisma.$disconnect();
  });

  it("moves the state, records history and enqueues the next job atomically", async () => {
    await prisma.$transaction(async (tx) => {
      await applyTransition(tx, {
        entityType: "PROJECT",
        entityId: projectId,
        from: "SCRIPT_GENERATION",
        to: "PLATFORM_OPTIMIZATION",
        trigger: "JOB",
      });
      await enqueueJob(tx, {
        jobType: "optimize_platforms",
        idempotencyKey: `opt:${projectId}:v1`,
        projectId,
      });
    });
    expect((await prisma.videoProject.findUniqueOrThrow({ where: { id: projectId } })).state).toBe(
      "PLATFORM_OPTIMIZATION",
    );
    expect(await prisma.workflowTransition.count({ where: { entityId: projectId } })).toBe(1);
    const job = await prisma.workflowJob.findUniqueOrThrow({
      where: { idempotencyKey: `opt:${projectId}:v1` },
    });
    await prisma.outboxEvent.updateMany({
      where: { payload: { path: ["workflowJobId"], equals: job.id } },
      data: { publishedAt: new Date() },
    });
  });

  it("rejects transitions outside the table and rolls back", async () => {
    await expect(
      prisma.$transaction((tx) =>
        applyTransition(tx, {
          entityType: "PROJECT",
          entityId: projectId,
          from: "PLATFORM_OPTIMIZATION",
          to: "PUBLISHING",
          trigger: "AI_DECISION",
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("detects concurrent updates (state changed by someone else)", async () => {
    const err = await prisma
      .$transaction((tx) =>
        applyTransition(tx, {
          entityType: "PROJECT",
          entityId: projectId,
          from: "SCRIPT_GENERATION",
          to: "PLATFORM_OPTIMIZATION",
          trigger: "JOB",
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect(err).toMatchObject({ code: "CONFLICT" });
  });

  it("remembers where to resume after pausing", async () => {
    await prisma.$transaction((tx) =>
      applyTransition(tx, {
        entityType: "PROJECT",
        entityId: projectId,
        from: "PLATFORM_OPTIMIZATION",
        to: "PAUSED",
        trigger: "SYSTEM",
        pausedReason: "BUDGET_DAILY",
      }),
    );
    expect(await prisma.videoProject.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      state: "PAUSED",
      resumeState: "PLATFORM_OPTIMIZATION",
      pausedReason: "BUDGET_DAILY",
    });
    await prisma.$transaction((tx) =>
      applyTransition(tx, {
        entityType: "PROJECT",
        entityId: projectId,
        from: "PAUSED",
        to: "PLATFORM_OPTIMIZATION",
        resumeTo: "PLATFORM_OPTIMIZATION",
        trigger: "USER",
      }),
    );
    expect(await prisma.videoProject.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      state: "PLATFORM_OPTIMIZATION",
      resumeState: null,
      pausedReason: null,
    });
  });
});
