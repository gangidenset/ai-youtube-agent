import { diffScripts } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import {
  applyRevisionScope,
  buildReviseScriptTask,
  lockProject,
  REVISE_SCRIPT_PROMPT_VERSION,
  REVISION_SCOPES,
  type ReviseScriptRequest,
  saveScriptVersion,
} from "@aya/orchestrator";
import type { ClaudeProvider } from "@aya/providers";
import { applyTransition, type JobHandler, NonRetryableError } from "@aya/queue";
import { ScriptSchema } from "@aya/schemas";
import { z } from "zod";
import { completeCheckedScript, toChannelInput, toIdeaInput } from "./generate-script";

export const ReviseInput = z.object({
  projectId: z.uuid(),
  revisionId: z.uuid(),
  scope: z.enum(REVISION_SCOPES).default("SCRIPT"),
});

export interface ReviseDeps {
  prisma: PrismaClient;
  claude: ClaudeProvider;
}

/**
 * 修正ジョブ（docs/workflow.md: 修正フロー）。
 * 1. 今の台本・修正指示・企画の核を Claude に渡し、新しい台本を受け取る
 * 2. 修正の範囲と target を機械的に守り（applyRevisionScope）、NG ワード・断定表現を確認する
 * 3. 新しい版として保存し、project_revisions に差分（変わったシーン）を記録する
 * 4. 承認待ちからの修正（REVISING）なら SCRIPT_GENERATION に戻す（以降の工程は Issue #14 / Phase 2 で接続）
 */
export function reviseHandler(deps: ReviseDeps): JobHandler {
  return async (ctx) => {
    const input = ReviseInput.parse(ctx.input);
    const revision = await deps.prisma.projectRevision.findUnique({ where: { id: input.revisionId } });
    if (!revision || revision.projectId !== input.projectId) {
      throw new NonRetryableError("REVISION_NOT_FOUND", `修正 ${input.revisionId} が見つかりません`);
    }
    if (revision.toVersion !== null) return { outputRef: `skipped:done:v${revision.toVersion}` };

    const project = await deps.prisma.videoProject.findUnique({
      where: { id: input.projectId },
      include: { idea: true, channel: { include: { settings: true } } },
    });
    if (!project || project.deletedAt) {
      throw new NonRetryableError(
        "PROJECT_NOT_FOUND",
        `動画プロジェクト ${input.projectId} が見つかりません`,
      );
    }
    if (project.state !== "REVISING" && project.state !== "SCRIPT_GENERATION") {
      return { outputRef: `skipped:${project.state}` };
    }
    if (!project.idea) throw new NonRetryableError("NO_IDEA", "採用された企画がありません");
    const base = await deps.prisma.script.findUnique({
      where: { projectId_version: { projectId: project.id, version: revision.fromVersion } },
    });
    if (!base) throw new NonRetryableError("NO_SCRIPT", `台本の版 ${revision.fromVersion} が見つかりません`);
    const current = ScriptSchema.parse(base.content);

    const channel = toChannelInput(project.channel.settings);
    const request: ReviseScriptRequest = {
      channel,
      idea: toIdeaInput(project.idea),
      current,
      instruction: revision.instruction,
      scope: input.scope,
    };
    const { data, costUsd } = await completeCheckedScript(
      deps,
      (correction) => buildReviseScriptTask(correction ? { ...request, correction } : request),
      // 範囲外の変更は捨てたうえで確認する
      (out) => applyRevisionScope(current, out.new_script, input.scope),
      channel.ngWords,
      { jobId: ctx.job.id, channelId: project.channelId, projectId: project.id },
    );
    const next = applyRevisionScope(current, data.new_script, input.scope);
    // 範囲を機械的に制限した結果、尺の合計などが崩れていないか確かめ直す
    const checked = ScriptSchema.safeParse(next);
    if (!checked.success) {
      throw new NonRetryableError("INVALID_REVISION", "修正後の台本が形式に合いませんでした");
    }
    const diff = diffScripts(current, checked.data);

    const result = await deps.prisma.$transaction(async (tx) => {
      await lockProject(tx, project.id);
      const fresh = await tx.projectRevision.findUniqueOrThrow({ where: { id: revision.id } });
      if (fresh.toVersion !== null) return null;
      const summary = {
        requestedScope: input.scope,
        claudeScope: data.scope,
        changeSummary: data.change_summary,
        promptVersion: REVISE_SCRIPT_PROMPT_VERSION,
        unchanged: diff.unchanged,
        changedFields: diff.fields.map((f) => f.field),
        changedSceneNumbers: diff.changedSceneNumbers,
        scenes: diff.scenes.map((s) => ({ sceneNumber: s.sceneNumber, change: s.change })),
      };
      // 何も変わらなかった場合は版を増やさない（to_version = from_version）
      const saved = diff.unchanged
        ? null
        : await saveScriptVersion(tx, {
            projectId: project.id,
            script: checked.data,
            createdBy: "AI",
            parentVersion: revision.fromVersion,
            revisionId: revision.id,
          });
      await tx.projectRevision.update({
        where: { id: revision.id },
        data: { toVersion: saved?.version ?? revision.fromVersion, diffSummary: summary },
      });
      const now = await tx.videoProject.findUniqueOrThrow({
        where: { id: project.id },
        select: { state: true },
      });
      if (now.state === "REVISING") {
        await applyTransition(tx, {
          entityType: "PROJECT",
          entityId: project.id,
          from: "REVISING",
          to: "SCRIPT_GENERATION",
          trigger: "JOB",
          jobId: ctx.job.id,
        });
      }
      return saved;
    });
    if (result === null && diff.unchanged)
      return { outputRef: `revisions:${revision.id}:unchanged`, costUsd };
    return { outputRef: result ? `scripts:${result.scriptId}:v${result.version}` : "skipped:done", costUsd };
  };
}
