import { z } from "zod";

/** .env の `KEY=`（空文字）は未設定として扱う。 */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const requiredString = (message: string) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string({ error: message }).min(1, message));

const urlWithProtocols = (protocols: string[], message: string) =>
  requiredString(message).refine((v) => {
    try {
      return protocols.includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, message);

const positiveNumber = (fallback: number) =>
  z.preprocess((v) => (v === "" || v === undefined ? fallback : Number(v)), z.number().positive());

/** カンマ区切りの Provider 優先順（例: "kling,mock"）。 */
const providerOrder = (fallback: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v : fallback),
    z
      .string()
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1)),
  );

/** 32 バイトの鍵を base64 で表したもの（AES-256-GCM 用）。 */
const base64Key = (name: string) =>
  requiredString(`${name} を設定してください（pnpm env:init で生成できます）`).refine(
    (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").length === 32,
    `${name} は 32 バイトを base64 で表した値にしてください`,
  );

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().default("http://localhost:3000")),
  API_PORT: positiveNumber(4000).pipe(z.number().int().max(65535)),
  /** リバースプロキシの段数（X-Forwarded-For を何段まで信用するか）。0 = 信用しない */
  TRUST_PROXY_HOPS: z.preprocess(
    (v) => (v === "" || v === undefined ? 0 : Number(v)),
    z.number().int().min(0).max(5),
  ),
  DEFAULT_LANGUAGE: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("ja")),
  DEFAULT_REGION: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("JP")),

  DATABASE_URL: urlWithProtocols(
    ["postgresql:", "postgres:"],
    "DATABASE_URL に PostgreSQL の接続 URL を設定してください",
  ),
  REDIS_URL: urlWithProtocols(["redis:", "rediss:"], "REDIS_URL に Redis の接続 URL を設定してください"),

  SESSION_SECRET: requiredString("SESSION_SECRET を設定してください（pnpm env:init で生成できます）").refine(
    (v) => v.length >= 32,
    "SESSION_SECRET は 32 文字以上にしてください",
  ),
  TOKEN_ENCRYPTION_KEY: base64Key("TOKEN_ENCRYPTION_KEY"),
  TOKEN_ENCRYPTION_KEY_PREVIOUS: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_DEFAULT_MODEL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().default("claude-opus-5-5"),
  ),

  YOUTUBE_API_KEY: optionalString,
  YOUTUBE_DAILY_QUOTA: positiveNumber(10000).pipe(z.number().int()),
  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("auto")),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  VIDEO_PROVIDER_ORDER: providerOrder("mock"),
  KLING_ACCESS_KEY: optionalString,
  KLING_SECRET_KEY: optionalString,

  TTS_PROVIDER_ORDER: providerOrder("mock"),
  GOOGLE_TTS_CREDENTIALS: optionalString,

  MAIL_API_KEY: optionalString,
  MAIL_FROM: optionalString,

  DEFAULT_DAILY_BUDGET_USD: positiveNumber(30),
  DEFAULT_MONTHLY_BUDGET_USD: positiveNumber(600),
  DEFAULT_PER_VIDEO_BUDGET_USD: positiveNumber(10),
});

export type Env = z.infer<typeof EnvSchema>;
