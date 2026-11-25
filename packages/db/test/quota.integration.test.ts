import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, PrismaQuotaStore } from "../src";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

describe.runIf(databaseUrl)("PrismaQuotaStore (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const bucket = `test:${randomUUID()}`;
  const store = (now = new Date("2026-11-25T12:00:00Z"), dailyLimit = 2000) =>
    new PrismaQuotaStore(prisma, { provider: "youtube", bucket, dailyLimit, now: () => now });

  afterAll(async () => {
    await prisma.apiQuotaUsage.deleteMany({ where: { quotaBucket: bucket } });
    await prisma.$disconnect();
  });

  it("reserves within the limit while keeping one upload in reserve", async () => {
    const quota = store();
    expect(await quota.remaining()).toBe(400); // 2000 - 1600
    expect(await quota.reserve(300)).toEqual({ ok: true });
    expect(await quota.reserve(100)).toEqual({ ok: true });
    expect(await quota.reserve(1)).toEqual({ ok: false, remaining: 0 });
    const row = await prisma.apiQuotaUsage.findFirstOrThrow({ where: { quotaBucket: bucket } });
    expect(row.unitsUsed).toBe(400);
    expect(row.date.toISOString().slice(0, 10)).toBe("2026-11-25");
  });

  it("never exceeds the limit under concurrent reservations", async () => {
    const quota = store(new Date("2026-11-26T12:00:00Z"));
    const results = await Promise.all(Array.from({ length: 10 }, () => quota.reserve(100)));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(await quota.remaining()).toBe(0);
  });

  it("starts a new day at midnight Pacific time", async () => {
    // 2026-11-27 07:59 UTC はまだ太平洋時間の 11-26
    expect(await store(new Date("2026-11-27T07:59:00Z")).reserve(1)).toMatchObject({ ok: false });
    expect(await store(new Date("2026-11-27T08:00:00Z")).reserve(1)).toEqual({ ok: true });
  });
});
