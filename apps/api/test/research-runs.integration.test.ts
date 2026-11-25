import { randomUUID } from "node:crypto";
import { createPrismaClient, hashPassword } from "@aya/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/plugin";
import { buildServer } from "../src/server";
import { APP_ORIGIN, testConfig } from "./helpers";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

describe.runIf(databaseUrl)("research runs API (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const runId = randomUUID();
  const password = `password-${runId}`;
  const emails = { editor: `editor-${runId}@example.com`, viewer: `viewer-${runId}@example.com` };
  let channelId = "";
  let otherChannelId = "";
  let app: FastifyInstance;
  const sessions: Record<string, { cookies: Record<string, string>; csrf: string }> = {};

  beforeAll(async () => {
    const passwordHash = await hashPassword(password);
    const editor = await prisma.user.create({
      data: { email: emails.editor, displayName: "E", passwordHash },
    });
    const viewer = await prisma.user.create({
      data: { email: emails.viewer, displayName: "V", passwordHash },
    });
    channelId = (
      await prisma.channel.create({
        data: {
          name: `rr-${runId}`,
          settings: { create: { genre: "AI副業", subGenres: ["ChatGPT"] } },
          members: {
            create: [
              { userId: editor.id, role: "EDITOR" },
              { userId: viewer.id, role: "VIEWER" },
            ],
          },
        },
      })
    ).id;
    otherChannelId = (await prisma.channel.create({ data: { name: `rr-other-${runId}` } })).id;

    app = await buildServer({ config: testConfig(), prisma });
    for (const [name, email] of Object.entries(emails)) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: APP_ORIGIN },
        remoteAddress: `10.9.0.${Object.keys(sessions).length + 1}`,
        payload: { email, password },
      });
      const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";
      sessions[name] = { cookies: { [SESSION_COOKIE]: token }, csrf: res.json().csrfToken };
    }
  });

  afterAll(async () => {
    const jobs = await prisma.workflowJob.findMany({
      where: { channelId: { in: [channelId, otherChannelId] } },
    });
    for (const job of jobs) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["workflowJobId"], equals: job.id } },
      });
    }
    const runs = await prisma.researchRun.findMany({
      where: { channelId: { in: [channelId, otherChannelId] } },
    });
    const projects = await prisma.videoProject.findMany({
      where: { channelId: { in: [channelId, otherChannelId] } },
    });
    await prisma.workflowTransition.deleteMany({
      where: { entityId: { in: [...runs.map((r) => r.id), ...projects.map((p) => p.id)] } },
    });
    await prisma.workflowJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
    await prisma.channel.deleteMany({ where: { id: { in: [channelId, otherChannelId] } } });
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await prisma.$disconnect();
  });

  const post = (who: string, channel: string, payload: unknown, key?: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/channels/${channel}/research-runs`,
      cookies: sessions[who]?.cookies ?? {},
      headers: {
        origin: APP_ORIGIN,
        "x-csrf-token": sessions[who]?.csrf ?? "",
        ...(key ? { "idempotency-key": key } : {}),
      },
      payload: payload as Record<string, unknown>,
    });

  it("requires an Idempotency-Key", async () => {
    const res = await post("editor", channelId, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
  });

  it("starts a run with keywords from channel settings and returns the same run for the same key", async () => {
    const key = `req-${randomUUID()}`;
    const first = await post("editor", channelId, {}, key);
    expect(first.statusCode).toBe(202);
    const { researchRunId, jobId } = first.json();

    const run = await prisma.researchRun.findUniqueOrThrow({ where: { id: researchRunId } });
    expect(run).toMatchObject({ state: "MARKET_RESEARCH", keywords: ["AI副業", "ChatGPT"], region: "JP" });
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ jobType: "market_research", status: "QUEUED", researchRunId });
    expect(
      await prisma.outboxEvent.count({ where: { payload: { path: ["workflowJobId"], equals: jobId } } }),
    ).toBe(1);

    const again = await post("editor", channelId, { keywords: ["別のキーワード"] }, key);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ researchRunId, jobId });
    expect(await prisma.researchRun.count({ where: { channelId } })).toBe(1);
  });

  it("validates the body", async () => {
    const res = await post("editor", channelId, { keywords: [], lookbackDays: 90 }, `req-${randomUUID()}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("requires edit permission and channel membership", async () => {
    expect((await post("viewer", channelId, {}, `req-${randomUUID()}`)).statusCode).toBe(403);
    expect((await post("editor", otherChannelId, {}, `req-${randomUUID()}`)).statusCode).toBe(403);
  });

  it("shows run status to members and hides it from others", async () => {
    const key = `req-${randomUUID()}`;
    const { researchRunId } = (await post("editor", channelId, { keywords: ["AI"] }, key)).json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/research-runs/${researchRunId}`,
      cookies: sessions["viewer"]?.cookies ?? {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: researchRunId,
      state: "MARKET_RESEARCH",
      keywords: ["AI"],
      jobs: [expect.objectContaining({ jobType: "market_research", status: "QUEUED" })],
      competitorVideos: { total: 0, shortsEstimated: 0, topByViewsPerHour: [] },
    });

    // 所属していないチャンネルの分析は存在も見せない
    const otherRun = await prisma.researchRun.create({
      data: { channelId: otherChannelId, keywords: ["x"] },
    });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/research-runs/${otherRun.id}`,
      cookies: sessions["viewer"]?.cookies ?? {},
    });
    expect(hidden.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/research-runs/not-a-uuid",
          cookies: sessions["viewer"]?.cookies ?? {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lists trends by score with breakdown, uncertainty, evidence and a non-guarantee notice", async () => {
    const run = await prisma.researchRun.create({
      data: { channelId, state: "IDEA_GENERATION", keywords: ["AI"] },
    });
    await prisma.competitorVideo.create({
      data: {
        researchRunId: run.id,
        youtubeVideoId: "yt-1",
        title: "動画 1",
        channelYoutubeId: "c1",
        publishedAt: new Date("2026-11-24T00:00:00Z"),
        viewCount: BigInt(5000),
        fetchedAt: new Date("2026-11-25T00:00:00Z"),
        ageHours: 24,
        viewsPerHour: 208.3,
      },
    });
    const base = {
      researchRunId: run.id,
      trendType: "RISING" as const,
      scoreBreakdown: { points: { velocity: 20 } },
      uncertainty: "MEDIUM: 根拠の動画が少ない",
      risks: ["r"],
    };
    await prisma.marketTrend.createMany({
      data: [
        { ...base, topic: "低い", trendScore: 40, evidenceVideoIds: [] },
        { ...base, topic: "高い", trendScore: 82.5, evidenceVideoIds: ["yt-1", "missing"] },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/research-runs/${run.id}/trends`,
      cookies: sessions["viewer"]?.cookies ?? {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notice).toContain("保証するものではありません");
    expect(body.trends.map((t: { topic: string }) => t.topic)).toEqual(["高い", "低い"]);
    expect(body.trends[0]).toMatchObject({
      trendScore: 82.5,
      uncertainty: "MEDIUM: 根拠の動画が少ない",
      scoreBreakdown: { points: { velocity: 20 } },
      evidence: [{ youtubeVideoId: "yt-1", title: "動画 1", viewCount: 5000 }],
    });

    const otherRun = await prisma.researchRun.create({
      data: { channelId: otherChannelId, keywords: ["x"] },
    });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/research-runs/${otherRun.id}/trends`,
      cookies: sessions["viewer"]?.cookies ?? {},
    });
    expect(hidden.statusCode).toBe(404);
  });

  async function waitingRunWithIdeas(channel: string) {
    const run = await prisma.researchRun.create({
      data: { channelId: channel, state: "WAITING_IDEA_SELECTION", keywords: ["AI"] },
    });
    const ideas = [];
    for (const [label, originality] of [
      ["A", 80],
      ["B", 40],
    ] as const) {
      ideas.push(
        await prisma.videoIdea.create({
          data: {
            researchRunId: run.id,
            channelId: channel,
            label,
            title: `企画 ${label}`,
            theme: "t",
            target: "t",
            hook: "h",
            story: "s",
            durationSec: 30,
            sceneCount: 6,
            cta: "c",
            trendScore: 70,
            originalityScore: originality,
            copyRisk: "LOW",
          },
        }),
      );
    }
    return { run, ideas };
  }

  const select = (who: { cookies: Record<string, string>; csrf: string }, ideaId: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/ideas/${ideaId}/select`,
      cookies: who.cookies,
      headers: { origin: APP_ORIGIN, "x-csrf-token": who.csrf },
    });

  it("lists ideas with auto-selection eligibility and lets editors select and swap", async () => {
    const { run, ideas } = await waitingRunWithIdeas(channelId);
    const viewer = sessions["viewer"]!;
    const editor = sessions["editor"]!;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/research-runs/${run.id}/ideas`,
      cookies: viewer.cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      canSelect: true,
      project: null,
      ideas: [
        { label: "A", autoSelectable: true, notAutoSelectableReason: null },
        { label: "B", autoSelectable: false, notAutoSelectableReason: "Originality 60 未満" },
      ],
    });

    expect((await select(viewer, ideas[0]!.id)).statusCode).toBe(403);
    const chosen = await select(editor, ideas[0]!.id);
    expect(chosen.statusCode).toBe(202);
    expect(chosen.json()).toMatchObject({ swapped: false });
    expect(chosen.json().projectCode).toMatch(/^VP-\d{4}$/);

    // 台本生成の前なら、別の案に差し替えられる
    const swapped = await select(editor, ideas[1]!.id);
    expect(swapped.statusCode).toBe(202);
    expect(swapped.json()).toMatchObject({ swapped: true, projectId: chosen.json().projectId });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/research-runs/${run.id}/ideas`,
      cookies: viewer.cookies,
    });
    expect(after.json()).toMatchObject({ canSelect: true, project: { ideaId: ideas[1]!.id } });

    // 他のチャンネルの企画は存在も見せない
    const other = await waitingRunWithIdeas(otherChannelId);
    expect((await select(editor, other.ideas[0]!.id)).statusCode).toBe(404);
  });

  it("returns 409 when the run is not waiting for a selection", async () => {
    const { run, ideas } = await waitingRunWithIdeas(channelId);
    await prisma.researchRun.update({ where: { id: run.id }, data: { state: "IDEA_GENERATION" } });
    const res = await select(sessions["editor"]!, ideas[0]!.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "NOT_SELECTABLE" } });
  });

  it("lists research runs of a channel, newest first", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/research-runs`,
      cookies: sessions["viewer"]!.cookies,
    });
    expect(res.statusCode).toBe(200);
    const runs = res.json().researchRuns as { createdAt: string }[];
    expect(runs.length).toBeGreaterThan(0);
    expect([...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(runs);
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${otherChannelId}/research-runs`,
      cookies: sessions["viewer"]!.cookies,
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
