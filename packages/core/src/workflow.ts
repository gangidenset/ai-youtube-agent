/**
 * Workflow の状態と許可遷移（docs/workflow.md）。
 * 状態の永続化・ガード（予算・クォータ・人間承認）は Issue #5 で実装する。
 */
export const WORKFLOW_STATES = [
  "IDLE",
  "MARKET_RESEARCH",
  "TREND_ANALYSIS",
  "IDEA_GENERATION",
  "WAITING_IDEA_SELECTION",
  "SCRIPT_GENERATION",
  "VIDEO_GENERATION",
  "VOICE_GENERATION",
  "VIDEO_EDITING",
  "PLATFORM_OPTIMIZATION",
  "QUALITY_CHECK",
  "WAITING_APPROVAL",
  "REVISING",
  "READY_FOR_DOWNLOAD",
  "PUBLISHING",
  "SCHEDULED",
  "PERFORMANCE_ANALYSIS",
  "LEARNING",
  "NEXT_CYCLE",
  "PAUSED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const TERMINAL: readonly WorkflowState[] = ["REJECTED", "CANCELLED"];

const TRANSITIONS: Readonly<Partial<Record<WorkflowState, readonly WorkflowState[]>>> = {
  IDLE: ["MARKET_RESEARCH"],
  MARKET_RESEARCH: ["TREND_ANALYSIS"],
  TREND_ANALYSIS: ["IDEA_GENERATION"],
  IDEA_GENERATION: ["WAITING_IDEA_SELECTION"],
  WAITING_IDEA_SELECTION: ["SCRIPT_GENERATION"],
  // Phase 1 は台本の段階で SNS 別テキストを作り、承認へ進む
  SCRIPT_GENERATION: ["VIDEO_GENERATION", "PLATFORM_OPTIMIZATION"],
  VIDEO_GENERATION: ["VOICE_GENERATION"],
  VOICE_GENERATION: ["VIDEO_EDITING"],
  VIDEO_EDITING: ["PLATFORM_OPTIMIZATION"],
  PLATFORM_OPTIMIZATION: ["QUALITY_CHECK", "WAITING_APPROVAL"],
  QUALITY_CHECK: ["WAITING_APPROVAL", "REVISING"],
  WAITING_APPROVAL: ["READY_FOR_DOWNLOAD", "REVISING", "REJECTED"],
  REVISING: ["SCRIPT_GENERATION", "VIDEO_GENERATION", "VOICE_GENERATION", "PLATFORM_OPTIMIZATION"],
  READY_FOR_DOWNLOAD: ["PUBLISHING", "PERFORMANCE_ANALYSIS"],
  PUBLISHING: ["SCHEDULED", "PERFORMANCE_ANALYSIS"],
  SCHEDULED: ["PERFORMANCE_ANALYSIS"],
  PERFORMANCE_ANALYSIS: ["LEARNING"],
  LEARNING: ["NEXT_CYCLE"],
  NEXT_CYCLE: ["IDLE", "MARKET_RESEARCH"],
};

/** 遷移表にない遷移は、Claude が提案しても実行しない。PAUSED / FAILED / CANCELLED へはいつでも移れる。 */
export function canTransition(from: WorkflowState, to: WorkflowState, resumeTo?: WorkflowState): boolean {
  if (TERMINAL.includes(from)) return false;
  if (to === "PAUSED" || to === "FAILED" || to === "CANCELLED") return from !== to;
  // 一時停止・失敗からは、止まった状態（resumeTo）にだけ戻れる
  if (from === "PAUSED" || from === "FAILED") return resumeTo !== undefined && to === resumeTo;
  return TRANSITIONS[from]?.includes(to) ?? false;
}
