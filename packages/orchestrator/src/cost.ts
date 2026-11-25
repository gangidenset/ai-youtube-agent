import type { PrismaClient } from "@aya/db";
import type { LlmUsage } from "@aya/providers";

/** 100 万トークンあたりの単価（USD） */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 単価表に無い場合の目安（入力単価に対する倍率。キャッシュ書き込み 1.25 倍・読み出し 0.1 倍） */
const CACHE_WRITE_RATIO = 1.25;
const CACHE_READ_RATIO = 0.1;

export function computeTokenCostUsd(usage: LlmUsage, prices: TokenPrices): number {
  const perToken = (pricePerMillion: number) => pricePerMillion / 1_000_000;
  const cost =
    usage.inputTokens * perToken(prices.input) +
    usage.outputTokens * perToken(prices.output) +
    usage.cacheReadTokens * perToken(prices.cacheRead ?? prices.input * CACHE_READ_RATIO) +
    usage.cacheWriteTokens * perToken(prices.cacheWrite ?? prices.input * CACHE_WRITE_RATIO);
  // ai_costs.cost_usd は小数 6 桁
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export class PricingNotFoundError extends Error {
  constructor(provider: string, model: string) {
    super(`provider_pricing に単価がありません: ${provider} / ${model}`);
    this.name = "PricingNotFoundError";
  }
}

/** provider_pricing から、指定時点で有効な単価を読む（単価をコードに埋め込まない）。 */
export async function loadTokenPrices(
  prisma: PrismaClient,
  provider: string,
  model: string,
  at: Date = new Date(),
): Promise<TokenPrices> {
  const rows = await prisma.providerPricing.findMany({
    where: { provider, model, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: "desc" },
  });
  const latest = (unit: string) => rows.find((r) => r.unitType === unit)?.unitPriceUsd.toNumber();
  const input = latest("INPUT_TOKENS_1M");
  const output = latest("OUTPUT_TOKENS_1M");
  if (input === undefined || output === undefined) throw new PricingNotFoundError(provider, model);
  const cacheRead = latest("CACHE_READ_TOKENS_1M");
  const cacheWrite = latest("CACHE_WRITE_TOKENS_1M");
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}
