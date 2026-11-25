import { describe, expect, it } from "vitest";
import { type Decision, DecisionSchema, evaluateDecision, referencedIds } from "../src";

const OWN = "01a21303-16d9-7222-b1c8-b224baa066df";
const FOREIGN = "01a21303-16d9-7222-b1c8-000000000000";

function decision(overrides: Partial<Decision> = {}): Decision {
  return DecisionSchema.parse({
    next_action: "GENERATE_SCRIPT",
    reason: "市場分析の結果、この企画の成長性が高い",
    confidence: 0.87,
    parameters: { idea_id: OWN },
    risks: [],
    data_refs: [`competitor_video:${OWN}`],
    ...overrides,
  });
}

const ownsOnly = (owned: string[]) => async (ids: string[]) => ids.filter((id) => !owned.includes(id));

describe("DecisionSchema", () => {
  it("rejects unknown actions and out-of-range confidence", () => {
    expect(DecisionSchema.safeParse({ ...decision(), next_action: "DELETE_CHANNEL" }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...decision(), confidence: 1.2 }).success).toBe(false);
  });
});

describe("evaluateDecision", () => {
  const ctx = { currentState: "WAITING_IDEA_SELECTION" as const, findForeignIds: ownsOnly([OWN]) };

  it("accepts a valid decision and returns the target state", async () => {
    expect(await evaluateDecision(decision(), ctx)).toEqual({ accepted: true, toState: "SCRIPT_GENERATION" });
  });

  it("escalates low confidence and explicit escalation", async () => {
    expect(await evaluateDecision(decision({ confidence: 0.4 }), ctx)).toMatchObject({
      accepted: false,
      code: "LOW_CONFIDENCE",
      escalate: true,
    });
    expect(await evaluateDecision(decision({ next_action: "ESCALATE_TO_HUMAN" }), ctx)).toMatchObject({
      code: "ESCALATED_BY_AI",
      escalate: true,
    });
  });

  it("never lets the AI publish on its own, even with high confidence", async () => {
    const verdict = await evaluateDecision(decision({ next_action: "PUBLISH", confidence: 0.99 }), {
      ...ctx,
      currentState: "READY_FOR_DOWNLOAD",
    });
    expect(verdict).toMatchObject({ accepted: false, code: "HUMAN_GATED" });
  });

  it("rejects transitions outside the table", async () => {
    expect(await evaluateDecision(decision({ next_action: "LEARN" }), ctx)).toMatchObject({
      accepted: false,
      code: "TRANSITION_NOT_ALLOWED",
    });
  });

  it("rejects IDs from other channels in parameters or data_refs", async () => {
    expect(await evaluateDecision(decision({ parameters: { idea_id: FOREIGN } }), ctx)).toMatchObject({
      accepted: false,
      code: "FOREIGN_IDS",
    });
    expect(await evaluateDecision(decision({ data_refs: [`research_run:${FOREIGN}`] }), ctx)).toMatchObject({
      code: "FOREIGN_IDS",
    });
  });

  it("allows WAIT without a transition", async () => {
    expect(
      await evaluateDecision(decision({ next_action: "WAIT", parameters: {}, data_refs: [] }), ctx),
    ).toEqual({
      accepted: true,
      toState: null,
    });
  });
});

describe("referencedIds", () => {
  it("collects UUIDs from nested parameters and typed data_refs", () => {
    const ids = referencedIds(
      decision({
        parameters: { nested: { list: [OWN.toUpperCase(), "not-an-id"] }, count: 3 },
        data_refs: [`competitor_video:${FOREIGN}`, "free text"],
      }),
    );
    expect(ids.sort()).toEqual([FOREIGN, OWN].sort());
  });
});
