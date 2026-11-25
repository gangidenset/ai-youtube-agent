import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, findExposedSecrets, findWorkspaceEnvFile, parseConfig } from "../src";

const valid = {
  DATABASE_URL: "postgresql://aya:aya@localhost:5432/aya",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "x".repeat(32),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

function problemsOf(source: Record<string, string | undefined>): string[] {
  try {
    parseConfig(source);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe("parseConfig", () => {
  it("applies defaults (ja / JP / claude-opus-5-5 / mock providers)", () => {
    const { env, providers } = parseConfig(valid);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      API_PORT: 4000,
      DEFAULT_LANGUAGE: "ja",
      DEFAULT_REGION: "JP",
      CLAUDE_DEFAULT_MODEL: "claude-opus-5-5",
      YOUTUBE_DAILY_QUOTA: 10000,
      DEFAULT_PER_VIDEO_BUDGET_USD: 10,
    });
    expect(providers).toEqual({
      claude: "mock",
      youtube: "mock",
      video: ["mock"],
      tts: ["mock"],
      warnings: [],
    });
  });

  it("treats empty values from .env as unset", () => {
    const { env } = parseConfig({ ...valid, ANTHROPIC_API_KEY: "", API_PORT: "", DEFAULT_LANGUAGE: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.API_PORT).toBe(4000);
    expect(env.DEFAULT_LANGUAGE).toBe("ja");
  });

  it("reports every missing required variable at once, without values", () => {
    const problems = problemsOf({ SESSION_SECRET: "short-secret-value" });
    const text = problems.join("\n");
    for (const name of ["DATABASE_URL", "REDIS_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("short-secret-value");
  });

  it("validates URL schemes and the encryption key length", () => {
    const text = problemsOf({
      ...valid,
      DATABASE_URL: "mysql://localhost/aya",
      TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64"),
    }).join("\n");
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("32 バイト");
  });

  it("rejects secret-like names exposed to the frontend", () => {
    expect(
      findExposedSecrets({ NEXT_PUBLIC_API_KEY: "x", NEXT_PUBLIC_APP_NAME: "x", ANTHROPIC_API_KEY: "x" }),
    ).toEqual(["NEXT_PUBLIC_API_KEY"]);
    expect(problemsOf({ ...valid, NEXT_PUBLIC_ANTHROPIC_API_KEY: "x" }).join()).toContain(
      "NEXT_PUBLIC_ANTHROPIC_API_KEY",
    );
  });
});

describe("provider plan (mock when keys are missing)", () => {
  it("uses live providers only when their keys are present", () => {
    const { providers } = parseConfig({
      ...valid,
      ANTHROPIC_API_KEY: "k",
      VIDEO_PROVIDER_ORDER: "kling,mock",
      KLING_ACCESS_KEY: "a",
      KLING_SECRET_KEY: "b",
      TTS_PROVIDER_ORDER: "google",
      GOOGLE_TTS_CREDENTIALS: "c",
    });
    expect(providers).toMatchObject({
      claude: "live",
      youtube: "mock",
      video: ["kling", "mock"],
      tts: ["google"],
    });
  });

  it("falls back to mock in development when a provider lacks keys", () => {
    const { providers } = parseConfig({ ...valid, VIDEO_PROVIDER_ORDER: "kling", KLING_ACCESS_KEY: "a" });
    expect(providers.video).toEqual(["mock"]);
    expect(providers.warnings).toEqual(["video: kling は KLING_SECRET_KEY が未設定のため使いません"]);
  });

  it("ignores unknown providers with a warning", () => {
    const { providers } = parseConfig({ ...valid, TTS_PROVIDER_ORDER: "Unknown_tts, mock" });
    expect(providers.tts).toEqual(["mock"]);
    expect(providers.warnings[0]).toContain("unknown_tts");
  });
});

describe("production", () => {
  const prod = {
    ...valid,
    NODE_ENV: "production",
    ANTHROPIC_API_KEY: "k",
    YOUTUBE_API_KEY: "y",
    VIDEO_PROVIDER_ORDER: "kling",
    KLING_ACCESS_KEY: "a",
    KLING_SECRET_KEY: "b",
    TTS_PROVIDER_ORDER: "google",
    GOOGLE_TTS_CREDENTIALS: "c",
  };

  it("accepts a fully configured production environment", () => {
    expect(parseConfig(prod).providers).toMatchObject({ claude: "live", video: ["kling"], tts: ["google"] });
  });

  it("refuses mock providers and missing keys", () => {
    const text = problemsOf({
      ...prod,
      ANTHROPIC_API_KEY: "",
      VIDEO_PROVIDER_ORDER: "mock",
      GOOGLE_TTS_CREDENTIALS: "",
    }).join("\n");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("mock を含めないでください");
    expect(text).toContain("GOOGLE_TTS_CREDENTIALS");
  });
});

describe("findWorkspaceEnvFile", () => {
  it("finds .env at the workspace root from a nested directory", () => {
    const root = mkdtempSync(join(tmpdir(), "aya-config-"));
    const nested = join(root, "apps", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    expect(findWorkspaceEnvFile(nested)).toBeUndefined();
    writeFileSync(join(root, ".env"), "A=1\n");
    expect(findWorkspaceEnvFile(nested)).toBe(join(root, ".env"));
  });
});
