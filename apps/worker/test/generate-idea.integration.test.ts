import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@aya/db";
import type { Idea, IdeaSet } from "@aya/orchestrator";
import { MockClaudeProvider } from "@aya/providers";
import { enqueueJobOnce, JobRunner } from "@aya/queue";
import { afterAll, describe, expect, it } from "vitest";
import { generateIdeaHandler } from "../src/jobs/generate-idea";
import { createMockClaude } from "../src/mock-claude";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

const idea = (label: "A" | "B" | "C", trendId: string, overrides: Partial<Idea> = {}): Idea => ({
  label,
  trend_id: trendId,
  title: `オリジナル企画 ${label}：通勤時間でできる練習法`,
  theme: "テーマ",
  target: "会社員",
  hook: `${label} の問いかけ`,
  story: "問題提起 → 方法 → まとめ",
  duration_sec: 30,
  scene_count: 6,
  cta: "フォローしてね",
  common_patterns: ["冒頭で問いかける"],
  original_angle: "体験談",
  differentiation: ["画面を見せる", "数字で比較"],
  similar_videos: [],
  policy_risk: "LOW",
  risks: [],
  ...overrides,
});

describe.runIf(databaseUrl)("generate_idea job (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const testId = randomUUID();
  const channels: string[] = [];

  afterAll(async () => {
    const projects = await prisma.videoProject.findMany({ where: { channelId: { in: channels } } });
    const runs = await prisma.researchRun.findMany({ where: { channelId: { in: channels } } });
    const jobs = await prisma.workflowJob.findMany({ where: { channelId: { in: channels } } });
    for (const job of jobs) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
      });
    }
    await prisma.workflowTransition.deleteMany({
      where: { entityId: { in: [...projects.map((p) => p.id), ...runs.map((r) => r.id)] } },
    });
    await prisma.workflowJob.deleteMany({ where: { channelId: { in: channels } } });
    await prisma.channel.deleteMany({ where: { id: { in: channels } } });
    await prisma.$disconnect();
  });

  async function prepare(mode: "AUTO_TOP" | "MANUAL" = "AUTO_TOP") {
    const channel = await prisma.channel.create({
      data: {
        name: `idea-${testId}-${channels.length}`,
        settings: { create: { genre: "AI副業", ideaSelectionMode: mode } },
      },
    });
    channels.push(channel.id);
    const run = await prisma.researchRun.create({
      data: { channelId: channel.id, state: "IDEA_GENERATION", keywords: ["AI副業"] },
    });
    await prisma.competitorVideo.create({
      data: {
        researchRunId: run.id,
        youtubeVideoId: "hot-1",
        title: "AI副業で月5万円稼ぐ方法3選",
        channelYoutubeId: "c",
        publishedAt: new Date(),
        viewCount: BigInt(100_000),
        fetchedAt: new Date(),
        ageHours: 10,
        viewsPerHour: 10_000,
      },
    });
    const high = await prisma.marketTrend.create({
      data: {
        researchRunId: run.id,
        topic: "AI副業入門",
        trendType: "RISING",
        trendScore: 85,
        scoreBreakdown: {},
        evidenceVideoIds: ["hot-1"],
      },
    });
    const low = await prisma.marketTrend.create({
      data: {
        researchRunId: run.id,
        topic: "節約術",
        trendType: "EVERGREEN",
        trendScore: 50,
        scoreBreakdown: {},
        evidenceVideoIds: [],
      },
    });
    const { job } = await enqueueJobOnce(prisma, {
      jobType: "generate_idea",
      idempotencyKey: `test:${testId}:${run.id}`,
      input: { researchRunId: run.id },
      channelId: channel.id,
      researchRunId: run.id,
    });
    return { run, job, high, low };
  }

  const run = (claude: MockClaudeProvider, jobId: string) =>
    new JobRunner(prisma, { generate_idea: generateIdeaHandler({ prisma, claude }) }).run(jobId);

  it("scores ideas and auto-selects the best eligible one into a new project", async () => {
    const { run: research, job, high, low } = await prepare();
    const claude = new MockClaudeProvider({
      generate_idea: (): IdeaSet => ({
        ideas: [
          // 高トレンドだが既存動画のタイトルとほぼ同じ → Originality が低く対象外
          idea("A", high.id, {
            title: "AI副業で月5万円稼ぐ方法3選",
            hook: "AI副業で月5万円稼ぐ方法3選",
            differentiation: [],
            similar_videos: [{ video_id: "hot-1", similarity: 0.9, note: "ほぼ同じ構成" }],
          }),
          idea("B", high.id),
          idea("C", low.id),
        ],
      }),
    });
    expect(await run(claude, job.id)).toEqual({ status: "SUCCEEDED" });

    const ideas = await prisma.videoIdea.findMany({
      where: { researchRunId: research.id },
      orderBy: { label: "asc" },
    });
    expect(ideas.map((i) => [i.label, i.trendScore, i.status])).toEqual([
      ["A", 85, "PROPOSED"],
      ["B", 85, "SELECTED"],
      ["C", 50, "PROPOSED"],
    ]);
    expect(ideas[0]?.originalityScore).toBeLessThan(60);
    expect(ideas[0]?.copyRisk).toBe("HIGH");
    expect(ideas[1]?.originalityScore).toBeGreaterThanOrEqual(60);

    const project = await prisma.videoProject.findFirstOrThrow({ where: { ideaId: ideas[1]?.id } });
    expect(project.state).toBe("SCRIPT_GENERATION");
    expect((await prisma.researchRun.findUniqueOrThrow({ where: { id: research.id } })).state).toBe(
      "SCRIPT_GENERATION",
    );

    const decision = await prisma.aiDecision.findFirstOrThrow({ where: { researchRunId: research.id } });
    expect(decision).toMatchObject({ nextAction: "GENERATE_SCRIPT", accepted: true, model: "rule:auto_top" });
    expect(decision.reason).toContain("B 案");
    const transitions = await prisma.workflowTransition.findMany({ where: { entityId: project.id } });
    expect(transitions[0]).toMatchObject({ trigger: "SYSTEM", decisionId: decision.id });
  });

  it("waits for a person when no idea qualifies for automatic selection", async () => {
    const { run: research, job, high } = await prepare();
    const claude = new MockClaudeProvider({
      generate_idea: (): IdeaSet => ({
        ideas: [
          idea("A", high.id, { policy_risk: "HIGH" }),
          idea("B", high.id, { policy_risk: "HIGH" }),
          idea("C", high.id, { policy_risk: "HIGH" }),
        ],
      }),
    });
    await run(claude, job.id);
    expect((await prisma.researchRun.findUniqueOrThrow({ where: { id: research.id } })).state).toBe(
      "WAITING_IDEA_SELECTION",
    );
    expect(await prisma.videoProject.count({ where: { idea: { researchRunId: research.id } } })).toBe(0);
    const decision = await prisma.aiDecision.findFirstOrThrow({ where: { researchRunId: research.id } });
    expect(decision).toMatchObject({ nextAction: "ESCALATE_TO_HUMAN", accepted: false });
    expect(decision.reason).toContain("ポリシーリスクが高い");
  });

  it("leaves the choice to a person in MANUAL mode", async () => {
    const { run: research, job } = await prepare("MANUAL");
    await run(createMockClaude(), job.id);
    expect((await prisma.researchRun.findUniqueOrThrow({ where: { id: research.id } })).state).toBe(
      "WAITING_IDEA_SELECTION",
    );
    expect(await prisma.videoIdea.count({ where: { researchRunId: research.id, status: "PROPOSED" } })).toBe(
      3,
    );
    expect(await prisma.aiDecision.count({ where: { researchRunId: research.id } })).toBe(0);
  });
});
