import { MIN_ORIGINALITY_SCORE } from "./scoring";

/**
 * 企画の自動採用（ADR-006: AUTO_TOP）。
 * Originality が基準以上で、コピーリスク・ポリシーリスクが HIGH でない企画のうち Trend Score が最も高いもの。
 * 同点なら Originality が高い方。条件を満たす企画が無ければ採用せず、担当者の選択を待つ。
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface IdeaCandidate {
  id: string;
  label: string;
  trendScore: number;
  originalityScore: number;
  copyRisk: RiskLevel;
  policyRisk: RiskLevel;
}

export type IneligibleReason = "LOW_ORIGINALITY" | "COPY_RISK_HIGH" | "POLICY_RISK_HIGH";

export function ineligibleReasons(
  idea: IdeaCandidate,
  minOriginality = MIN_ORIGINALITY_SCORE,
): IneligibleReason[] {
  const reasons: IneligibleReason[] = [];
  if (idea.originalityScore < minOriginality) reasons.push("LOW_ORIGINALITY");
  if (idea.copyRisk === "HIGH") reasons.push("COPY_RISK_HIGH");
  if (idea.policyRisk === "HIGH") reasons.push("POLICY_RISK_HIGH");
  return reasons;
}

export type AutoSelection<T extends IdeaCandidate> =
  | { selected: T; reason: string }
  | { selected: null; reason: string; rejected: { label: string; reasons: IneligibleReason[] }[] };

const REASON_LABEL: Record<IneligibleReason, string> = {
  LOW_ORIGINALITY: `Originality ${MIN_ORIGINALITY_SCORE} 未満`,
  COPY_RISK_HIGH: "コピーリスクが高い",
  POLICY_RISK_HIGH: "ポリシーリスクが高い",
};

export function describeIneligible(reasons: readonly IneligibleReason[]): string {
  return reasons.map((r) => REASON_LABEL[r]).join("・");
}

export function selectAutoTop<T extends IdeaCandidate>(ideas: readonly T[]): AutoSelection<T> {
  const eligible = ideas.filter((i) => ineligibleReasons(i).length === 0);
  if (eligible.length === 0) {
    const rejected = ideas.map((i) => ({ label: i.label, reasons: ineligibleReasons(i) }));
    return {
      selected: null,
      reason: `自動採用の条件を満たす企画がありません（${rejected.map((r) => `${r.label}: ${describeIneligible(r.reasons)}`).join(" / ")}）`,
      rejected,
    };
  }
  const [best] = [...eligible].sort(
    (a, b) =>
      b.trendScore - a.trendScore ||
      b.originalityScore - a.originalityScore ||
      a.label.localeCompare(b.label),
  );
  const chosen = best as T;
  return {
    selected: chosen,
    reason: `条件を満たす ${eligible.length} 案のうち Trend Score が最も高い ${chosen.label} 案（Trend ${chosen.trendScore} / Originality ${chosen.originalityScore}）を採用しました`,
  };
}
