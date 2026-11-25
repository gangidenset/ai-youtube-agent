import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, runSeed, SAMPLE_CHANNEL_NAME, SEED_PRICING, verifyPassword } from "../src";

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。
// CI では必ず実行する（DATABASE_URL が無ければ失敗させる）。ローカルで DB が無い場合のみ省略。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

describe.runIf(databaseUrl)("seed (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const email = `owner-${randomUUID()}@example.com`;

  afterAll(async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.channel.deleteMany({ where: { members: { some: { userId: user.id } } } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await prisma.$disconnect();
  });

  it("creates the owner, sample channel with ADR defaults, and pricing", async () => {
    const first = await runSeed(prisma, { ownerEmail: email });
    expect(first.createdOwner).toBe(true);
    expect(first.generatedPassword).toBeDefined();

    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(owner.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(owner.passwordHash, first.generatedPassword ?? "")).toBe(true);

    const channel = await prisma.channel.findUniqueOrThrow({
      where: { id: first.channelId },
      include: { settings: true, members: true },
    });
    expect(channel.name).toBe(SAMPLE_CHANNEL_NAME);
    expect(channel.members).toEqual([expect.objectContaining({ userId: owner.id, role: "OWNER" })]);
    expect(channel.settings).toMatchObject({
      language: "ja",
      region: "JP",
      ideaSelectionMode: "AUTO_TOP",
      defaultTargets: ["tiktok", "instagram_reels", "youtube_shorts"],
      displayCurrency: "JPY",
      autoPublishEnabled: false,
    });
    expect(channel.settings?.perVideoBudgetUsd.toString()).toBe("10");
    expect(await prisma.providerPricing.count()).toBeGreaterThanOrEqual(SEED_PRICING.length);
  });

  it("is idempotent and never changes an existing password", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email } });
    const pricingBefore = await prisma.providerPricing.count();

    const second = await runSeed(prisma, { ownerEmail: email, ownerPassword: "another-password-123" });
    expect(second.createdOwner).toBe(false);
    expect(second.generatedPassword).toBeUndefined();

    const after = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await prisma.channel.count({ where: { members: { some: { userId: after.id } } } })).toBe(1);
    expect(await prisma.providerPricing.count()).toBe(pricingBefore);
  });
});
