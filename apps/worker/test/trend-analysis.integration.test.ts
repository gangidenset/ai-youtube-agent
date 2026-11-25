import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@aya/db";
import type { TrendAnalysis, TrendTopic } from "@aya/orchestrator";
import { MockClaudeProvider } from "@aya/providers";
import { enqueueJobOnce, JobRunner } from "@aya/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trendAnalysisHandler } from "../src/jobs/trend-analysis";
import { createMockClaude } from "../src/mock-claude";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

const topic = (overrides: Partial<TrendTopic> = {}): TrendTopic => ({
  topic: "AI副業の始め方",
  trend_type: "RISING",
  evidence_video_ids: [],
  audience_needs: ["初心者でも始められる方法を知りたい"],
  title_patterns: ["〇〇3選"],
  hook_patterns: ["知らないと損"],
  structure_patterns: ["結論→理由→CTA"],
  differentiation: ["実際の作業画面を見せる"],
  competition_level: "MEDIUM",
  novelty: 0.6,
  demand: 0.8,
  risks: ["収入を約束する表現は避ける"],
  uncertainty_note: "期間が短い",
  ...overrides,
});

describe.runIf(databaseUrl)("trend_analysis job (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const testId = randomUUID();
  let channelId = "";

  beforeAll(async () => {
    channelId = (
      await prisma.channel.create({
        data: { name: `trend-${testId}`, settings: { create: { genre: "AI副業" } } },
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
    await prisma.$disconnect();
  });

  /** トレンド分析の直前の状態（市場分析済み）を作る */
  async function prepareRun() {
    const run = await prisma.researchRun.create({
      data: { channelId, state: "TREND_ANALYSIS", keywords: ["AI副業"], params: { lookbackDays: 7 } },
    });
    const fetchedAt = new Date();
    await prisma.competitorVideo.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        researchRunId: run.id,
        youtubeVideoId: `vid-${i}`,
        title: `動画 ${i}`,
        channelYoutubeId: `ch-${i % 5}`,
        channelTitle: `チャンネル ${i % 5}`,
        channelSubscribers: BigInt(1000 * (i + 1)),
        publishedAt: new Date(fetchedAt.getTime() - (10 + i * 7) * 3_600_000),
        durationSec: 40,
        isShortEstimated: true,
        viewCount: BigInt(100_000 - i * 4000),
        likeCount: BigInt(3000),
        commentCount: BigInt(50),
        fetchedAt,
        ageHours: 10 + i * 7,
        viewsPerHour: (100_000 - i * 4000) / (10 + i * 7),
        viewsPerSubscriber: (100_000 - i * 4000) / (1000 * (i + 1)),
        likeRate: 3000 / (100_000 - i * 4000),
        commentRate: 50 / (100_000 - i * 4000),
      })),
    });
    const { job } = await enqueueJobOnce(prisma, {
      jobType: "trend_analysis",
      idempotencyKey: `test:${testId}:${run.id}`,
      input: { researchRunId: run.id },
      channelId,
      researchRunId: run.id,
    });
    return { run, job };
  }

  it("scores each topic from real evidence, saves trends and moves to idea generation", async () => {
    const claude = new MockClaudeProvider({
      trend_analysis: (): TrendAnalysis => ({
        market_summary: "AI副業の入門系が伸びています",
        topics: [
          topic({ evidence_video_ids: ["vid-0", "vid-1", "vid-2", "vid-3", "vid-unknown"] }),
          topic({
            topic: "古いテーマ",
            trend_type: "EVERGREEN",
            evidence_video_ids: ["vid-17", "vid-18", "vid-19"],
            novelty: 0.1,
            demand: 0.2,
          }),
          topic({ topic: "根拠なし", evidence_video_ids: ["not-in-data"] }),
        ],
      }),
    });
    const { run, job } = await prepareRun();
    expect(
      await new JobRunner(prisma, { trend_analysis: trendAnalysisHandler({ prisma, claude }) }).run(job.id),
    ).toEqual({
      status: "SUCCEEDED",
    });

    const trends = await prisma.marketTrend.findMany({
      where: { researchRunId: run.id },
      orderBy: { trendScore: "desc" },
    });
    // 根拠を確認できないテーマは保存しない
    expect(trends.map((t) => t.topic)).toEqual(["AI副業の始め方", "古いテーマ"]);
    const [top, low] = trends;
    expect(top?.evidenceVideoIds).toEqual(["vid-0", "vid-1", "vid-2", "vid-3"]);
    expect(top?.trendScore).toBeGreaterThan(low?.trendScore ?? 100);
    expect(top?.uncertainty).toMatch(/^MEDIUM: 根拠の動画が 4 本/);
    expect(top?.scoreBreakdown).toMatchObject({
      claude: { novelty: 0.6, demand: 0.8 },
      dataUsed: { evidenceVideos: 4, populationVideos: 20, lookbackHours: 168 },
    });

    expect((await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe(
      "IDEA_GENERATION",
    );
    const next = await prisma.workflowJob.findUniqueOrThrow({
      where: { idempotencyKey: `generate_idea:${run.id}` },
    });
    expect(next.status).toBe("QUEUED");
  });

  it("asks once to rewrite overclaims and fails if they remain", async () => {
    let calls = 0;
    const claude = new MockClaudeProvider({
      trend_analysis: (task): TrendAnalysis => {
        calls++;
        const fixed = task.prompt.includes("断定的な表現");
        return {
          market_summary: fixed ? "伸びる傾向があります" : "このテーマは必ずバズる",
          topics: [topic({ evidence_video_ids: ["vid-0", "vid-1", "vid-2"] })],
        };
      },
    });
    const ok = await prepareRun();
    await new JobRunner(prisma, { trend_analysis: trendAnalysisHandler({ prisma, claude }) }).run(ok.job.id);
    expect(calls).toBe(2);
    expect((await prisma.researchRun.findUniqueOrThrow({ where: { id: ok.run.id } })).state).toBe(
      "IDEA_GENERATION",
    );

    const stubborn = new MockClaudeProvider({
      trend_analysis: (): TrendAnalysis => ({
        market_summary: "絶対に伸びます",
        topics: [topic({ evidence_video_ids: ["vid-0"] })],
      }),
    });
    const bad = await prepareRun();
    const result = await new JobRunner(prisma, {
      trend_analysis: trendAnalysisHandler({ prisma, claude: stubborn }),
    }).run(bad.job.id);
    expect(result).toEqual({ status: "FAILED", code: "OVERCLAIM" });
    expect(await prisma.marketTrend.count({ where: { researchRunId: bad.run.id } })).toBe(0);
  });

  it("works end to end with the built-in mock Claude", async () => {
    const { run, job } = await prepareRun();
    await new JobRunner(prisma, {
      trend_analysis: trendAnalysisHandler({ prisma, claude: createMockClaude() }),
    }).run(job.id);
    expect(await prisma.marketTrend.count({ where: { researchRunId: run.id } })).toBe(2);
  });
});
