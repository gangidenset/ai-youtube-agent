import { createPrismaClient } from "@aya/db";
import { afterAll, describe, expect, it } from "vitest";
import { sessionCookieOptions } from "../src/auth/plugin";
import { buildServer } from "../src/server";
import { testConfig } from "./helpers";

// DB に触れない部分のテスト（Prisma Client はクエリするまで接続しない）
describe("api server", () => {
  const prisma = createPrismaClient("postgresql://unused:unused@127.0.0.1:1/unused");
  afterAll(() => prisma.$disconnect());

  it("responds to health checks with security headers", async () => {
    const app = await buildServer({ config: testConfig(), prisma });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("returns the error format for unknown routes", async () => {
    const app = await buildServer({ config: testConfig(), prisma });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("requires login for platform targets", async () => {
    const app = await buildServer({ config: testConfig(), prisma });
    const res = await app.inject({ method: "GET", url: "/api/v1/platform-targets" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("rejects state-changing requests from other origins before anything else", async () => {
    const app = await buildServer({ config: testConfig(), prisma });
    for (const headers of [{}, { origin: "https://evil.example" }, { referer: "https://evil.example/x" }]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "INVALID_ORIGIN" } });
    }
  });

  it("uses Secure cookies only in production", () => {
    expect(sessionCookieOptions(true)).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
