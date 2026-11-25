import { ProviderError } from "../errors";
import type { ClaudeProvider, LlmResult, LlmTask } from "./types";

export type MockResponder = (task: LlmTask<unknown>) => unknown;

/**
 * API キーなしで動く ClaudeProvider（ローカル開発・CI 用）。
 * operation ごとに応答を返す関数を登録する。出力は本物と同じく Zod で検証する。
 */
export class MockClaudeProvider implements ClaudeProvider {
  readonly mode = "mock" as const;
  readonly calls: LlmTask<unknown>[] = [];

  constructor(private readonly responders: Record<string, MockResponder> = {}) {}

  register(operation: string, responder: MockResponder): void {
    this.responders[operation] = responder;
  }

  async complete<T>(task: LlmTask<T>): Promise<LlmResult<T>> {
    this.calls.push(task as LlmTask<unknown>);
    const responder = this.responders[task.operation];
    if (!responder) {
      throw new ProviderError(
        "MOCK_NOT_CONFIGURED",
        `mock の応答が登録されていません: ${task.operation}`,
        false,
      );
    }
    const checked = task.schema.safeParse(responder(task as LlmTask<unknown>));
    if (!checked.success) {
      throw new ProviderError(
        "CLAUDE_INVALID_OUTPUT",
        `mock の応答が Schema に合いません: ${checked.error.message}`,
        false,
      );
    }
    return {
      data: checked.data,
      requestedModel: task.model ?? "mock",
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestId: null,
      latencyMs: 0,
      schemaRetries: 0,
    };
  }
}
