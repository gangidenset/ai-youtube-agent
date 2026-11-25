import type { WorkflowState } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import type { ClaudeProvider, LlmResult, LlmTask, LlmUsage } from "@aya/providers";
import { ProviderError } from "@aya/providers";
import { computeTokenCostUsd, loadTokenPrices } from "./cost";
import type { Decision, DecisionVerdict } from "./decision";

export interface CallContext {
  jobId?: string | null;
  channelId?: string | null;
  projectId?: string | null;
}

/** Claude の呼び出し 1 回分を ai_costs に記録する（失敗した呼び出しでも、使ったトークン分は記録する）。 */
export async function recordClaudeUsage(
  prisma: PrismaClient,
  ctx: CallContext,
  call: { operation: string; model: string; usage: LlmUsage; requestId?: string | null; latencyMs?: number },
): Promise<number> {
  const prices = await loadTokenPrices(prisma, "anthropic", call.model).catch(() => null);
  const costUsd = prices ? computeTokenCostUsd(call.usage, prices) : 0;
  await prisma.aiCost.create({
    data: {
      jobId: ctx.jobId ?? null,
      channelId: ctx.channelId ?? null,
      projectId: ctx.projectId ?? null,
      provider: "anthropic",
      model: call.model,
      operation: call.operation,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      cacheReadTokens: call.usage.cacheReadTokens,
      cacheWriteTokens: call.usage.cacheWriteTokens,
      costUsd,
      // 単価表から計算した見積（請求額の確定値ではない）。単価が無いモデルは 0 として残し、後で補正できるようにする
      estimated: true,
      requestId: call.requestId ?? null,
      latencyMs: call.latencyMs ?? null,
    },
  });
  return costUsd;
}

/**
 * Claude を呼び、結果に関係なく使用量を記録する。
 * mock では費用が発生しないので記録しない。
 */
export async function completeAndRecord<T>(
  prisma: PrismaClient,
  claude: ClaudeProvider,
  task: LlmTask<T>,
  ctx: CallContext,
): Promise<{ result: LlmResult<T>; costUsd: number }> {
  try {
    const result = await claude.complete(task);
    const costUsd =
      claude.mode === "live"
        ? await recordClaudeUsage(prisma, ctx, {
            operation: task.operation,
            model: result.model,
            usage: result.usage,
            requestId: result.requestId,
            latencyMs: result.latencyMs,
          })
        : 0;
    return { result, costUsd };
  } catch (err) {
    const usage = err instanceof ProviderError ? (err.details?.["usage"] as LlmUsage | undefined) : undefined;
    if (claude.mode === "live" && usage) {
      await recordClaudeUsage(prisma, ctx, {
        operation: task.operation,
        model: task.model ?? "claude-opus-5-5",
        usage,
      });
    }
    throw err;
  }
}

/** Claude の判断と、ガードの結果（実行したか・拒否理由）を ai_decisions に残す（監査ログ）。 */
export async function recordDecision(
  prisma: PrismaClient,
  input: {
    decision: Decision;
    verdict: DecisionVerdict;
    state: WorkflowState;
    model: string;
    promptVersion: string;
    requestId?: string | null;
    channelId?: string | null;
    projectId?: string | null;
    researchRunId?: string | null;
  },
): Promise<string> {
  const row = await prisma.aiDecision.create({
    data: {
      channelId: input.channelId ?? null,
      projectId: input.projectId ?? null,
      researchRunId: input.researchRunId ?? null,
      state: input.state,
      nextAction: input.decision.next_action,
      reason: input.decision.reason,
      confidence: input.decision.confidence,
      parameters: input.decision.parameters as object,
      dataRefs: input.decision.data_refs,
      accepted: input.verdict.accepted,
      rejectedReason: input.verdict.accepted ? null : `${input.verdict.code}: ${input.verdict.reason}`,
      model: input.model,
      promptVersion: input.promptVersion,
      requestId: input.requestId ?? null,
    },
  });
  return row.id;
}
