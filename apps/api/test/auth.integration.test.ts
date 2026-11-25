import { randomUUID } from "node:crypto";
import { createPrismaClient, hashPassword } from "@aya/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireChannelPermission } from "../src/auth/guards";
import { MAX_FAILED_LOGINS } from "../src/auth/login";
import { SESSION_COOKIE } from "../src/auth/plugin";
import { SESSION_IDLE_TTL_MS } from "../src/auth/session";
import { hashToken } from "../src/auth/tokens";
import { buildServer } from "../src/server";
import { APP_ORIGIN, testClock, testConfig } from "./helpers";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

describe.runIf(databaseUrl)("auth (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const runId = randomUUID();
  const password = `password-${runId}`;
  const users = {
    owner: `owner-${runId}@example.com`,
    viewer: `viewer-${runId}@example.com`,
    locked: `locked-${runId}@example.com`,
  };
  let channelId = "";
  let otherChannelId = "";
  let ip = 0;
  /** レート制限（IP ごと）に当たらないよう、リクエストごとに送信元 IP を変える */
  const nextIp = () => `10.0.${Math.floor(++ip / 250)}.${ip % 250}`;

  beforeAll(async () => {
    const passwordHash = await hashPassword(password);
    const [owner, viewer] = await Promise.all(
      [users.owner, users.viewer, users.locked].map((email) =>
        prisma.user.create({ data: { email, displayName: email.split("@")[0] ?? email, passwordHash } }),
      ),
    );
    const channel = await prisma.channel.create({
      data: {
        name: `test-${runId}`,
        members: {
          create: [
            { userId: owner!.id, role: "OWNER" },
            { userId: viewer!.id, role: "VIEWER" },
          ],
        },
      },
    });
    const other = await prisma.channel.create({ data: { name: `other-${runId}` } });
    channelId = channel.id;
    otherChannelId = other.id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: { in: [channelId, otherChannelId] } } });
    await prisma.user.deleteMany({ where: { email: { in: Object.values(users) } } });
    await prisma.$disconnect();
  });

  async function server(clock = testClock()) {
    const app = await buildServer({ config: testConfig(), prisma, now: clock.now });
    // 認可ガードの確認用ルート
    app.get<{ Params: { id: string } }>("/test/channels/:id/admin", async (request) => {
      const { membership } = await requireChannelPermission(
        prisma,
        request,
        request.params.id,
        "channel:admin",
      );
      return { role: membership.role };
    });
    app.get<{ Params: { id: string } }>("/test/channels/:id/read", async (request) => {
      const { membership } = await requireChannelPermission(
        prisma,
        request,
        request.params.id,
        "channel:read",
      );
      return { role: membership.role };
    });
    return app;
  }

  async function login(app: FastifyInstance, email: string, pw = password, remoteAddress = nextIp()) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: APP_ORIGIN },
      remoteAddress,
      payload: { email, password: pw },
    });
  }

  function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error("no session cookie");
    return cookie.value;
  }

  it("rejects wrong passwords with a generic error and audits without the password", async () => {
    const app = await server();
    const res = await login(app, users.owner, "wrong-password-123");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "LOGIN_FAILED" } });
    expect(res.cookies).toEqual([]);

    const unknown = await login(app, `nobody-${runId}@example.com`);
    expect(unknown.json().error.message).toBe(res.json().error.message);

    const log = await prisma.systemLog.findFirstOrThrow({
      where: {
        category: "AUTH",
        message: "login failed: INVALID_CREDENTIALS",
        context: { path: ["email"], equals: users.owner },
      },
    });
    expect(JSON.stringify(log.context)).not.toContain("wrong-password-123");
  });

  it("logs in with an httpOnly session cookie and stores only the token hash", async () => {
    const app = await server();
    const res = await login(app, users.owner);
    expect(res.statusCode).toBe(200);

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie?.secure).toBeFalsy();

    const body = res.json();
    expect(body.user).toMatchObject({ email: users.owner });
    expect(body.user.channels).toEqual([
      expect.objectContaining({
        id: channelId,
        role: "OWNER",
        permissions: expect.arrayContaining(["channel:admin"]),
      }),
    ]);
    expect(typeof body.csrfToken).toBe("string");

    const token = sessionCookie(res);
    const stored = await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(stored.tokenHash).not.toBe(token);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { email: users.owner } })).lastLoginAt,
    ).not.toBeNull();
  });

  it("returns the profile and the same CSRF token from /auth/me", async () => {
    const app = await server();
    const res = await login(app, users.owner);
    const token = sessionCookie(res);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).toBe(res.json().csrfToken);

    const targets = await app.inject({
      method: "GET",
      url: "/api/v1/platform-targets",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(targets.statusCode).toBe(200);
    expect(targets.json().targets).toHaveLength(6);
  });

  it("requires Origin and the CSRF token to log out, then revokes the session", async () => {
    const app = await server();
    const res = await login(app, users.owner);
    const token = sessionCookie(res);
    const cookies = { [SESSION_COOKIE]: token };

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies,
      headers: { origin: APP_ORIGIN },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: "INVALID_CSRF_TOKEN" } });

    const wrongCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies,
      headers: { origin: APP_ORIGIN, "x-csrf-token": "forged" },
    });
    expect(wrongCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies,
      headers: { origin: APP_ORIGIN, "x-csrf-token": res.json().csrfToken },
    });
    expect(ok.statusCode).toBe(204);
    expect(
      (await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } })).revokedAt,
    ).not.toBeNull();

    const after = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies });
    expect(after.statusCode).toBe(401);
  });

  it("issues a new session on every login (session fixation)", async () => {
    const app = await server();
    const first = sessionCookie(await login(app, users.owner));
    const second = sessionCookie(await login(app, users.owner));
    expect(second).not.toBe(first);
  });

  it("limits login attempts to 5 per minute per IP", async () => {
    const app = await server();
    const address = nextIp();
    for (let i = 0; i < 5; i++) {
      expect((await login(app, users.viewer, "wrong-password-123", address)).statusCode).toBe(401);
    }
    const limited = await login(app, users.viewer, password, address);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    await prisma.user.update({ where: { email: users.viewer }, data: { failedLoginCount: 0 } });
  });

  it("locks the account after consecutive failures and unlocks after 15 minutes", async () => {
    const clock = testClock();
    const app = await server(clock);
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await login(app, users.locked, "wrong-password-123");
    }
    const lockedUser = await prisma.user.findUniqueOrThrow({ where: { email: users.locked } });
    expect(lockedUser.lockedUntil).not.toBeNull();

    // 正しいパスワードでもロック中は同じエラー
    const whileLocked = await login(app, users.locked);
    expect(whileLocked.statusCode).toBe(401);
    expect(whileLocked.json()).toMatchObject({ error: { code: "LOGIN_FAILED" } });

    clock.advance(15 * 60 * 1000 + 1000);
    expect((await login(app, users.locked)).statusCode).toBe(200);
  });

  it("expires idle sessions and clears the cookie", async () => {
    const clock = testClock();
    const app = await server(clock);
    const token = sessionCookie(await login(app, users.viewer));
    clock.advance(SESSION_IDLE_TTL_MS + 1000);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.statusCode).toBe(401);
    expect(me.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe("");
  });

  it("checks channel membership and role permissions", async () => {
    const app = await server();
    const owner = { [SESSION_COOKIE]: sessionCookie(await login(app, users.owner)) };
    const viewer = { [SESSION_COOKIE]: sessionCookie(await login(app, users.viewer)) };
    const get = (url: string, cookies: Record<string, string>) => app.inject({ method: "GET", url, cookies });

    expect((await get(`/test/channels/${channelId}/admin`, owner)).statusCode).toBe(200);
    expect((await get(`/test/channels/${channelId}/read`, viewer)).statusCode).toBe(200);
    expect((await get(`/test/channels/${channelId}/admin`, viewer)).statusCode).toBe(403);
    // 所属していないチャンネルは権限に関係なく 403（IDOR 防止）
    expect((await get(`/test/channels/${otherChannelId}/read`, owner)).statusCode).toBe(403);
    expect((await get(`/test/channels/${channelId}/read`, {})).statusCode).toBe(401);
  });
});
