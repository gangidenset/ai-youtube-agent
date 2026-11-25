import { randomBytes } from "node:crypto";
import type { PrismaClient } from "./client";
import { PricingUnit } from "./generated/prisma/enums";
import { hashPassword } from "./password";

export const SAMPLE_CHANNEL_NAME = "サンプルチャンネル";

/** 2026-10-29 時点の参考単価（docs/cost-management.md）。契約時に公式価格で確認して更新する。 */
export const PRICING_EFFECTIVE_FROM = new Date("2026-10-29T00:00:00Z");

export const SEED_PRICING: {
  provider: string;
  model: string;
  unitType: PricingUnit;
  unitPriceUsd: string;
  note: string;
}[] = [
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    unitType: PricingUnit.INPUT_TOKENS_1M,
    unitPriceUsd: "4",
    note: "公式価格",
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    unitType: PricingUnit.OUTPUT_TOKENS_1M,
    unitPriceUsd: "20",
    note: "公式価格",
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    unitType: PricingUnit.CACHE_READ_TOKENS_1M,
    unitPriceUsd: "0.2",
    note: "公式価格",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    unitType: PricingUnit.INPUT_TOKENS_1M,
    unitPriceUsd: "2",
    note: "公式価格",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    unitType: PricingUnit.OUTPUT_TOKENS_1M,
    unitPriceUsd: "10",
    note: "公式価格",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    unitType: PricingUnit.CACHE_READ_TOKENS_1M,
    unitPriceUsd: "0.2",
    note: "公式価格",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    unitType: PricingUnit.INPUT_TOKENS_1M,
    unitPriceUsd: "0.1",
    note: "公式価格（10 万トークン以下のプロンプト）",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    unitType: PricingUnit.OUTPUT_TOKENS_1M,
    unitPriceUsd: "0.5",
    note: "公式価格（10 万トークン以下のプロンプト）",
  },
  {
    provider: "kling",
    model: "kling-3.0-standard-720p",
    unitType: PricingUnit.VIDEO_SECOND,
    unitPriceUsd: "0.084",
    note: "要確認: 第三者による報告値（音声なし）",
  },
  {
    provider: "kling",
    model: "kling-3.0-standard-1080p",
    unitType: PricingUnit.VIDEO_SECOND,
    unitPriceUsd: "0.112",
    note: "要確認: 第三者による報告値（音声なし）",
  },
  {
    provider: "google-tts",
    model: "chirp3-hd",
    unitType: PricingUnit.TTS_CHARS_1M,
    unitPriceUsd: "30",
    note: "公式価格（月 100 万文字まで無料）",
  },
  {
    provider: "google-tts",
    model: "wavenet",
    unitType: PricingUnit.TTS_CHARS_1M,
    unitPriceUsd: "4",
    note: "公式価格（無料枠あり）",
  },
  {
    provider: "google-tts",
    model: "standard",
    unitType: PricingUnit.TTS_CHARS_1M,
    unitPriceUsd: "4",
    note: "公式価格（無料枠あり）",
  },
];

export interface SeedOptions {
  ownerEmail: string;
  /** 省略時はランダム生成し、結果の generatedPassword で返す（ログに一度だけ出す用途） */
  ownerPassword?: string;
}

export interface SeedResult {
  ownerId: string;
  channelId: string;
  pricingRows: number;
  createdOwner: boolean;
  generatedPassword?: string;
}

/** 開発用の初期データ。何度実行しても同じ状態になる（既存の OWNER のパスワードは変更しない）。 */
export async function runSeed(prisma: PrismaClient, options: SeedOptions): Promise<SeedResult> {
  const email = options.ownerEmail.trim().toLowerCase();
  let owner = await prisma.user.findUnique({ where: { email } });
  let generatedPassword: string | undefined;
  const createdOwner = !owner;

  if (!owner) {
    const password = options.ownerPassword ?? (generatedPassword = randomBytes(18).toString("base64url"));
    owner = await prisma.user.create({
      data: { email, displayName: "Owner", passwordHash: await hashPassword(password) },
    });
  }

  const ownerId = owner.id;
  const channelId = await prisma.$transaction(async (tx) => {
    const existing = await tx.channel.findFirst({
      where: { name: SAMPLE_CHANNEL_NAME, members: { some: { userId: ownerId, role: "OWNER" } } },
    });
    if (existing) return existing.id;
    const channel = await tx.channel.create({
      data: {
        name: SAMPLE_CHANNEL_NAME,
        settings: { create: { genre: "AI・副業", targetAudience: "AI活用に興味がある社会人" } },
        members: { create: { userId: ownerId, role: "OWNER" } },
      },
    });
    return channel.id;
  });

  for (const row of SEED_PRICING) {
    await prisma.providerPricing.upsert({
      where: {
        provider_model_unitType_effectiveFrom: {
          provider: row.provider,
          model: row.model,
          unitType: row.unitType,
          effectiveFrom: PRICING_EFFECTIVE_FROM,
        },
      },
      create: { ...row, effectiveFrom: PRICING_EFFECTIVE_FROM },
      update: { unitPriceUsd: row.unitPriceUsd, note: row.note },
    });
  }

  return {
    ownerId,
    channelId,
    pricingRows: SEED_PRICING.length,
    createdOwner,
    ...(generatedPassword ? { generatedPassword } : {}),
  };
}
