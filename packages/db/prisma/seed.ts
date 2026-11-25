import { loadConfig } from "@aya/config";
import { createPrismaClient } from "../src/client";
import { runSeed } from "../src/seed";

// 開発用の初期データを投入する（pnpm db:seed）。本番では実行しない。
const config = loadConfig();
if (config.env.NODE_ENV === "production") {
  console.error("本番環境では seed を実行しません");
  process.exit(1);
}

const prisma = createPrismaClient(config.env.DATABASE_URL);
try {
  const result = await runSeed(prisma, {
    ownerEmail: process.env["SEED_OWNER_EMAIL"] ?? "owner@example.com",
    ownerPassword: process.env["SEED_OWNER_PASSWORD"] || undefined,
  });
  console.log(`seed 完了: channel=${result.channelId}, provider_pricing=${result.pricingRows} 件`);
  if (result.generatedPassword) {
    console.log(`初期 OWNER を作成しました。パスワード（この表示は一度だけ）: ${result.generatedPassword}`);
  }
} finally {
  await prisma.$disconnect();
}
