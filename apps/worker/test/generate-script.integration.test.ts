import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@aya/db";
import { requestRevision, type ReviseScriptOutput } from "@aya/orchestrator";
import { MockClaudeProvider } from "@aya/providers";
import { enqueueJobOnce, JobRunner } from "@aya/queue";
import { type Script, ScriptSchema } from "@aya/schemas";
import { afterAll, describe, expect, it } from "vitest";
import { generateScriptHandler } from "../src/jobs/generate-script";
import { reviseHandler } from "../src/jobs/revise";
import { createMockClaude } from "../src/mock-claude";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

const script = (overrides: Partial<Script> = {}): Script => ({
  title: "通勤 10 分の英語練習",
  hook: "通勤時間、ムダにしていませんか？",
  target: "Claude が勝手に変えたターゲット",
  duration_seconds: 20,
  scenes: [
    {
      scene_number: 1,
      duration: 5,
      visual_prompt: "満員電車でスマホを見る人",
      narration: "通勤時間、ムダにしていませんか？",
      subtitle: "通勤時間、ムダにしてない？",
      sound_effect: "",
      transition: "",
      priority: "CORE",
    },
    {
      scene_number: 2,
      duration: 10,
      visual_prompt: "イヤホンで音声を聞く人",
      narration: "1 日 10 分のシャドーイングから始めましょう",
      subtitle: "1 日 10 分のシャドーイング",
      sound_effect: "",
      transition: "cut",
      priority: "OPTIONAL",
    },
    {
      scene_number: 3,
      duration: 5,
      visual_prompt: "笑顔で電車を降りる人",
      narration: "続きはプロフィールから",
      subtitle: "続きはプロフィールへ",
      sound_effect: "",
      transition: "cut",
      priority: "CORE",
    },
  ],
  cta: "フォローしてね",
  description: "通勤時間でできる英語の練習法",
  hashtags: ["#英語", "#通勤"],
  ...overrides,
});

describe.runIf(databaseUrl)("generate_script / revise jobs (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const testId = randomUUID();
  const channels: string[] = [];
  let users: string[] = [];

  afterAll(async () => {
    const projects = await prisma.videoProject.findMany({ where: { channelId: { in: channels } } });
    const jobs = await prisma.workflowJob.findMany({ where: { channelId: { in: channels } } });
    for (const job of jobs) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
      });
    }
    await prisma.workflowTransition.deleteMany({ where: { entityId: { in: projects.map((p) => p.id) } } });
    await prisma.workflowJob.deleteMany({ where: { channelId: { in: channels } } });
    await prisma.channel.deleteMany({ where: { id: { in: channels } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  async function prepare(
    opts: { ngWords?: string[]; state?: "SCRIPT_GENERATION" | "WAITING_APPROVAL" } = {},
  ) {
    const n = channels.length;
    const channel = await prisma.channel.create({
      data: {
        name: `script-${testId}-${n}`,
        settings: { create: { genre: "英語学習", ngWords: opts.ngWords ?? [] } },
      },
    });
    channels.push(channel.id);
    const run = await prisma.researchRun.create({
      data: { channelId: channel.id, state: "SCRIPT_GENERATION", keywords: ["英語"] },
    });
    const idea = await prisma.videoIdea.create({
      data: {
        researchRunId: run.id,
        channelId: channel.id,
        label: "A",
        title: "通勤 10 分の英語練習",
        theme: "通勤時間の英語学習",
        target: "20 代の会社員",
        hook: "通勤時間、ムダにしていませんか？",
        story: "問題提起 → 方法 → まとめ",
        durationSec: 20,
        sceneCount: 3,
        cta: "フォローしてね",
        trendScore: 70,
        originalityScore: 80,
        copyRisk: "LOW",
        policyRisk: "LOW",
        scoreRationale: { originalAngle: "体験談", differentiation: ["画面を見せる"] },
        status: "SELECTED",
      },
    });
    const project = await prisma.videoProject.create({
      data: {
        channelId: channel.id,
        ideaId: idea.id,
        code: `T-${testId.slice(0, 8)}-${n}`,
        state: opts.state ?? "SCRIPT_GENERATION",
      },
    });
    const { job } = await enqueueJobOnce(prisma, {
      jobType: "generate_script",
      idempotencyKey: `test:${testId}:${project.id}`,
      input: { projectId: project.id, ideaId: idea.id },
      channelId: channel.id,
      projectId: project.id,
    });
    return { channel, idea, project, job };
  }

  async function user() {
    const u = await prisma.user.create({
      data: { email: `script-${randomUUID()}@example.com`, displayName: "担当者", passwordHash: "x" },
    });
    users = [...users, u.id];
    return u.id;
  }

  const runner = (claude: MockClaudeProvider) =>
    new JobRunner(prisma, {
      generate_script: generateScriptHandler({ prisma, claude }),
      revise: reviseHandler({ prisma, claude }),
    });

  it("saves the master script as version 1 with its scenes, keeping the idea's target", async () => {
    const { project, job } = await prepare();
    const claude = new MockClaudeProvider({ generate_script: () => script() });
    expect(await runner(claude).run(job.id)).toEqual({ status: "SUCCEEDED" });

    const fresh = await prisma.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(fresh).toMatchObject({ state: "SCRIPT_GENERATION", currentScriptVersion: 1 });
    const v1 = await prisma.script.findUniqueOrThrow({
      where: { projectId_version: { projectId: project.id, version: 1 } },
      include: { scenes: { orderBy: { sceneNumber: "asc" } } },
    });
    expect(v1.createdBy).toBe("AI");
    expect(ScriptSchema.parse(v1.content).target).toBe("20 代の会社員");
    expect(v1.scenes.map((s) => [s.sceneNumber, s.durationSec, s.priority])).toEqual([
      [1, 5, "CORE"],
      [2, 10, "OPTIONAL"],
      [3, 5, "CORE"],
    ]);

    // もう一度実行しても版は増えない（冪等）
    const again = await enqueueJobOnce(prisma, {
      jobType: "generate_script",
      idempotencyKey: `test:${testId}:${project.id}:again`,
      input: { projectId: project.id },
      channelId: project.channelId,
      projectId: project.id,
    });
    await runner(claude).run(again.job.id);
    expect(await prisma.script.count({ where: { projectId: project.id } })).toBe(1);
    expect(claude.calls).toHaveLength(1);
  });

  it("asks once to rewrite NG words and fails if they remain", async () => {
    const ok = await prepare({ ngWords: ["満員電車"] });
    let calls = 0;
    const claude = new MockClaudeProvider({
      generate_script: () => {
        calls++;
        if (calls === 1) return script();
        const s = script();
        return { ...s, scenes: s.scenes.map((sc) => ({ ...sc, visual_prompt: "朝の通勤風景" })) };
      },
    });
    expect(await runner(claude).run(ok.job.id)).toEqual({ status: "SUCCEEDED" });
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1]?.prompt).toContain("NG ワード（満員電車）");

    const ng = await prepare({ ngWords: ["満員電車"] });
    const stubborn = new MockClaudeProvider({ generate_script: () => script() });
    expect(await runner(stubborn).run(ng.job.id)).toEqual({ status: "FAILED", code: "SCRIPT_CHECK_FAILED" });
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: ng.job.id } });
    expect(job.errorCode).toBe("SCRIPT_CHECK_FAILED");
    expect(await prisma.script.count({ where: { projectId: ng.project.id } })).toBe(0);
  });

  it("does nothing when the idea was swapped after the job was queued", async () => {
    const { project, job } = await prepare();
    const other = await prisma.videoIdea.create({
      data: {
        researchRunId: (await prisma.videoIdea.findUniqueOrThrow({ where: { id: project.ideaId ?? "" } }))
          .researchRunId,
        channelId: project.channelId,
        label: "B",
        title: "別の企画",
        theme: "t",
        target: "t",
        hook: "h",
        story: "s",
        durationSec: 20,
        sceneCount: 3,
        cta: "c",
        trendScore: 60,
        originalityScore: 80,
        copyRisk: "LOW",
        policyRisk: "LOW",
        scoreRationale: {},
      },
    });
    await prisma.videoProject.update({ where: { id: project.id }, data: { ideaId: other.id } });
    const claude = new MockClaudeProvider({ generate_script: () => script() });
    expect(await runner(claude).run(job.id)).toEqual({ status: "SUCCEEDED" });
    expect(claude.calls).toHaveLength(0);
    expect(await prisma.script.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("revises into a new version, records the diff and keeps unchanged scenes", async () => {
    const { project, job } = await prepare();
    const claude = createMockClaude();
    claude.register("generate_script", () => script());
    await runner(claude).run(job.id);

    const actorId = await user();
    const req = await requestRevision(prisma, {
      projectId: project.id,
      instruction: "冒頭をもっと強く",
      scope: "SCENES",
      actorId,
      idempotencyKey: `rev-${testId}-1`,
    });
    expect(req).toMatchObject({ fromVersion: 1, duplicate: false });
    // 同じキーの再送は同じ修正を返す
    const dup = await requestRevision(prisma, {
      projectId: project.id,
      instruction: "冒頭をもっと強く",
      scope: "SCENES",
      actorId,
      idempotencyKey: `rev-${testId}-1`,
    });
    expect(dup).toMatchObject({ revisionId: req.revisionId, duplicate: true });

    expect(await runner(claude).run(req.jobId)).toEqual({ status: "SUCCEEDED" });
    const fresh = await prisma.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(fresh).toMatchObject({ currentScriptVersion: 2, state: "SCRIPT_GENERATION" });
    const v2 = await prisma.script.findUniqueOrThrow({
      where: { projectId_version: { projectId: project.id, version: 2 } },
    });
    expect(v2).toMatchObject({ parentVersion: 1, revisionId: req.revisionId });
    const content = ScriptSchema.parse(v2.content);
    expect(content.hook).toContain("冒頭をもっと強く");
    expect(content.scenes[1]).toEqual(script().scenes[1]);
    expect(content.target).toBe("20 代の会社員");

    const revision = await prisma.projectRevision.findUniqueOrThrow({ where: { id: req.revisionId } });
    expect(revision).toMatchObject({ fromVersion: 1, toVersion: 2, requestedBy: actorId });
    expect(revision.diffSummary).toMatchObject({
      requestedScope: "SCENES",
      changedSceneNumbers: [1],
      changedFields: ["hook"],
    });
  });

  it("limits a METADATA revision to the title, description, hashtags and CTA", async () => {
    const { project, job } = await prepare({ state: "SCRIPT_GENERATION" });
    const claude = new MockClaudeProvider({
      generate_script: () => script(),
      revise: (): ReviseScriptOutput => ({
        scope: "SCRIPT",
        change_summary: "タイトルとシーンを変えました",
        new_script: script({
          title: "10 分で変わる通勤英語",
          scenes: script().scenes.map((s) => ({ ...s, narration: "勝手に変えたナレーション" })),
        }),
      }),
    });
    await runner(claude).run(job.id);
    // 承認待ちからの修正は REVISING を経て SCRIPT_GENERATION に戻る
    await prisma.videoProject.update({ where: { id: project.id }, data: { state: "WAITING_APPROVAL" } });
    const req = await requestRevision(prisma, {
      projectId: project.id,
      instruction: "タイトルだけ変えて",
      scope: "METADATA",
      actorId: await user(),
      idempotencyKey: `rev-${testId}-meta`,
    });
    expect((await prisma.videoProject.findUniqueOrThrow({ where: { id: project.id } })).state).toBe(
      "REVISING",
    );
    await runner(claude).run(req.jobId);

    const v2 = ScriptSchema.parse(
      (
        await prisma.script.findUniqueOrThrow({
          where: { projectId_version: { projectId: project.id, version: 2 } },
        })
      ).content,
    );
    expect(v2.title).toBe("10 分で変わる通勤英語");
    expect(v2.scenes).toEqual(script().scenes);
    const transitions = await prisma.workflowTransition.findMany({
      where: { entityId: project.id },
      orderBy: { createdAt: "asc" },
    });
    expect(transitions.map((t) => [t.fromState, t.toState])).toEqual([
      ["WAITING_APPROVAL", "REVISING"],
      ["REVISING", "SCRIPT_GENERATION"],
    ]);
  });
});
