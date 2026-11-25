import type { PrismaClient } from "@aya/db";
import { applyTransition, enqueueJob, type TxClient } from "@aya/queue";
import { lockProject } from "./scripts";

export class SelectionError extends Error {
  constructor(
    readonly code: "IDEA_NOT_FOUND" | "NOT_SELECTABLE" | "SCRIPT_STARTED",
    message: string,
  ) {
    super(message);
    this.name = "SelectionError";
  }
}

export interface SelectIdeaInput {
  ideaId: string;
  trigger: "SYSTEM" | "USER";
  actorId?: string;
  /** 自動採用のときの判断ログ（ai_decisions）の ID */
  decisionId?: string;
}

export interface SelectIdeaResult {
  projectId: string;
  projectCode: string;
  /** 既に採用済みの企画を差し替えた */
  swapped: boolean;
  /** 既にこの企画が採用されていた（何もしていない） */
  unchanged: boolean;
}

/** 動画プロジェクトの連番（VP-0001） */
async function nextProjectCode(tx: TxClient): Promise<string> {
  const last = await tx.videoProject.findFirst({
    where: { code: { startsWith: "VP-" } },
    orderBy: { code: "desc" },
  });
  const n = last ? Number(last.code.slice(3)) + 1 : 1;
  return `VP-${String(Number.isFinite(n) ? n : 1).padStart(4, "0")}`;
}

/**
 * 企画を採用して動画プロジェクトを作り、台本生成ジョブを登録する（ADR-006）。
 * - 自動採用（AUTO_TOP）と担当者の手動選択の両方で使う
 * - 台本生成が始まる前なら、採用した企画を別の案に差し替えられる（登録済みの台本生成ジョブは取り消す）
 * - 同じ企画をもう一度選んでも何も変わらない
 */
export async function selectIdea(prisma: PrismaClient, input: SelectIdeaInput): Promise<SelectIdeaResult> {
  // 連番の採番が同時実行で衝突した場合（一意制約違反）は 1 回だけやり直す
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction((tx) => selectInTx(tx, input));
    } catch (err) {
      const conflict = err instanceof Error && "code" in err && err.code === "P2002";
      if (!conflict || attempt >= 1) throw err;
    }
  }
}

async function selectInTx(tx: TxClient, input: SelectIdeaInput): Promise<SelectIdeaResult> {
  const idea = await tx.videoIdea.findUnique({ where: { id: input.ideaId }, include: { researchRun: true } });
  if (!idea) throw new SelectionError("IDEA_NOT_FOUND", "企画が見つかりません");
  const run = idea.researchRun;
  const project = await tx.videoProject.findFirst({
    where: { idea: { researchRunId: run.id }, deletedAt: null },
    include: { scripts: { select: { id: true }, take: 1 } },
  });

  if (!project) {
    if (run.state !== "WAITING_IDEA_SELECTION") {
      throw new SelectionError(
        "NOT_SELECTABLE",
        `この市場分析は企画を選べる状態ではありません（${run.state}）`,
      );
    }
    const created = await tx.videoProject.create({
      data: {
        channelId: idea.channelId,
        ideaId: idea.id,
        code: await nextProjectCode(tx),
        state: "SCRIPT_GENERATION",
        format: "SHORTS_9_16",
      },
    });
    await tx.videoIdea.update({ where: { id: idea.id }, data: { status: "SELECTED" } });
    await tx.workflowTransition.create({
      data: {
        entityType: "PROJECT",
        entityId: created.id,
        fromState: null,
        toState: "SCRIPT_GENERATION",
        trigger: input.trigger,
        actorId: input.actorId ?? null,
        decisionId: input.decisionId ?? null,
      },
    });
    // 市場分析としてはここで完了（以降は動画プロジェクトが進める）
    await applyTransition(tx, {
      entityType: "RESEARCH_RUN",
      entityId: run.id,
      from: "WAITING_IDEA_SELECTION",
      to: "SCRIPT_GENERATION",
      trigger: input.trigger,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    });
    await tx.researchRun.update({ where: { id: run.id }, data: { completedAt: new Date() } });
    await enqueueScript(tx, created.id, idea.id, idea.channelId);
    return { projectId: created.id, projectCode: created.code, swapped: false, unchanged: false };
  }

  // 台本の保存（worker）と同時に差し替えないよう、プロジェクトをロックしてから確かめ直す
  await lockProject(tx, project.id);
  const fresh = await tx.videoProject.findUniqueOrThrow({
    where: { id: project.id },
    include: { scripts: { select: { id: true }, take: 1 } },
  });
  if (fresh.ideaId === idea.id) {
    return { projectId: project.id, projectCode: project.code, swapped: false, unchanged: true };
  }
  if (fresh.state !== "SCRIPT_GENERATION" || fresh.scripts.length > 0) {
    throw new SelectionError("SCRIPT_STARTED", "台本の生成が始まっているため、企画を差し替えられません");
  }

  // 差し替え: 前の企画を候補に戻し、未実行の台本生成ジョブを取り消して、新しい企画で登録し直す
  if (fresh.ideaId) {
    await tx.videoIdea.update({ where: { id: fresh.ideaId }, data: { status: "PROPOSED" } });
  }
  await tx.videoIdea.update({ where: { id: idea.id }, data: { status: "SELECTED" } });
  await tx.videoProject.update({ where: { id: project.id }, data: { ideaId: idea.id } });
  await tx.workflowJob.updateMany({
    where: { projectId: project.id, jobType: "generate_script", status: "QUEUED" },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      errorMessage: "企画が差し替えられたため取り消しました",
    },
  });
  await enqueueScript(tx, project.id, idea.id, idea.channelId);
  return { projectId: project.id, projectCode: project.code, swapped: true, unchanged: false };
}

function enqueueScript(tx: TxClient, projectId: string, ideaId: string, channelId: string) {
  return enqueueJob(tx, {
    jobType: "generate_script",
    idempotencyKey: `generate_script:${projectId}:${ideaId}`,
    // 差し替えの後に古い企画のジョブが動いても台本を作らないよう、企画の ID も渡す
    input: { projectId, ideaId },
    channelId,
    projectId,
  });
}
