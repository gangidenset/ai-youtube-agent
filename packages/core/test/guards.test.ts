import { describe, expect, it } from "vitest";
import {
  checkApproval,
  checkBudget,
  checkQuota,
  evaluateTransition,
  YOUTUBE_UPLOAD_RESERVE_UNITS,
} from "../src";

const limits = { perVideoUsd: 10, dailyUsd: 30, monthlyUsd: 600 };
const usage = { projectUsd: 0, todayUsd: 0, monthUsd: 0 };

describe("checkBudget", () => {
  it("allows spending within every limit", () => {
    expect(checkBudget(3, usage, limits)).toEqual({ ok: true, warnings: [] });
  });

  it("fails on the first exceeded limit (per video, then daily, then monthly)", () => {
    expect(checkBudget(4, { ...usage, projectUsd: 7 }, limits)).toMatchObject({
      ok: false,
      code: "BUDGET_PER_VIDEO",
    });
    expect(checkBudget(4, { ...usage, todayUsd: 27 }, limits)).toMatchObject({
      ok: false,
      code: "BUDGET_DAILY",
    });
    expect(checkBudget(4, { ...usage, monthUsd: 597 }, limits)).toMatchObject({
      ok: false,
      code: "BUDGET_MONTHLY",
    });
  });

  it("allows reaching exactly the limit and warns from 80%", () => {
    expect(checkBudget(2, { ...usage, projectUsd: 8 }, limits)).toEqual({
      ok: true,
      warnings: ["動画 1 本あたりの予算の 100% に達します"],
    });
    expect(checkBudget(1, { ...usage, todayUsd: 23 }, limits)).toEqual({
      ok: true,
      warnings: ["1 日の予算の 80% に達します"],
    });
  });
});

describe("checkQuota", () => {
  const quota = { used: 0, limit: 10000 };

  it("keeps one upload worth of units in reserve for other operations", () => {
    expect(checkQuota(10000 - YOUTUBE_UPLOAD_RESERVE_UNITS, quota).ok).toBe(true);
    expect(checkQuota(10000 - YOUTUBE_UPLOAD_RESERVE_UNITS + 1, quota)).toMatchObject({
      ok: false,
      code: "QUOTA_EXCEEDED",
    });
  });

  it("lets the upload itself use the reserve", () => {
    expect(checkQuota(1600, { used: 8400, limit: 10000 }, { isUpload: true }).ok).toBe(true);
    expect(checkQuota(1600, { used: 8401, limit: 10000 }, { isUpload: true }).ok).toBe(false);
  });
});

describe("checkApproval", () => {
  it("requires an approval that still matches the current content", () => {
    expect(
      checkApproval({ status: "APPROVED", approvedSnapshotHash: "a", currentSnapshotHash: "a" }).ok,
    ).toBe(true);
    expect(
      checkApproval({ status: "PENDING", approvedSnapshotHash: null, currentSnapshotHash: "a" }),
    ).toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect(
      checkApproval({ status: "APPROVED", approvedSnapshotHash: "a", currentSnapshotHash: "b" }),
    ).toMatchObject({
      code: "APPROVAL_STALE",
    });
  });
});

describe("evaluateTransition", () => {
  it("rejects transitions outside the table even when everything else is fine", () => {
    expect(evaluateTransition({ from: "SCRIPT_GENERATION", to: "PUBLISHING" })).toMatchObject({
      ok: false,
      code: "TRANSITION_NOT_ALLOWED",
    });
  });

  it("never lets download or publishing through without approval", () => {
    expect(evaluateTransition({ from: "WAITING_APPROVAL", to: "READY_FOR_DOWNLOAD" })).toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect(
      evaluateTransition({
        from: "WAITING_APPROVAL",
        to: "READY_FOR_DOWNLOAD",
        approval: { status: "APPROVED", approvedSnapshotHash: "h", currentSnapshotHash: "h" },
      }).ok,
    ).toBe(true);
  });

  it("checks budget and quota and collects warnings", () => {
    expect(
      evaluateTransition({
        from: "SCRIPT_GENERATION",
        to: "VIDEO_GENERATION",
        budget: { estimatedUsd: 5, usage: { ...usage, projectUsd: 6 }, limits },
      }),
    ).toMatchObject({ ok: false, code: "BUDGET_PER_VIDEO" });

    expect(
      evaluateTransition({
        from: "IDLE",
        to: "MARKET_RESEARCH",
        quota: { required: 1100, state: { used: 8000, limit: 10000 } },
      }),
    ).toMatchObject({ ok: false, code: "QUOTA_EXCEEDED" });

    expect(
      evaluateTransition({
        from: "SCRIPT_GENERATION",
        to: "VIDEO_GENERATION",
        budget: { estimatedUsd: 4, usage: { ...usage, projectUsd: 4 }, limits },
      }),
    ).toEqual({ ok: true, warnings: ["動画 1 本あたりの予算の 80% に達します"] });
  });
});
