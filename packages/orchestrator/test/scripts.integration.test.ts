import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@aya/db";
import type { Script } from "@aya/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyRevisionScope,
  buildGenerateScriptTask,
  buildReviseScriptTask,
  RevisionError,
  requestRevision,
  saveScriptVersion,
} from "../src";

const script = (overrides: Partial<Script> = {}): Script => ({
  title: "タイトル",
  hook: "フック",
  target: "会社員",
  duration_seconds: 10,
  scenes: [
    {
      scene_number: 1,
      duration: 4,
      visual_prompt: "v1",
      narration: "n1",
      subtitle: "s1",
      sound_effect: "",
      transition: "",
      priority: "CORE",
    },
    {
      scene_number: 2,
      duration: 6,
      visual_prompt: "v2",
      narration: "n2",
      subtitle: "s2",
      sound_effect: "",
      transition: "cut",
      priority: "OPTIONAL",
    },
  ],
  cta: "CTA",
  description: "説明",
  hashtags: ["#a"],
  ...overrides,
});

const channel = { genre: "g", targetAudience: null, tone: null, ngWords: ["禁止語"], brandGuidelines: null };
const idea = {
  title: "t",
  theme: "テーマ",
  target: "会社員",
  hook: "h",
  story: "s",
  durationSec: 10,
  sceneCount: 2,
  cta: "c",
  originalAngle: null,
  differentiation: [],
};

describe("script tasks", () => {
  it("passes NG words in the cached channel block and the idea in the prompt", () => {
    const task = buildGenerateScriptTask({ channel, idea });
    expect(task).toMatchObject({ operation: "generate_script", effort: "high" });
    expect(task.system.every((b) => b.cache)).toBe(true);
    expect(task.system[1]?.text).toContain("禁止語");
    expect(task.prompt).toContain('"duration_sec": 10');
  });

  it("separates the person's instruction from the script", () => {
    const task = buildReviseScriptTask({
      channel,
      idea,
      current: script(),
      instruction: "冒頭を強く",
      scope: "METADATA",
    });
    expect(task.operation).toBe("revise");
    expect(task.prompt).toContain("<instruction>\n冒頭を強く\n</instruction>");
    expect(task.prompt).toContain("title / description / hashtags / cta だけ");
  });

  it("keeps the target and the parts outside the requested scope", () => {
    const changed = script({
      title: "新タイトル",
      target: "別の人",
      hook: "新フック",
      scenes: script().scenes.map((s) => ({ ...s, narration: "変更" })),
    });
    const meta = applyRevisionScope(script(), changed, "METADATA");
    expect(meta).toMatchObject({ title: "新タイトル", target: "会社員", hook: "フック" });
    expect(meta.scenes).toEqual(script().scenes);
    const scenes = applyRevisionScope(script(), changed, "SCENES");
    expect(scenes).toMatchObject({ title: "タイトル", hook: "新フック", target: "会社員" });
    expect(scenes.scenes[0]?.narration).toBe("変更");
    expect(applyRevisionScope(script(), changed, "SCRIPT")).toMatchObject({
      title: "新タイトル",
      target: "会社員",
    });
  });
});

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

describe.runIf(databaseUrl)("script versions and revision requests (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const testId = randomUUID();
  let channelId = "";
  let userId = "";
  let n = 0;

  beforeAll(async () => {
    channelId = (await prisma.channel.create({ data: { name: `scripts-${testId}` } })).id;
    userId = (
      await prisma.user.create({
        data: { email: `scripts-${testId}@example.com`, displayName: "u", passwordHash: "x" },
      })
    ).id;
  });

  afterAll(async () => {
    const projects = await prisma.videoProject.findMany({ where: { channelId } });
    const jobs = await prisma.workflowJob.findMany({ where: { channelId } });
    for (const job of jobs) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
      });
    }
    await prisma.workflowTransition.deleteMany({ where: { entityId: { in: projects.map((p) => p.id) } } });
    await prisma.workflowJob.deleteMany({ where: { channelId } });
    await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function project(
    state: "SCRIPT_GENERATION" | "WAITING_APPROVAL" | "PLATFORM_OPTIMIZATION",
    withScript = true,
  ) {
    const p = await prisma.videoProject.create({
      data: { channelId, code: `S-${testId.slice(0, 8)}-${n++}`, state },
    });
    if (withScript) {
      await prisma.$transaction((tx) =>
        saveScriptVersion(tx, { projectId: p.id, script: script(), createdBy: "AI" }),
      );
    }
    return p;
  }

  const request = (projectId: string, key = randomUUID()) =>
    requestRevision(prisma, {
      projectId,
      instruction: "直して",
      scope: "SCRIPT",
      actorId: userId,
      idempotencyKey: key,
    });

  it("numbers versions and stores scenes", async () => {
    const p = await project("SCRIPT_GENERATION");
    const v2 = await prisma.$transaction((tx) =>
      saveScriptVersion(tx, {
        projectId: p.id,
        script: script({ title: "2" }),
        createdBy: "USER",
        parentVersion: 1,
      }),
    );
    expect(v2.version).toBe(2);
    expect((await prisma.videoProject.findUniqueOrThrow({ where: { id: p.id } })).currentScriptVersion).toBe(
      2,
    );
    expect(await prisma.videoScene.count({ where: { scriptId: v2.scriptId } })).toBe(2);
  });

  it("rejects revisions without a script, in other states, or while one is running", async () => {
    await expect(request((await project("SCRIPT_GENERATION", false)).id)).rejects.toMatchObject({
      code: "NO_SCRIPT",
    });
    await expect(request((await project("PLATFORM_OPTIMIZATION")).id)).rejects.toBeInstanceOf(RevisionError);
    await expect(request((await project("PLATFORM_OPTIMIZATION")).id)).rejects.toMatchObject({
      code: "NOT_REVISABLE",
    });

    const p = await project("SCRIPT_GENERATION");
    const first = await request(p.id);
    expect(first.duplicate).toBe(false);
    await expect(request(p.id)).rejects.toMatchObject({ code: "REVISION_IN_PROGRESS" });
    await expect(request(randomUUID())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("moves a project waiting for approval to REVISING", async () => {
    const p = await project("WAITING_APPROVAL");
    const res = await request(p.id);
    expect((await prisma.videoProject.findUniqueOrThrow({ where: { id: p.id } })).state).toBe("REVISING");
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job).toMatchObject({ jobType: "revise", projectId: p.id });
    expect(job.input).toMatchObject({ revisionId: res.revisionId, scope: "SCRIPT" });
  });
});
