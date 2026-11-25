import { describe, expect, it } from "vitest";
import {
  computeOriginalityScore,
  computeTrendScore,
  DEFAULT_TREND_WEIGHTS,
  findOverclaims,
  type MarketVideoSample,
  median,
  ngramJaccard,
  percentileRank,
} from "../src";

const video = (overrides: Partial<MarketVideoSample> = {}): MarketVideoSample => ({
  viewsPerHour: 100,
  viewsPerSubscriber: 1,
  likeRate: 0.03,
  commentRate: 0.001,
  ageHours: 100,
  viewCount: 10_000,
  channelSubscribers: 10_000,
  ...overrides,
});

describe("statistics helpers", () => {
  it("computes medians and percentile ranks", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentileRank(5, [1, 2, 3, 4])).toBe(1);
    expect(percentileRank(0, [1, 2, 3, 4])).toBe(0);
    expect(percentileRank(2, [1, 2, 2, 3])).toBe(0.5);
    expect(percentileRank(1, [])).toBe(0.5);
  });
});

describe("computeTrendScore", () => {
  const population = Array.from({ length: 40 }, (_, i) =>
    video({ viewsPerHour: 50 + i * 10, viewsPerSubscriber: 0.5 + i * 0.1, likeRate: 0.01 + i * 0.001 }),
  );

  it("scores strong, fresh themes from small channels higher than weak, crowded ones", () => {
    const strong = Array.from({ length: 8 }, (_, i) =>
      video({
        viewsPerHour: 500 + i,
        viewsPerSubscriber: 6,
        likeRate: 0.06,
        commentRate: 0.004,
        ageHours: 60,
        channelSubscribers: 5_000,
      }),
    );
    const weak = Array.from({ length: 20 }, () =>
      video({
        viewsPerHour: 40,
        viewsPerSubscriber: 0.2,
        likeRate: 0.005,
        commentRate: 0.0001,
        ageHours: 150,
        channelSubscribers: 500_000,
      }),
    );
    const s = computeTrendScore({
      evidence: strong,
      population,
      lookbackHours: 168,
      novelty: 0.8,
      demand: 0.9,
    });
    const w = computeTrendScore({
      evidence: weak,
      population,
      lookbackHours: 168,
      novelty: 0.2,
      demand: 0.3,
    });
    expect(s.score).toBeGreaterThan(70);
    expect(w.score).toBeLessThan(30);
    expect(s.components.growth).toBe(1);
    expect(w.components.growth).toBe(0);
    expect(s.components.competition).toBeGreaterThan(w.components.competition);
  });

  it("returns a breakdown whose parts add up to the score (weights sum to 100)", () => {
    const r = computeTrendScore({
      evidence: population.slice(0, 10),
      population,
      lookbackHours: 168,
      novelty: 0.5,
      demand: 0.5,
    });
    expect(Object.values(DEFAULT_TREND_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - r.score)).toBeLessThan(0.6);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("uses neutral values and explains uncertainty when data is missing or thin", () => {
    const r = computeTrendScore({
      evidence: [video({ viewsPerSubscriber: null, likeRate: null, commentRate: null, ageHours: 10 })],
      population,
      lookbackHours: 168,
      novelty: 0.5,
      demand: 0.5,
    });
    expect(r.components.sizeRatio).toBe(0.5);
    expect(r.components.ownFit).toBe(0.5);
    expect(r.uncertainty.level).toBe("HIGH");
    expect(r.uncertainty.reasons.join("\n")).toMatch(/1 本/);
    expect(r.uncertainty.reasons.join("\n")).toMatch(/48 時間/);
  });

  it("downgrades confidence when every evidence video is very new", () => {
    const fresh = Array.from({ length: 10 }, () => video({ ageHours: 20 }));
    expect(
      computeTrendScore({
        evidence: fresh,
        population,
        lookbackHours: 168,
        novelty: 0.5,
        demand: 0.5,
        ownFit: 0.5,
      }).uncertainty.level,
    ).toBe("MEDIUM");
  });
});

describe("originality", () => {
  it("measures character n-gram similarity, ignoring spaces and symbols", () => {
    expect(ngramJaccard("AI副業3選", "ＡＩ 副業 ３選！")).toBe(1);
    expect(ngramJaccard("AI副業で最初にやるべき3つ", "AI副業で最初にやること")).toBeGreaterThan(0.5);
    expect(ngramJaccard("料理の時短テク", "AI副業3選")).toBe(0);
    expect(ngramJaccard("", "")).toBe(0);
  });

  it("combines text and semantic similarity and adds a capped bonus for differentiation", () => {
    const r = computeOriginalityScore(
      [
        { videoId: "a", textSimilarity: 0.5, semanticSimilarity: 0.5 },
        { videoId: "b", textSimilarity: 0.2, semanticSimilarity: 0.1 },
      ],
      3,
    );
    // 最も似ているのは a（0.4*0.5 + 0.6*0.5 = 0.5）→ 50 + 6
    expect(r.score).toBe(56);
    expect(r.closest?.videoId).toBe("a");
    expect(r.copyRisk).toBe("MEDIUM");
    expect(computeOriginalityScore([], 10).score).toBe(100);
    expect(
      computeOriginalityScore([{ videoId: "c", textSimilarity: 0.9, semanticSimilarity: 0.9 }], 0),
    ).toMatchObject({
      score: 10,
      copyRisk: "HIGH",
    });
  });
});

describe("findOverclaims", () => {
  it("detects guarantees of success", () => {
    expect(
      findOverclaims(["この企画は必ずバズる", "絶対に伸びます", "確実に稼げる方法", "収益は保証"]),
    ).toHaveLength(4);
    expect(findOverclaims(["This will definitely go viral"])).toHaveLength(1);
  });

  it("allows hedged predictions", () => {
    expect(findOverclaims(["伸びる可能性が高いテーマです", "バズる傾向があります（不確実性: 中）"])).toEqual(
      [],
    );
  });
});
