import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "prisma/config";

// ワークスペースのルートにある .env を読み込む（既に設定済みの環境変数が優先）。
// 本番では .env を置かず、ホスティングの Secret 管理から DATABASE_URL を渡す。
for (let dir = process.cwd(); ; dir = dirname(dir)) {
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const file = join(dir, ".env");
    if (existsSync(file)) process.loadEnvFile(file);
    break;
  }
  if (dirname(dir) === dir) break;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
