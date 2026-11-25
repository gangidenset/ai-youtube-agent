// ローカル開発用の .env を .env.example から作る。Secret はランダム生成する。
// 既に .env がある場合は上書きしない。
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = `${root}.env`;

if (existsSync(target)) {
  console.log(".env は既にあるので変更しません。作り直す場合は削除してから実行してください。");
  process.exit(0);
}

const generated = {
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

const lines = readFileSync(`${root}.env.example`, "utf8")
  .split("\n")
  .map((line) => {
    const name = line.split("=", 1)[0];
    return name in generated && line === `${name}=` ? `${name}=${generated[name]}` : line;
  });

writeFileSync(target, lines.join("\n"), { mode: 0o600 });
console.log(
  ".env を作成しました（SESSION_SECRET と TOKEN_ENCRYPTION_KEY を生成）。SEED_OWNER_PASSWORD（初期 OWNER のパスワード）と API キーは必要に応じて追記してください。",
);
