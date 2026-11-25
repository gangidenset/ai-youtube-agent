import { canTransition, HUMAN_GATED_STATES, type WorkflowState } from "@aya/core";
import { z } from "zod";

/**
 * Claude が返す「次に何をするか」の判断（docs/ai-orchestrator.md「判断スキーマ」）。
 * Claude は判断を返すだけで、実行するかどうかは Workflow Engine がこのモジュールのガードで決める。
 */
export const NEXT_ACTIONS = [
  "MARKET_RESEARCH",
  "TREND_ANALYSIS",
  "GENERATE_IDEA",
  "GENERATE_SCRIPT",
  "GENERATE_VIDEO",
  "GENERATE_VOICE",
  "RENDER_VIDEO",
  "OPTIMIZE_PLATFORMS",
  "QUALITY_CHECK",
  "REQUEST_APPROVAL",
  "REVISE",
  "PUBLISH",
  "ANALYZE_PERFORMANCE",
  "LEARN",
  "WAIT",
  "ESCALATE_TO_HUMAN",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const DecisionSchema = z.object({
  next_action: z.enum(NEXT_ACTIONS),
  reason: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  /** 実行に必要なパラメータ。ID は当該チャンネルのものかを必ず検証する */
  parameters: z.record(z.string(), z.unknown()),
  risks: z.array(z.string()),
  /** 判断の根拠にしたデータ（例: competitor_video:<id>） */
  data_refs: z.array(z.string()),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** 判断が次に向かわせる状態（WAIT / ESCALATE_TO_HUMAN は状態を進めない） */
export const ACTION_TARGET_STATE: Readonly<Record<NextAction, WorkflowState | null>> = {
  MARKET_RESEARCH: "MARKET_RESEARCH",
  TREND_ANALYSIS: "TREND_ANALYSIS",
  GENERATE_IDEA: "IDEA_GENERATION",
  GENERATE_SCRIPT: "SCRIPT_GENERATION",
  GENERATE_VIDEO: "VIDEO_GENERATION",
  GENERATE_VOICE: "VOICE_GENERATION",
  RENDER_VIDEO: "VIDEO_EDITING",
  OPTIMIZE_PLATFORMS: "PLATFORM_OPTIMIZATION",
  QUALITY_CHECK: "QUALITY_CHECK",
  REQUEST_APPROVAL: "WAITING_APPROVAL",
  REVISE: "REVISING",
  PUBLISH: "PUBLISHING",
  ANALYZE_PERFORMANCE: "PERFORMANCE_ANALYSIS",
  LEARN: "LEARNING",
  WAIT: null,
  ESCALATE_TO_HUMAN: null,
};

/** これ未満の確信度の判断は実行せず、担当者に確認を求める（docs/ai-orchestrator.md） */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** parameters と data_refs に含まれる ID（UUID）をすべて取り出す。data_refs は「種類:ID」の形式。 */
export function referencedIds(decision: Decision): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      const id = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
      if (UUID.test(id)) ids.add(id.toLowerCase());
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(decision.parameters);
  decision.data_refs.forEach(visit);
  return [...ids];
}

export type DecisionVerdict =
  | { accepted: true; toState: WorkflowState | null }
  | { accepted: false; code: DecisionRejection; reason: string; escalate: boolean };

export type DecisionRejection =
  "ESCALATED_BY_AI" | "LOW_CONFIDENCE" | "TRANSITION_NOT_ALLOWED" | "HUMAN_GATED" | "FOREIGN_IDS";

export interface DecisionContext {
  currentState: WorkflowState;
  /**
   * 指定した ID のうち、このチャンネルに属さない（または存在しない）ものを返す。
   * 別チャンネルのデータを Claude の判断経由で操作させないための確認（IDOR 防止）。
   */
  findForeignIds: (ids: string[]) => Promise<string[]>;
  confidenceThreshold?: number;
}

/**
 * 判断を実行してよいかを確認する。順番:
 * 1. Claude 自身が担当者への確認を求めた → 確認待ち
 * 2. 確信度が閾値未満 → 確認待ち
 * 3. 遷移表にない遷移 → 拒否
 * 4. 人間の承認が必要な状態（ダウンロード・投稿）へ AI が直接進もうとした → 拒否
 * 5. 他のチャンネルの ID を含む → 拒否
 */
export async function evaluateDecision(decision: Decision, ctx: DecisionContext): Promise<DecisionVerdict> {
  if (decision.next_action === "ESCALATE_TO_HUMAN") {
    return { accepted: false, code: "ESCALATED_BY_AI", reason: decision.reason, escalate: true };
  }
  const threshold = ctx.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (decision.confidence < threshold) {
    return {
      accepted: false,
      code: "LOW_CONFIDENCE",
      reason: `確信度 ${decision.confidence} が閾値 ${threshold} 未満のため担当者の確認が必要です`,
      escalate: true,
    };
  }

  const toState = ACTION_TARGET_STATE[decision.next_action];
  if (toState) {
    if (HUMAN_GATED_STATES.includes(toState)) {
      return {
        accepted: false,
        code: "HUMAN_GATED",
        reason: `${toState} へは担当者の承認なしに進めません`,
        escalate: false,
      };
    }
    if (!canTransition(ctx.currentState, toState)) {
      return {
        accepted: false,
        code: "TRANSITION_NOT_ALLOWED",
        reason: `${ctx.currentState} から ${toState} へは遷移できません`,
        escalate: false,
      };
    }
  }

  const ids = referencedIds(decision);
  if (ids.length > 0) {
    const foreign = await ctx.findForeignIds(ids);
    if (foreign.length > 0) {
      return {
        accepted: false,
        code: "FOREIGN_IDS",
        reason: `このチャンネルに属さない ID が含まれています: ${foreign.join(", ")}`,
        escalate: false,
      };
    }
  }
  return { accepted: true, toState };
}
