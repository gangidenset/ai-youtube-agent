import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, EnvSchema } from "./env";
import { MOCK_PROVIDER, planProviders, type ProviderPlan } from "./providers";

export interface AppConfig {
  env: Env;
  providers: ProviderPlan;
}

/** 設定エラー。メッセージには変数名だけを含め、値（Secret の可能性がある）は出さない。 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`環境変数の設定に問題があります:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** フロントエンドに露出する変数（NEXT_PUBLIC_）に Secret らしい名前があれば拒否する。 */
const SECRET_LIKE = /SECRET|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH/i;

export function findExposedSecrets(source: Record<string, string | undefined>): string[] {
  return Object.keys(source).filter((name) => name.startsWith("NEXT_PUBLIC_") && SECRET_LIKE.test(name));
}

/** 本番では mock を許さず、外部サービスの鍵を必須にする。 */
function productionProblems(env: Env, providers: ProviderPlan): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!env.ANTHROPIC_API_KEY) problems.push("本番では ANTHROPIC_API_KEY が必須です");
  if (!env.YOUTUBE_API_KEY) problems.push("本番では YOUTUBE_API_KEY が必須です");
  if (env.VIDEO_PROVIDER_ORDER.includes(MOCK_PROVIDER) || env.TTS_PROVIDER_ORDER.includes(MOCK_PROVIDER)) {
    problems.push("本番では VIDEO_PROVIDER_ORDER / TTS_PROVIDER_ORDER に mock を含めないでください");
  }
  // 鍵の無い Provider が mock 扱いで黙って除外されるのは、本番では誤設定
  problems.push(...providers.warnings);
  return problems;
}

/** 環境変数を検証して設定を返す。問題があればすべてまとめて ConfigError を投げる。 */
export function parseConfig(source: Record<string, string | undefined>): AppConfig {
  const problems: string[] = [];

  const exposed = findExposedSecrets(source);
  if (exposed.length > 0) {
    problems.push(`Secret らしい名前の変数をフロントエンドに公開しようとしています: ${exposed.join(", ")}`);
  }

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
    }
    throw new ConfigError(problems);
  }

  const providers = planProviders(parsed.data);
  problems.push(...productionProblems(parsed.data, providers));
  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({ env: Object.freeze(parsed.data), providers: Object.freeze(providers) });
}

/** カレントディレクトリから上にたどり、ワークスペースのルートにある .env を探す。 */
export function findWorkspaceEnvFile(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const file = join(dir, ".env");
      return existsSync(file) ? file : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * アプリ起動時に呼ぶ。.env があれば読み込み（既に設定済みの環境変数が優先）、検証して返す。
 * 本番では .env を置かず、ホスティングの Secret 管理から環境変数を渡す。
 */
export function loadConfig(): AppConfig {
  const file = findWorkspaceEnvFile();
  if (file) process.loadEnvFile(file);
  return parseConfig(process.env);
}
