import type { Env } from "./env";

export type ProviderMode = "live" | "mock";

/** Provider ごとに、実 API を使うのに必要な環境変数。ここに無い名前（mock 等）は鍵不要。 */
export const PROVIDER_REQUIRED_KEYS = {
  video: { kling: ["KLING_ACCESS_KEY", "KLING_SECRET_KEY"] },
  tts: { google: ["GOOGLE_TTS_CREDENTIALS"] },
} as const satisfies Record<string, Record<string, readonly (keyof Env)[]>>;

export const MOCK_PROVIDER = "mock";

export interface ProviderPlan {
  claude: ProviderMode;
  youtube: ProviderMode;
  /** 鍵がそろっていて使える Provider（優先順）。鍵の無いものは除外し、何も残らなければ mock。 */
  video: string[];
  tts: string[];
  warnings: string[];
}

function resolveOrder(
  env: Env,
  kind: keyof typeof PROVIDER_REQUIRED_KEYS,
  order: readonly string[],
  warnings: string[],
): string[] {
  const required: Record<string, readonly (keyof Env)[]> = PROVIDER_REQUIRED_KEYS[kind];
  const usable = order.filter((name) => {
    if (name === MOCK_PROVIDER) return true;
    const keys = required[name];
    if (!keys) {
      warnings.push(`${kind}: 未知の Provider "${name}" を無視します`);
      return false;
    }
    const missing = keys.filter((k) => !env[k]);
    if (missing.length > 0) {
      warnings.push(`${kind}: ${name} は ${missing.join(", ")} が未設定のため使いません`);
      return false;
    }
    return true;
  });
  return usable.length > 0 ? usable : [MOCK_PROVIDER];
}

/** API キーが無い外部サービスは mock で動かす（ローカル開発・CI 用）。 */
export function planProviders(env: Env): ProviderPlan {
  const warnings: string[] = [];
  const video = resolveOrder(env, "video", env.VIDEO_PROVIDER_ORDER, warnings);
  const tts = resolveOrder(env, "tts", env.TTS_PROVIDER_ORDER, warnings);
  return {
    claude: env.ANTHROPIC_API_KEY ? "live" : "mock",
    youtube: env.YOUTUBE_API_KEY ? "live" : "mock",
    video,
    tts,
    warnings,
  };
}
