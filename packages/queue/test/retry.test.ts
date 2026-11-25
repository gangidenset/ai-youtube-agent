import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  isNonRetryable,
  NonRetryableError,
  DEFAULT_RETRY_POLICY,
  isJobType,
  JOB_DEFINITIONS,
  jobDefinition,
  QUEUE_NAMES,
  QUEUE_SETTINGS,
} from "../src";

describe("computeBackoffMs", () => {
  it("grows exponentially: about 30s, 2m, 8m (half fixed, half random)", () => {
    const min = (n: number) => computeBackoffMs(n, DEFAULT_RETRY_POLICY, () => 0);
    const max = (n: number) => computeBackoffMs(n, DEFAULT_RETRY_POLICY, () => 1);
    expect([min(1), max(1)]).toEqual([15_000, 30_000]);
    expect([min(2), max(2)]).toEqual([60_000, 120_000]);
    expect([min(3), max(3)]).toEqual([240_000, 480_000]);
  });

  it("is capped at maxMs", () => {
    expect(computeBackoffMs(10, DEFAULT_RETRY_POLICY, () => 1)).toBe(DEFAULT_RETRY_POLICY.maxMs);
  });

  it("spreads retries with jitter", () => {
    const delays = new Set(Array.from({ length: 20 }, () => computeBackoffMs(2)));
    expect(delays.size).toBeGreaterThan(1);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(120_000);
    }
  });
});

describe("job definitions", () => {
  it("routes every job to a configured queue", () => {
    for (const def of Object.values(JOB_DEFINITIONS)) {
      expect(QUEUE_NAMES).toContain(def.queue);
      expect(def.maxAttempts).toBeGreaterThanOrEqual(1);
    }
    for (const name of QUEUE_NAMES) expect(QUEUE_SETTINGS[name].concurrency).toBeGreaterThan(0);
  });

  it("separates YouTube, LLM and analytics work", () => {
    expect(jobDefinition("market_research").queue).toBe("youtube");
    expect(jobDefinition("generate_script").queue).toBe("llm");
    expect(jobDefinition("analyze_performance").queue).toBe("analytics");
  });

  it("recognizes job types", () => {
    expect(isJobType("generate_script")).toBe(true);
    expect(isJobType("toString")).toBe(false);
    expect(isJobType("upload_youtube")).toBe(false);
  });
});

describe("isNonRetryable", () => {
  it("treats NonRetryableError and errors marked retryable=false as final", () => {
    expect(isNonRetryable(new NonRetryableError("X", "x"))).toBe(true);
    expect(isNonRetryable(Object.assign(new Error("auth"), { retryable: false }))).toBe(true);
    expect(isNonRetryable(Object.assign(new Error("503"), { retryable: true }))).toBe(false);
    expect(isNonRetryable(new Error("plain"))).toBe(false);
  });
});
