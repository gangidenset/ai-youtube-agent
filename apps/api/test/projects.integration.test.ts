import { randomUUID } from "node:crypto";
import { createPrismaClient, hashPassword } from "@aya/db";
import { saveScriptVersion } from "@aya/orchestrator";
import type { Script } from "@aya/schemas";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/plugin";
import { buildServer } from "../src/server";
import { APP_ORIGIN, testConfig } from "./helpers";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

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

describe.runIf(databaseUrl)("projects API (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const runId = randomUUID();
  const password = `password-${runId}`;
  const emails = {
    editor: `p-editor-${runId}@example.com`,
    viewer: `p-viewer-${runId}@example.com`,
    outsider: `p-outsider-${runId}@example.com`,
  };
  let channelId = "";
  let otherChannelId = "";
  let n = 0;
  let app: FastifyInstance;
  const sessions: Record<string, { cookies: Record<string, string>; csrf: string }> = {};

  beforeAll(async () => {
    const passwordHash = await hashPassword(password);
    const [editor, viewer, outsider] = await Promise.all(
      Object.values(emails).map((email) =>
        prisma.user.create({ data: { email, displayName: email, passwordHash } }),
      ),
    );
    channelId = (
      await prisma.channel.create({
        data: {
          name: `proj-${runId}`,
          members: {
            create: [
              { userId: editor!.id, role: "EDITOR" },
              { userId: viewer!.id, role: "VIEWER" },
            ],
          },
        },
      })
    ).id;
    otherChannelId = (
      await prisma.channel.create({
        data: { name: `proj-other-${runId}`, members: { create: [{ userId: outsider!.id, role: "OWNER" }] } },
      })
    ).id;

    app = await buildServer({ config: testConfig(), prisma });
    for (const [name, email] of Object.entries(emails)) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: APP_ORIGIN },
        remoteAddress: `10.10.0.${Object.keys(sessions).length + 1}`,
        payload: { email, password },
      });
      const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";
      sessions[name] = { cookies: { [SESSION_COOKIE]: token }, csrf: res.json().csrfToken };
    }
  });

  afterAll(async () => {
    const ids = [channelId, otherChannelId];
    const jobs = await prisma.workflowJob.findMany({ where: { channelId: { in: ids } } });
    for (const job of jobs) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
      });
    }
    const projects = await prisma.videoProject.findMany({ where: { channelId: { in: ids } } });
    await prisma.workflowTransition.deleteMany({ where: { entityId: { in: projects.map((p) => p.id) } } });
    await prisma.workflowJob.deleteMany({ where: { channelId: { in: ids } } });
    await prisma.channel.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await prisma.$disconnect();
  });

  async function project(versions: Script[] = [script()]) {
    const p = await prisma.videoProject.create({
      data: { channelId, code: `A-${runId.slice(0, 8)}-${n++}`, state: "SCRIPT_GENERATION" },
    });
    for (const [i, s] of versions.entries()) {
      await prisma.$transaction((tx) =>
        saveScriptVersion(tx, {
          projectId: p.id,
          script: s,
          createdBy: "AI",
          parentVersion: i === 0 ? null : i,
        }),
      );
    }
    return p;
  }

  const get = (who: string, url: string) =>
    app.inject({ method: "GET", url, cookies: sessions[who]?.cookies ?? {} });
  const revise = (
    who: string,
    projectId: string,
    payload: unknown,
    key: string | null = `k-${randomUUID()}`,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/revisions`,
      cookies: sessions[who]?.cookies ?? {},
      headers: {
        origin: APP_ORIGIN,
        "x-csrf-token": sessions[who]?.csrf ?? "",
        ...(key ? { "idempotency-key": key } : {}),
      },
      payload: payload as Record<string, unknown>,
    });

  it("shows the project with its current script to members only", async () => {
    const p = await project();
    const res = await get("viewer", `/api/v1/projects/${p.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      code: p.code,
      currentScriptVersion: 1,
      script: { title: "タイトル" },
      versions: [{ version: 1, createdBy: "AI" }],
      canRevise: false,
    });
    expect((await get("editor", `/api/v1/projects/${p.id}`)).json().canRevise).toBe(true);
    expect((await get("outsider", `/api/v1/projects/${p.id}`)).statusCode).toBe(404);
    expect((await get("editor", `/api/v1/projects/${randomUUID()}`)).statusCode).toBe(404);
  });

  it("returns a version and the diff between two versions", async () => {
    const p = await project([script(), script({ hook: "新フック" })]);
    const v1 = await get("viewer", `/api/v1/projects/${p.id}/scripts/1`);
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ version: 1, content: { hook: "フック" } });
    expect((await get("viewer", `/api/v1/projects/${p.id}/scripts/9`)).statusCode).toBe(404);

    const diff = await get("viewer", `/api/v1/projects/${p.id}/scripts/diff?from=1&to=2`);
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({
      from: 1,
      to: 2,
      unchanged: false,
      fields: [{ field: "hook", before: "フック", after: "新フック" }],
    });
    expect((await get("viewer", `/api/v1/projects/${p.id}/scripts/diff?from=1`)).statusCode).toBe(400);
    expect((await get("outsider", `/api/v1/projects/${p.id}/scripts/diff?from=1&to=2`)).statusCode).toBe(404);
  });

  it("accepts a revision from an editor and records it", async () => {
    const p = await project();
    expect((await revise("editor", p.id, { instruction: "冒頭を強く" }, null)).statusCode).toBe(400);
    expect((await revise("editor", p.id, { instruction: "" })).statusCode).toBe(400);
    expect((await revise("viewer", p.id, { instruction: "冒頭を強く" })).statusCode).toBe(403);
    expect((await revise("outsider", p.id, { instruction: "冒頭を強く" })).statusCode).toBe(404);

    const key = `k-${randomUUID()}`;
    const res = await revise("editor", p.id, { instruction: "冒頭を強く", scope: "SCENES" }, key);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ fromVersion: 1, duplicate: false });
    expect(
      (await revise("editor", p.id, { instruction: "冒頭を強く", scope: "SCENES" }, key)).json(),
    ).toMatchObject({
      revisionId: body.revisionId,
      duplicate: true,
    });
    // 前の修正が終わるまでは次を受け付けない
    const busy = await revise("editor", p.id, { instruction: "もう一つ" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "REVISION_IN_PROGRESS" } });

    const detail = (await get("editor", `/api/v1/projects/${p.id}`)).json();
    expect(detail).toMatchObject({
      working: true,
      canRevise: false,
      revisions: [{ id: body.revisionId, instruction: "冒頭を強く", fromVersion: 1, toVersion: null }],
    });
  });

  it("rejects a revision before the script exists", async () => {
    const p = await project([]);
    const res = await revise("editor", p.id, { instruction: "冒頭を強く" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "NO_SCRIPT" } });
  });
});
