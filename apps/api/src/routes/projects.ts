import { diffScripts, hasPermission } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import { REVISION_SCOPES, RevisionError, requestRevision } from "@aya/orchestrator";
import { ScriptSchema } from "@aya/schemas";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/guards";
import { AppError, forbidden } from "../errors";

const Params = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() });
const DiffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});
const RevisionBody = z.object({
  instruction: z.string().trim().min(1).max(1000),
  scope: z.enum(REVISION_SCOPES).default("SCRIPT"),
});
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const notFound = () => new AppError(404, "NOT_FOUND", "見つかりません");

const REVISION_ERROR_STATUS: Record<RevisionError["code"], number> = {
  PROJECT_NOT_FOUND: 404,
  NO_SCRIPT: 409,
  NOT_REVISABLE: 409,
  REVISION_IN_PROGRESS: 409,
};

export async function projectRoutes(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  /**
   * 動画プロジェクトを読み込み、権限を確かめる。
   * 所属していないチャンネルのものは存在も見せない（404）。所属しているが権限が足りなければ 403。
   */
  async function loadProject(request: FastifyRequest, permission: "channel:read" | "channel:edit") {
    const params = Params.safeParse(request.params);
    if (!params.success) throw notFound();
    const auth = requireAuth(request);
    const project = await prisma.videoProject.findFirst({ where: { id: params.data.id, deletedAt: null } });
    if (!project) throw notFound();
    const membership = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: project.channelId, userId: auth.userId } },
      include: { channel: true },
    });
    if (!membership || membership.channel.deletedAt || !hasPermission(membership.role, "channel:read")) {
      throw notFound();
    }
    if (!hasPermission(membership.role, permission)) throw forbidden();
    return { project, auth, role: membership.role };
  }

  async function loadScript(projectId: string, version: number) {
    const script = await prisma.script.findUnique({ where: { projectId_version: { projectId, version } } });
    if (!script) throw notFound();
    // 保存時に検証済みだが、形式の変更に備えて読み出し時も確かめる
    const parsed = ScriptSchema.safeParse(script.content);
    if (!parsed.success) throw new AppError(500, "INVALID_SCRIPT", "保存されている台本の形式が不正です");
    return { row: script, content: parsed.data };
  }

  /** プロジェクトの概要・現在の台本・版の一覧・修正の履歴 */
  app.get("/api/v1/projects/:id", async (request) => {
    const { project, role } = await loadProject(request, "channel:read");
    const [idea, scripts, revisions, jobs] = await Promise.all([
      project.ideaId ? prisma.videoIdea.findUnique({ where: { id: project.ideaId } }) : null,
      prisma.script.findMany({
        where: { projectId: project.id },
        orderBy: { version: "desc" },
        select: { version: true, parentVersion: true, createdBy: true, createdAt: true, revisionId: true },
      }),
      prisma.projectRevision.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "desc" },
        include: { requester: { select: { displayName: true } } },
      }),
      prisma.workflowJob.findMany({
        where: { projectId: project.id, jobType: { in: ["generate_script", "revise"] } },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);
    const current =
      project.currentScriptVersion !== null
        ? await loadScript(project.id, project.currentScriptVersion)
        : null;
    const working = jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING");
    const lastFailed = jobs[0]?.status === "FAILED" ? jobs[0] : null;
    return {
      id: project.id,
      code: project.code,
      channelId: project.channelId,
      state: project.state,
      format: project.format,
      researchRunId: idea?.researchRunId ?? null,
      idea: idea
        ? { id: idea.id, label: idea.label, title: idea.title, theme: idea.theme, target: idea.target }
        : null,
      currentScriptVersion: project.currentScriptVersion,
      script: current?.content ?? null,
      versions: scripts,
      revisions: revisions.map((r) => ({
        id: r.id,
        fromVersion: r.fromVersion,
        toVersion: r.toVersion,
        instruction: r.instruction,
        requestedBy: r.requester?.displayName ?? null,
        summary: r.diffSummary,
        createdAt: r.createdAt,
      })),
      working,
      lastError: lastFailed ? { jobType: lastFailed.jobType, message: lastFailed.errorMessage } : null,
      canRevise:
        hasPermission(role, "channel:edit") &&
        !working &&
        project.currentScriptVersion !== null &&
        (project.state === "SCRIPT_GENERATION" || project.state === "WAITING_APPROVAL"),
    };
  });

  /** 2 つの版の差分（`/scripts/:version` より先に登録する静的なパス） */
  app.get("/api/v1/projects/:id/scripts/diff", async (request) => {
    const { project } = await loadProject(request, "channel:read");
    const query = DiffQuery.safeParse(request.query);
    if (!query.success)
      throw new AppError(400, "VALIDATION_ERROR", "from と to に版の番号を指定してください");
    const [from, to] = await Promise.all([
      loadScript(project.id, query.data.from),
      loadScript(project.id, query.data.to),
    ]);
    return { from: query.data.from, to: query.data.to, ...diffScripts(from.content, to.content) };
  });

  /** 指定した版の台本 JSON */
  app.get("/api/v1/projects/:id/scripts/:version", async (request) => {
    const params = VersionParams.safeParse(request.params);
    if (!params.success) throw notFound();
    const { project } = await loadProject(request, "channel:read");
    const script = await loadScript(project.id, params.data.version);
    return {
      version: script.row.version,
      parentVersion: script.row.parentVersion,
      createdBy: script.row.createdBy,
      createdAt: script.row.createdAt,
      content: script.content,
    };
  });

  /** 修正指示を受け付ける（台本の書き換えは worker の revise ジョブ） */
  app.post("/api/v1/projects/:id/revisions", async (request, reply) => {
    const key = IdempotencyKey.safeParse(request.headers["idempotency-key"]);
    if (!key.success) {
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key ヘッダ（8〜128 文字の英数字・記号 ._:-）が必要です",
      );
    }
    const { project, auth } = await loadProject(request, "channel:edit");
    const body = RevisionBody.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError(400, "VALIDATION_ERROR", "修正指示（1〜1000 文字）を入力してください");
    }
    try {
      const result = await requestRevision(prisma, {
        projectId: project.id,
        instruction: body.data.instruction,
        scope: body.data.scope,
        actorId: auth.userId,
        idempotencyKey: key.data,
      });
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof RevisionError) {
        throw new AppError(REVISION_ERROR_STATUS[err.code], err.code, err.message);
      }
      throw err;
    }
  });
}
