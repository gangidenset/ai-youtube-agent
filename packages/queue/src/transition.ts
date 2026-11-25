import { canTransition, type WorkflowState } from "@aya/core";
import type { TxClient } from "./enqueue";

export class TransitionError extends Error {
  constructor(
    readonly code: "NOT_ALLOWED" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionInput {
  entityType: "PROJECT" | "RESEARCH_RUN";
  entityId: string;
  from: WorkflowState;
  to: WorkflowState;
  trigger: "JOB" | "USER" | "AI_DECISION" | "SYSTEM";
  actorId?: string;
  jobId?: string;
  decisionId?: string;
  /** PAUSED / FAILED から再開するときの戻り先（プロジェクトのみ） */
  resumeTo?: WorkflowState;
  pausedReason?: string;
  failedReason?: string;
}

/**
 * 状態を 1 つ進め、履歴（workflow_transitions）を残す。
 * - 遷移表にない遷移は拒否する（Claude が提案しても実行しない）
 * - 「現在の状態が from のときだけ更新」することで、同時に別の処理が状態を変えた場合は CONFLICT にする
 * - 次のジョブの登録（enqueueJob）は同じ tx で行うこと
 */
export async function applyTransition(tx: TxClient, input: TransitionInput): Promise<void> {
  if (!canTransition(input.from, input.to, input.resumeTo)) {
    throw new TransitionError("NOT_ALLOWED", `${input.from} から ${input.to} へは遷移できません`);
  }

  let updated: number;
  if (input.entityType === "PROJECT") {
    const res = await tx.videoProject.updateMany({
      where: { id: input.entityId, state: input.from },
      data: {
        state: input.to,
        // 一時停止・失敗したら、止まった状態を再開先として覚えておく
        resumeState: input.to === "PAUSED" || input.to === "FAILED" ? input.from : null,
        pausedReason: input.to === "PAUSED" ? (input.pausedReason ?? null) : null,
        failedReason: input.to === "FAILED" ? (input.failedReason ?? null) : null,
      },
    });
    updated = res.count;
  } else {
    const res = await tx.researchRun.updateMany({
      where: { id: input.entityId, state: input.from },
      data: { state: input.to },
    });
    updated = res.count;
  }
  if (updated === 0) {
    throw new TransitionError(
      "CONFLICT",
      `状態が ${input.from} ではないため遷移できません（他の処理が先に更新しました）`,
    );
  }

  await tx.workflowTransition.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      fromState: input.from,
      toState: input.to,
      trigger: input.trigger,
      actorId: input.actorId ?? null,
      jobId: input.jobId ?? null,
      decisionId: input.decisionId ?? null,
    },
  });
}
