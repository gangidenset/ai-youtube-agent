import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@aya/db";
import { type ClaudeProvider, type LlmTask, ProviderError } from "@aya/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  completeAndRecord,
  computeTokenCostUsd,
  DecisionSchema,
  evaluateDecision,
  loadTokenPrices,
  PricingNotFoundError,
  recordDecision,
} from "../src";

describe("computeTokenCostUsd", () => {
  it("prices input, output and cache tokens per million", () => {
    const usage = {
      inputTokens: 15_000,
      outputTokens: 4_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
    };
    // 15000*4 + 4000*20 + 10000*0.2 + 2000*5 = 152000 / 1e6
    expect(computeTokenCostUsd(usage, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })).toBe(0.152);
    // キャッシュ単価が無ければ入力単価の 0.1 倍（読み出し）/ 1.25 倍（書き込み）で見積もる:
    // 60000 + 80000 + 10000*0.4 + 2000*5 = 154000 / 1e6
    expect(computeTokenCostUsd(usage, { input: 4, output: 20 })).toBe(0.154);
  });
});

// 実際の PostgreSQL（マイグレーション適用済み）に対して実行する。CI では必須。
const databaseUrl = process.env["DATABASE_URL"];
if (process.env["CI"] && !databaseUrl) throw new Error("CI では DATABASE_URL が必要です");

describe.runIf(databaseUrl)("cost and decision records (integration)", () => {
  const prisma = createPrismaClient(databaseUrl ?? "");
  const model = `test-model-${randomUUID()}`;
  let channelId = "";
  const schema = z.object({ ok: z.boolean() });
  const task: LlmTask<{ ok: boolean }> = {
    operation: "trend_analysis",
    schema,
    system: [],
    prompt: "p",
    effort: "low",
  };

  beforeAll(async () => {
    channelId = (await prisma.channel.create({ data: { name: `records-${randomUUID()}` } })).id;
    const effectiveFrom = new Date("2026-01-01T00:00:00Z");
    await prisma.providerPricing.createMany({
      data: [
        { provider: "anthropic", model, unitType: "INPUT_TOKENS_1M", unitPriceUsd: "4", effectiveFrom },
        { provider: "anthropic", model, unitType: "OUTPUT_TOKENS_1M", unitPriceUsd: "20", effectiveFrom },
        // 新しい単価が有効になった後は新しい方を使う
        {
          provider: "anthropic",
          model,
          unitType: "OUTPUT_TOKENS_1M",
          unitPriceUsd: "10",
          effectiveFrom: new Date("2026-06-01T00:00:00Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.aiCost.deleteMany({ where: { model } });
    await prisma.aiDecision.deleteMany({ where: { channelId } });
    await prisma.providerPricing.deleteMany({ where: { model } });
    await prisma.channel.delete({ where: { id: channelId } });
    await prisma.$disconnect();
  });

  it("loads the price in effect at a given time", async () => {
    expect(await loadTokenPrices(prisma, "anthropic", model, new Date("2026-03-01"))).toEqual({
      input: 4,
      output: 20,
    });
    expect(await loadTokenPrices(prisma, "anthropic", model, new Date("2026-07-01"))).toEqual({
      input: 4,
      output: 10,
    });
    await expect(loadTokenPrices(prisma, "anthropic", "unknown-model")).rejects.toBeInstanceOf(
      PricingNotFoundError,
    );
  });

  it("records the cost of a successful live call", async () => {
    const live: ClaudeProvider = {
      mode: "live",
      complete: async () => ({
        data: { ok: true } as never,
        requestedModel: model,
        model,
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        requestId: "req_test",
        latencyMs: 1200,
        schemaRetries: 0,
      }),
    };
    const { result, costUsd } = await completeAndRecord(prisma, live, task, { channelId });
    expect(result.data).toEqual({ ok: true });
    expect(costUsd).toBe(0.009); // 1000*4 + 500*10 = 9000 / 1e6
    const row = await prisma.aiCost.findFirstOrThrow({ where: { model, requestId: "req_test" } });
    expect(row).toMatchObject({
      provider: "anthropic",
      operation: "trend_analysis",
      inputTokens: 1000,
      estimated: true,
    });
    expect(row.costUsd.toString()).toBe("0.009");
  });

  it("records tokens spent by a failed call before rethrowing", async () => {
    const failing: ClaudeProvider = {
      mode: "live",
      complete: async () => {
        throw new ProviderError("CLAUDE_INVALID_OUTPUT", "bad", false, {
          usage: { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        });
      },
    };
    await expect(completeAndRecord(prisma, failing, { ...task, model }, { channelId })).rejects.toMatchObject(
      {
        code: "CLAUDE_INVALID_OUTPUT",
      },
    );
    const rows = await prisma.aiCost.findMany({ where: { model, inputTokens: 300 } });
    expect(rows).toHaveLength(1);
  });

  it("stores accepted and rejected decisions for the audit log", async () => {
    const decision = DecisionSchema.parse({
      next_action: "PUBLISH",
      reason: "公開に適したタイミング",
      confidence: 0.95,
      parameters: {},
      risks: [],
      data_refs: [],
    });
    const verdict = await evaluateDecision(decision, {
      currentState: "READY_FOR_DOWNLOAD",
      findForeignIds: async () => [],
    });
    const id = await recordDecision(prisma, {
      decision,
      verdict,
      state: "READY_FOR_DOWNLOAD",
      model: "claude-opus-5-5",
      promptVersion: "next-action@v1",
      channelId,
    });
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ nextAction: "PUBLISH", accepted: false, confidence: 0.95 });
    expect(row.rejectedReason).toMatch(/^HUMAN_GATED/);
  });
});
