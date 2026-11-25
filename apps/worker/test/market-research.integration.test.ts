import { randomUUID } from "node:crypto";
import { createPrismaClient, PrismaQuotaStore } from "@aya/db";
import { type CacheStore, GuardedYouTubeProvider, MockYouTubeProvider } from "@aya/providers";
import { enqueueJobOnce, JobRunner } from "@aya/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marketResearchHandler } from "../src/jobs/market-research";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

function memoryCache(): CacheStore {
  const store = new Map<string, string>();
  return { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) };
}

describe.runIf(databaseUrl)("market_research job (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const testId = randomUUID();
  const now = new Date("2026-11-25T12:00:00Z");
  let channelId = "";

  beforeAll(async () => {
    channelId = (
      await prisma.channel.create({
        data: { name: `market-${testId}`, settings: { create: { genre: "AI副業" } } },
      })
    ).id;
  });

  afterAll(async () => {
    const runs = await prisma.researchRun.findMany({ where: { channelId } });
    const jobs = await prisma.workflowJob.findMany({ where: { channelId } });
    for (const job of jobs) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
      });
    }
    await prisma.workflowTransition.deleteMany({ where: { entityId: { in: runs.map((r) => r.id) } } });
    await prisma.workflowJob.deleteMany({ where: { channelId } });
    await prisma.channel.delete({ where: { id: channelId } });
    await prisma.apiQuotaUsage.deleteMany({ where: { quotaBucket: { startsWith: `test:${testId}` } } });
    await prisma.$disconnect();
  });

  function setup(dailyLimit: number, at = now) {
    const quota = new PrismaQuotaStore(prisma, {
      provider: "youtube",
      bucket: `test:${testId}:${dailyLimit}`,
      dailyLimit,
      now: () => at,
    });
    const cache = memoryCache();
    const handler = marketResearchHandler({
      prisma,
      now: () => at,
      createYouTube: () => new GuardedYouTubeProvider(new MockYouTubeProvider(() => at), quota, cache),
    });
    return new JobRunner(prisma, { market_research: handler });
  }

  async function startRun(keywords: string[]) {
    const run = await prisma.researchRun.create({
      data: { channelId, state: "MARKET_RESEARCH", keywords, region: "JP", params: { lookbackDays: 7 } },
    });
    const { job } = await enqueueJobOnce(prisma, {
      jobType: "market_research",
      idempotencyKey: `test:${testId}:${run.id}`,
      input: { researchRunId: run.id },
      channelId,
      researchRunId: run.id,
    });
    return { run, job };
  }

  it("collects videos with derived metrics and moves to trend analysis", async () => {
    const runner = setup(10_000);
    const { run, job } = await startRun(["AI副業", "ChatGPT 使い方"]);
    expect(await runner.run(job.id)).toEqual({ status: "SUCCEEDED" });

    const after = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.state).toBe("TREND_ANALYSIS");
    expect(after.startedAt).not.toBeNull();
    // 検索 2 回（200）+ 人気動画（1）+ 動画詳細（1）+ チャンネル（1）
    expect(after.quotaUsed).toBe(203);

    const videos = await prisma.competitorVideo.findMany({ where: { researchRunId: run.id } });
    expect(videos).toHaveLength(50); // 人気 10 + 検索 20 × 2
    const sample = videos[0]!;
    expect(sample.ageHours).toBeGreaterThanOrEqual(1);
    expect(sample.viewsPerHour).toBeCloseTo(Number(sample.viewCount) / sample.ageHours, 0);
    expect(videos.some((v) => v.channelSubscribers === null && v.viewsPerSubscriber === null)).toBe(true);
    expect(videos.every((v) => v.isShortEstimated === (v.durationSec !== null && v.durationSec <= 180))).toBe(
      true,
    );

    const next = await prisma.workflowJob.findUniqueOrThrow({
      where: { idempotencyKey: `trend_analysis:${run.id}` },
    });
    expect(next).toMatchObject({ jobType: "trend_analysis", status: "QUEUED", researchRunId: run.id });
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).outputRef).toBe(
      "competitor_videos:50",
    );
    const transitions = await prisma.workflowTransition.findMany({ where: { entityId: run.id } });
    expect(transitions.map((t) => [t.fromState, t.toState])).toEqual([["MARKET_RESEARCH", "TREND_ANALYSIS"]]);
  });

  it("pauses when the quota runs out and resumes after Pacific midnight", async () => {
    // 予備 1,600 を除くと 150 units しか使えない → 検索 2 回目でクォータ不足
    const { run, job } = await startRun(["AI副業", "副業 在宅"]);
    expect(await setup(1750).run(job.id)).toEqual({ status: "SUCCEEDED" });

    const paused = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(paused).toMatchObject({ state: "PAUSED", quotaUsed: 100 });
    expect(await prisma.competitorVideo.count({ where: { researchRunId: run.id } })).toBe(0);
    const resume = await prisma.workflowJob.findFirstOrThrow({
      where: { researchRunId: run.id, idempotencyKey: { contains: ":resume:" } },
    });
    expect(resume.nextRunAt?.toISOString()).toBe("2026-11-26T08:00:00.000Z");

    // 翌日（太平洋時間）に再開する。同じ上限でも日付が変わればまた 150 units 使える（足りなければ再び延期）
    const nextDay = new Date("2026-11-26T09:00:00Z");
    expect(await setup(1750, nextDay).run(resume.id)).toEqual({ status: "SUCCEEDED" });
    expect((await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe("PAUSED");
    expect(
      await prisma.workflowJob.count({
        where: { researchRunId: run.id, idempotencyKey: { contains: ":resume:2026-11-27" } },
      }),
    ).toBe(1);

    // 上限に余裕がある日なら最後まで進む
    const later = await prisma.workflowJob.findFirstOrThrow({
      where: { researchRunId: run.id, idempotencyKey: { contains: ":resume:2026-11-27" } },
    });
    expect(await setup(10_000, new Date("2026-11-27T09:00:00Z")).run(later.id)).toEqual({
      status: "SUCCEEDED",
    });
    const resumed = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(resumed.state).toBe("TREND_ANALYSIS");
  });

  it("does nothing when the run has already moved on", async () => {
    const { run, job } = await startRun(["AI"]);
    await prisma.researchRun.update({ where: { id: run.id }, data: { state: "TREND_ANALYSIS" } });
    expect(await setup(10_000).run(job.id)).toEqual({ status: "SUCCEEDED" });
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).outputRef).toBe(
      "skipped:TREND_ANALYSIS",
    );
  });
});
