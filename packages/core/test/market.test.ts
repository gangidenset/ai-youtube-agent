import { describe, expect, it } from "vitest";
import {
  deriveVideoMetrics,
  isShortEstimated,
  nextPacificMidnight,
  pacificDate,
  parseIsoDuration,
} from "../src";

describe("deriveVideoMetrics", () => {
  const base = {
    publishedAt: new Date("2026-11-20T00:00:00Z"),
    fetchedAt: new Date("2026-11-21T00:00:00Z"),
    viewCount: 120_000,
    likeCount: 6_000,
    commentCount: 240,
    channelSubscribers: 8_000,
  };

  it("computes speed, size ratio and engagement rates", () => {
    expect(deriveVideoMetrics(base)).toEqual({
      ageHours: 24,
      viewsPerHour: 5000,
      viewsPerSubscriber: 15,
      likeRate: 0.05,
      commentRate: 0.002,
    });
  });

  it("uses null for hidden counts and at least one hour of age", () => {
    const m = deriveVideoMetrics({
      ...base,
      fetchedAt: new Date("2026-11-20T00:10:00Z"),
      likeCount: null,
      commentCount: null,
      channelSubscribers: null,
    });
    expect(m).toMatchObject({
      ageHours: 1,
      viewsPerHour: 120_000,
      viewsPerSubscriber: null,
      likeRate: null,
      commentRate: null,
    });
    expect(deriveVideoMetrics({ ...base, viewCount: 0 }).likeRate).toBeNull();
  });
});

describe("durations", () => {
  it("parses ISO 8601 durations", () => {
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT1M2S")).toBe(62);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("P1DT1S")).toBe(86_401);
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration("1:02")).toBeNull();
  });

  it("estimates Shorts by duration (3 minutes or less)", () => {
    expect(isShortEstimated(59)).toBe(true);
    expect(isShortEstimated(180)).toBe(true);
    expect(isShortEstimated(181)).toBe(false);
    expect(isShortEstimated(0)).toBe(false);
    expect(isShortEstimated(null)).toBe(false);
  });
});

describe("Pacific time quota day", () => {
  it("uses the Pacific date, not UTC", () => {
    // 2026-11-25 07:00 UTC = 11-24 23:00 PST
    expect(pacificDate(new Date("2026-11-25T07:00:00Z"))).toBe("2026-11-24");
    expect(pacificDate(new Date("2026-11-25T08:00:00Z"))).toBe("2026-11-25");
  });

  it("finds the next midnight in winter (PST) and summer (PDT)", () => {
    expect(nextPacificMidnight(new Date("2026-11-25T14:00:00Z")).toISOString()).toBe(
      "2026-11-26T08:00:00.000Z",
    );
    expect(nextPacificMidnight(new Date("2026-07-01T12:00:00Z")).toISOString()).toBe(
      "2026-07-02T07:00:00.000Z",
    );
  });

  it("handles the day daylight saving time starts", () => {
    // 2026-03-08 は夏時間の開始日。3/7 の翌 0 時はまだ PST
    expect(nextPacificMidnight(new Date("2026-03-07T20:00:00Z")).toISOString()).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    // 3/8 の翌 0 時は PDT
    expect(nextPacificMidnight(new Date("2026-03-08T20:00:00Z")).toISOString()).toBe(
      "2026-03-09T07:00:00.000Z",
    );
  });
});
