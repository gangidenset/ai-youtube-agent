import { canTransition, type WorkflowState } from "./workflow";

/**
 * Workflow Engine が次のジョブを実行する前に確認するガード（docs/workflow.md「遷移のガード」）。
 * すべて純粋関数。DB の集計値は呼び出し側が渡す。
 */

export type GuardFailure =
  | "TRANSITION_NOT_ALLOWED"
  | "BUDGET_PER_VIDEO"
  | "BUDGET_DAILY"
  | "BUDGET_MONTHLY"
  | "QUOTA_EXCEEDED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_STALE";

export type GuardResult =
  { ok: true; warnings: string[] } | { ok: false; code: GuardFailure; message: string };

const ok = (warnings: string[] = []): GuardResult => ({ ok: true, warnings });
const fail = (code: GuardFailure, message: string): GuardResult => ({ ok: false, code, message });

const usd = (n: number) => `${n.toFixed(2)} USD`;

// ---------------------------------------------------------------- 予算

export interface BudgetLimits {
  perVideoUsd: number;
  dailyUsd: number;
  monthlyUsd: number;
}

export interface BudgetUsage {
  projectUsd: number;
  todayUsd: number;
  monthUsd: number;
}

/** 予算の何割に達したら警告するか（docs/cost-management.md） */
export const BUDGET_WARNING_RATIO = 0.8;

/** 実績 + 見積が上限以内なら実行してよい。上限を超えるなら PAUSED(BUDGET) にする。 */
export function checkBudget(estimatedUsd: number, usage: BudgetUsage, limits: BudgetLimits): GuardResult {
  const checks = [
    {
      code: "BUDGET_PER_VIDEO",
      label: "動画 1 本あたりの予算",
      used: usage.projectUsd,
      limit: limits.perVideoUsd,
    },
    { code: "BUDGET_DAILY", label: "1 日の予算", used: usage.todayUsd, limit: limits.dailyUsd },
    { code: "BUDGET_MONTHLY", label: "1 か月の予算", used: usage.monthUsd, limit: limits.monthlyUsd },
  ] as const;

  const warnings: string[] = [];
  for (const c of checks) {
    const after = c.used + estimatedUsd;
    if (after > c.limit) {
      return fail(
        c.code,
        `${c.label}（${usd(c.limit)}）を超えます（実績 ${usd(c.used)} + 見積 ${usd(estimatedUsd)}）`,
      );
    }
    if (after >= c.limit * BUDGET_WARNING_RATIO) {
      warnings.push(`${c.label}の ${Math.round((after / c.limit) * 100)}% に達します`);
    }
  }
  return ok(warnings);
}

// ---------------------------------------------------------------- クォータ

/** 投稿 1 回分（videos.insert = 1,600 units）は常に残しておく（docs/workflow.md） */
export const YOUTUBE_UPLOAD_RESERVE_UNITS = 1600;

export interface QuotaState {
  used: number;
  limit: number;
}

/** 必要量 + 予備が残っていれば実行してよい。投稿そのものは予備を使える。 */
export function checkQuota(
  required: number,
  quota: QuotaState,
  options: { isUpload?: boolean } = {},
): GuardResult {
  const reserve = options.isUpload ? 0 : YOUTUBE_UPLOAD_RESERVE_UNITS;
  const remaining = quota.limit - quota.used;
  if (required + reserve > remaining) {
    return fail(
      "QUOTA_EXCEEDED",
      `クォータが足りません（残り ${remaining} units、必要 ${required} + 予備 ${reserve}）`,
    );
  }
  return ok();
}

// ---------------------------------------------------------------- 人間承認

/** 人間の承認が必要な遷移先（MVP はダウンロード、将来は投稿） */
export const HUMAN_GATED_STATES: readonly WorkflowState[] = ["READY_FOR_DOWNLOAD", "PUBLISHING"];

export interface ApprovalState {
  status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "REJECTED" | "REGENERATE" | null;
  /** 承認時点の内容のハッシュ */
  approvedSnapshotHash: string | null;
  /** 現在の内容のハッシュ */
  currentSnapshotHash: string;
}

/** 承認済み、かつ承認後に内容が変わっていない場合だけ通す（docs/workflow.md）。 */
export function checkApproval(approval: ApprovalState): GuardResult {
  if (approval.status !== "APPROVED") return fail("APPROVAL_REQUIRED", "担当者の承認が必要です");
  if (approval.approvedSnapshotHash !== approval.currentSnapshotHash) {
    return fail("APPROVAL_STALE", "承認後に内容が変更されています。もう一度承認してください");
  }
  return ok();
}

// ---------------------------------------------------------------- まとめて評価

export interface TransitionRequest {
  from: WorkflowState;
  to: WorkflowState;
  /** PAUSED / FAILED から再開するときの戻り先 */
  resumeTo?: WorkflowState;
  /** 遷移先の処理にかかる見積（予算を使う処理だけ） */
  budget?: { estimatedUsd: number; usage: BudgetUsage; limits: BudgetLimits };
  /** YouTube API を使う処理だけ */
  quota?: { required: number; state: QuotaState; isUpload?: boolean };
  /** 人間承認が必要な遷移先では必須 */
  approval?: ApprovalState;
}

/**
 * 遷移表 → 人間承認 → 予算 → クォータの順に確認する。
 * Claude が提案した遷移も、ここを通らなければ実行しない。
 */
export function evaluateTransition(req: TransitionRequest): GuardResult {
  if (!canTransition(req.from, req.to, req.resumeTo)) {
    return fail("TRANSITION_NOT_ALLOWED", `${req.from} から ${req.to} へは遷移できません`);
  }
  const steps: (() => GuardResult)[] = [];
  if (HUMAN_GATED_STATES.includes(req.to)) {
    const approval = req.approval;
    steps.push(() =>
      approval ? checkApproval(approval) : fail("APPROVAL_REQUIRED", "担当者の承認が必要です"),
    );
  }
  const budget = req.budget;
  if (budget) steps.push(() => checkBudget(budget.estimatedUsd, budget.usage, budget.limits));
  const quota = req.quota;
  if (quota) steps.push(() => checkQuota(quota.required, quota.state, { isUpload: quota.isUpload ?? false }));

  const warnings: string[] = [];
  for (const step of steps) {
    const result = step();
    if (!result.ok) return result;
    warnings.push(...result.warnings);
  }
  return ok(warnings);
}
