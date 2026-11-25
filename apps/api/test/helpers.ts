import { randomBytes } from "node:crypto";
import { parseConfig } from "@aya/config";

export const APP_ORIGIN = "http://localhost:3000";

export function testConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://aya:aya@localhost:5432/aya",
    REDIS_URL: "redis://localhost:6379",
    SESSION_SECRET: randomBytes(32).toString("base64url"),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    APP_BASE_URL: APP_ORIGIN,
    ...overrides,
  });
}

/** テスト中に進められる時計 */
export function testClock(start = new Date()) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
