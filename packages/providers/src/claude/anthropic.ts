import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ProviderError } from "../errors";
import type { ClaudeProvider, LlmResult, LlmTask, LlmUsage } from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
/** 拒否されたときにサーバー側で別モデルに切り替えて続ける（refusal fallback） */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** 出力が Schema に合わないときに再要求する回数（docs/workflow.md: 最大 2 回） */
export const MAX_SCHEMA_RETRIES = 2;
const MAX_CACHE_BREAKPOINTS = 4;

export interface AnthropicClaudeOptions {
  apiKey: string;
  defaultModel?: string;
  /** テスト用。省略時は Anthropic SDK のクライアントを作る */
  client?: Pick<Anthropic, "beta">;
  now?: () => number;
}

function toUsage(message: BetaMessage): LlmUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** SDK の例外を、ジョブ基盤がリトライ可否を判断できる形に変える。 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(
      "CLAUDE_AUTH",
      "Claude API の認証に失敗しました（API キーを確認してください）",
      false,
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError("CLAUDE_NOT_FOUND", `Claude API: ${err.message}`, false);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("CLAUDE_RATE_LIMITED", "Claude API のレート制限に達しました", true);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError("CLAUDE_BAD_REQUEST", `Claude API: ${err.message}`, false);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("CLAUDE_CONNECTION", "Claude API に接続できませんでした", true);
  }
  if (err instanceof Anthropic.APIError) {
    // 5xx・529（過負荷）など
    return new ProviderError("CLAUDE_API_ERROR", `Claude API エラー（${String(err.status)}）`, true);
  }
  return new ProviderError("CLAUDE_UNKNOWN", err instanceof Error ? err.message : String(err), true);
}

/**
 * Anthropic API（公式 SDK）で構造化出力を得る ClaudeProvider。
 * - 既定モデル claude-opus-5-5、adaptive thinking（このモデルでは常に有効）、タスクごとに effort を指定
 * - 出力は output_config.format（Zod から生成した JSON Schema）で強制し、受信後に Zod で再検証
 * - 長い出力でもタイムアウトしないようストリーミングで受け取る
 * - stop_reason を確認してから読む（refusal・max_tokens）
 * - 拒否されたときはサーバー側のフォールバックで別モデルが続ける
 * - system の安定部分に cache_control を付けてプロンプトキャッシュを使う
 */
export class AnthropicClaudeProvider implements ClaudeProvider {
  readonly mode = "live" as const;
  private readonly client: Pick<Anthropic, "beta">;
  private readonly defaultModel: string;
  private readonly now: () => number;

  constructor(options: AnthropicClaudeOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.defaultModel = options.defaultModel ?? DEFAULT_CLAUDE_MODEL;
    this.now = options.now ?? Date.now;
  }

  async complete<T>(task: LlmTask<T>): Promise<LlmResult<T>> {
    const requestedModel = task.model ?? this.defaultModel;
    const cached = task.system.filter((b) => b.cache).length;
    if (cached > MAX_CACHE_BREAKPOINTS) {
      throw new ProviderError(
        "CLAUDE_BAD_REQUEST",
        `cache を付けられるブロックは ${MAX_CACHE_BREAKPOINTS} 個までです`,
        false,
      );
    }
    const system: BetaTextBlockParam[] = task.system.map((block) => ({
      type: "text",
      text: block.text,
      ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const format = betaZodOutputFormat(task.schema);

    const started = this.now();
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let lastProblem = "";

    for (let attempt = 0; attempt <= MAX_SCHEMA_RETRIES; attempt++) {
      const prompt =
        attempt === 0
          ? task.prompt
          : `${task.prompt}\n\n前回の出力は指定の形式に合いませんでした（${lastProblem}）。指定の JSON Schema に従って出力し直してください。`;

      let message: BetaMessage;
      let requestId: string | null;
      try {
        const stream = this.client.beta.messages.stream({
          model: requestedModel,
          max_tokens: task.maxTokens ?? 32_000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: task.effort, format },
          system,
          messages: [{ role: "user", content: prompt }],
        });
        message = await stream.finalMessage();
        requestId = stream.request_id ?? null;
      } catch (err) {
        throw toProviderError(err);
      }
      usage = addUsage(usage, toUsage(message));

      if (message.stop_reason === "refusal") {
        throw new ProviderError("CLAUDE_REFUSAL", "Claude が依頼を辞退しました", false, {
          category: message.stop_details?.category ?? null,
          explanation: message.stop_details?.explanation ?? null,
          usage,
        });
      }
      if (message.stop_reason === "max_tokens") {
        throw new ProviderError(
          "CLAUDE_MAX_TOKENS",
          "出力が上限（max_tokens）に達して途中で切れました",
          false,
          { usage },
        );
      }

      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const parsed = safeJson(text);
      const checked = parsed.ok ? task.schema.safeParse(parsed.value) : null;
      if (checked?.success) {
        return {
          data: checked.data,
          requestedModel,
          model: message.model,
          usage,
          requestId,
          latencyMs: this.now() - started,
          schemaRetries: attempt,
        };
      }
      lastProblem = checked
        ? checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : "JSON ではありません";
    }

    throw new ProviderError(
      "CLAUDE_INVALID_OUTPUT",
      `出力が Schema に合いませんでした: ${lastProblem}`,
      false,
      { usage },
    );
  }
}

function safeJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
