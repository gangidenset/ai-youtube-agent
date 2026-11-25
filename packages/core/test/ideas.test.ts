import { describe, expect, it } from "vitest";
import { type IdeaCandidate, ineligibleReasons, selectAutoTop } from "../src";

const idea = (overrides: Partial<IdeaCandidate>): IdeaCandidate => ({
  id: overrides.label ?? "x",
  label: "A",
  trendScore: 70,
  originalityScore: 80,
  copyRisk: "LOW",
  policyRisk: "LOW",
  ...overrides,
});

describe("selectAutoTop (ADR-006)", () => {
  it("picks the highest Trend Score among eligible ideas", () => {
    const r = selectAutoTop([
      idea({ label: "A", trendScore: 70 }),
      idea({ label: "B", trendScore: 88 }),
      idea({ label: "C", trendScore: 95, originalityScore: 55 }), // Originality 不足
    ]);
    expect(r.selected?.label).toBe("B");
    expect(r.reason).toContain("2 案のうち");
  });

  it("breaks ties by Originality Score", () => {
    const r = selectAutoTop([
      idea({ label: "A", trendScore: 80, originalityScore: 70 }),
      idea({ label: "B", trendScore: 80, originalityScore: 90 }),
    ]);
    expect(r.selected?.label).toBe("B");
  });

  it("excludes high copy or policy risk even with the best score", () => {
    const r = selectAutoTop([
      idea({ label: "A", trendScore: 99, copyRisk: "HIGH" }),
      idea({ label: "B", trendScore: 98, policyRisk: "HIGH" }),
      idea({ label: "C", trendScore: 50, copyRisk: "MEDIUM" }),
    ]);
    expect(r.selected?.label).toBe("C");
  });

  it("selects nothing and explains why when no idea qualifies", () => {
    const r = selectAutoTop([
      idea({ label: "A", originalityScore: 40 }),
      idea({ label: "B", copyRisk: "HIGH", policyRisk: "HIGH" }),
    ]);
    expect(r.selected).toBeNull();
    expect(r).toMatchObject({
      rejected: [
        { label: "A", reasons: ["LOW_ORIGINALITY"] },
        { label: "B", reasons: ["COPY_RISK_HIGH", "POLICY_RISK_HIGH"] },
      ],
    });
    expect(r.reason).toContain("A: Originality 60 未満");
  });

  it("treats exactly 60 as eligible", () => {
    expect(ineligibleReasons(idea({ originalityScore: 60 }))).toEqual([]);
  });
});
