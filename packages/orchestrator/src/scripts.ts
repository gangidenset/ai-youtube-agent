import type { PrismaClient } from "@aya/db";
import { applyTransition, enqueueJob, type TxClient } from "@aya/queue";
import type { Script } from "@aya/schemas";
import type { RevisionScope } from "./tasks/generate-script";

/**
 * 動画プロジェクトの行をロックする。台本の保存・企画の差し替え・修正の受付が同時に走っても、
 * 「台本がまだ無い」「修正中ではない」などの確認と更新の間に他の処理が割り込まないようにする。
 */
export async function lockProject(tx: TxClient, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM video_projects WHERE id = ${projectId}::uuid FOR UPDATE`;
}

export interface SaveScriptInput {
  projectId: string;
  script: Script;
  createdBy: "AI" | "USER";
  parentVersion?: number | null;
  revisionId?: string | null;
}

/** 台本を新しい版として保存する（scripts + video_scenes）。プロジェクトの現在の版も更新する。 */
export async function saveScriptVersion(
  tx: TxClient,
  input: SaveScriptInput,
): Promise<{ scriptId: string; version: number }> {
  const last = await tx.script.findFirst({
    where: { projectId: input.projectId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (last?.version ?? 0) + 1;
  const created = await tx.script.create({
    data: {
      projectId: input.projectId,
      version,
      parentVersion: input.parentVersion ?? null,
      content: input.script,
      createdBy: input.createdBy,
      revisionId: input.revisionId ?? null,
      scenes: {
        create: input.script.scenes.map((s) => ({
          sceneNumber: s.scene_number,
          priority: s.priority,
          durationSec: s.duration,
          visualPrompt: s.visual_prompt,
          narration: s.narration,
          subtitle: s.subtitle,
          soundEffect: s.sound_effect,
          transition: s.transition,
        })),
      },
    },
  });
  await tx.videoProject.update({ where: { id: input.projectId }, data: { currentScriptVersion: version } });
  return { scriptId: created.id, version };
}

// ---------------------------------------------------------------- 修正の受付

export class RevisionError extends Error {
  constructor(
    readonly code: "PROJECT_NOT_FOUND" | "NO_SCRIPT" | "NOT_REVISABLE" | "REVISION_IN_PROGRESS",
    message: string,
  ) {
    super(message);
    this.name = "RevisionError";
  }
}

/** 修正を受け付ける状態。WAITING_APPROVAL は REVISING に進める。SCRIPT_GENERATION は台本ができた後だけ */
const REVISABLE_STATES = ["SCRIPT_GENERATION", "WAITING_APPROVAL"] as const;

export interface RequestRevisionInput {
  projectId: string;
  instruction: string;
  scope: RevisionScope;
  actorId: string;
  /** 同じキーで再送されたら同じ修正を返す */
  idempotencyKey: string;
}

export interface RequestRevisionResult {
  revisionId: string;
  jobId: string;
  fromVersion: number;
  /** 既に同じキーで受け付けていた */
  duplicate: boolean;
}

/**
 * 修正指示を受け付ける（docs/workflow.md: 修正フロー）。
 * project_revisions に記録し、revise ジョブを登録する。台本の書き換えは worker が行う。
 */
export async function requestRevision(
  prisma: PrismaClient,
  input: RequestRevisionInput,
): Promise<RequestRevisionResult> {
  // 同じキーの同時送信で一意制約違反になったら、1 回だけやり直して既存の修正を返す
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction((tx) => requestInTx(tx, input));
    } catch (err) {
      const conflict = err instanceof Error && "code" in err && err.code === "P2002";
      if (!conflict || attempt >= 1) throw err;
    }
  }
}

async function requestInTx(tx: TxClient, input: RequestRevisionInput): Promise<RequestRevisionResult> {
  const idempotencyKey = `revise:${input.projectId}:${input.idempotencyKey}`;
  const existing = await tx.workflowJob.findUnique({ where: { idempotencyKey } });
  if (existing) {
    const revisionId = (existing.input as { revisionId?: string } | null)?.revisionId ?? "";
    const revision = revisionId ? await tx.projectRevision.findUnique({ where: { id: revisionId } }) : null;
    return {
      revisionId,
      jobId: existing.id,
      fromVersion: revision?.fromVersion ?? 0,
      duplicate: true,
    };
  }

  await lockProject(tx, input.projectId);
  const project = await tx.videoProject.findFirst({ where: { id: input.projectId, deletedAt: null } });
  if (!project) throw new RevisionError("PROJECT_NOT_FOUND", "動画プロジェクトが見つかりません");
  if (project.currentScriptVersion === null) {
    throw new RevisionError("NO_SCRIPT", "台本ができてから修正を依頼してください");
  }
  if (!(REVISABLE_STATES as readonly string[]).includes(project.state)) {
    throw new RevisionError("NOT_REVISABLE", `今の状態（${project.state}）では修正を受け付けられません`);
  }
  const active = await tx.workflowJob.findFirst({
    where: {
      projectId: project.id,
      jobType: { in: ["generate_script", "revise"] },
      status: { in: ["QUEUED", "RUNNING"] },
    },
  });
  if (active) {
    throw new RevisionError("REVISION_IN_PROGRESS", "前の修正（または台本の生成）が終わるまでお待ちください");
  }

  const revision = await tx.projectRevision.create({
    data: {
      projectId: project.id,
      fromVersion: project.currentScriptVersion,
      instruction: input.instruction,
      requestedBy: input.actorId,
      diffSummary: { requestedScope: input.scope },
    },
  });
  if (project.state === "WAITING_APPROVAL") {
    await applyTransition(tx, {
      entityType: "PROJECT",
      entityId: project.id,
      from: "WAITING_APPROVAL",
      to: "REVISING",
      trigger: "USER",
      actorId: input.actorId,
    });
  }
  const { job } = await enqueueJob(tx, {
    jobType: "revise",
    idempotencyKey,
    input: { projectId: project.id, revisionId: revision.id, scope: input.scope },
    channelId: project.channelId,
    projectId: project.id,
  });
  return { revisionId: revision.id, jobId: job.id, fromVersion: revision.fromVersion, duplicate: false };
}
