import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicClaudeProvider, FALLBACK_BETA, type LlmTask, ProviderError, toProviderError } from "../src";

const Schema = z.object({ title: z.string(), scenes: z.number().int() });

const task: LlmTask<z.infer<typeof Schema>> = {
  operation: "generate_script",
  schema: Schema,
  system: [
    { text: "あなたは動画ディレクターです。", cache: true },
    { text: "チャンネル設定: AI・副業", cache: true },
    { text: "毎回変わる補足" },
  ],
  prompt: "台本を作ってください",
  effort: "high",
};

type FakeMessage = {
  model?: string;
  stop_reason: string;
  stop_details?: { category: string | null; explanation: string | null } | null;
  text: string;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>;
};

/** SDK の beta.messages.stream を置き換える偽クライアント（送ったリクエストを記録する） */
function fakeClient(responses: (FakeMessage | Error)[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(params);
          const next = responses.shift();
          if (!next) throw new Error("no more fake responses");
          return {
            request_id: `req_${requests.length}`,
            finalMessage: async () => {
              if (next instanceof Error) throw next;
              return {
                model: next.model ?? "claude-opus-5-5",
                stop_reason: next.stop_reason,
                stop_details: next.stop_details ?? null,
                content: [{ type: "text", text: next.text }],
                usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  ...next.usage,
                },
              };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, "beta">, requests };
}

describe("AnthropicClaudeProvider", () => {
  it("sends a structured-output request with adaptive thinking, effort, fallback and cache breakpoints", async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: "end_turn",
        text: '{"title":"AI副業3選","scenes":6}',
        usage: { cache_read_input_tokens: 40 },
      },
    ]);
    let t = 1000;
    const provider = new AnthropicClaudeProvider({ apiKey: "unused", client, now: () => (t += 250) });
    const result = await provider.complete(task);

    expect(result).toMatchObject({
      data: { title: "AI副業3選", scenes: 6 },
      requestedModel: "claude-opus-5-5",
      model: "claude-opus-5-5",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0 },
      requestId: "req_1",
      latencyMs: 250,
      schemaRetries: 0,
    });

    const req = requests[0] as {
      model: string;
      betas: string[];
      fallbacks: unknown;
      thinking: unknown;
      output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } };
      system: { text: string; cache_control?: unknown }[];
      messages: unknown[];
    };
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.betas).toEqual([FALLBACK_BETA]);
    expect(req.fallbacks).toBe("default");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config.effort).toBe("high");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.format.schema).toMatchObject({ type: "object" });
    expect(req.system.map((b) => b.cache_control ?? null)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
      null,
    ]);
    expect(req.messages).toEqual([{ role: "user", content: "台本を作ってください" }]);
  });

  it("asks again when the output does not match the schema, and sums usage", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "end_turn", text: '{"title":"x"}' },
      { stop_reason: "end_turn", text: '{"title":"x","scenes":3}' },
    ]);
    const result = await new AnthropicClaudeProvider({ apiKey: "unused", client }).complete(task);
    expect(result.schemaRetries).toBe(1);
    expect(result.usage.inputTokens).toBe(200);
    expect(JSON.stringify(requests[1])).toContain("形式に合いませんでした");
  });

  it("gives up after the retry limit with a non-retryable error that carries usage", async () => {
    const { client } = fakeClient([
      { stop_reason: "end_turn", text: "not json" },
      { stop_reason: "end_turn", text: "{}" },
      { stop_reason: "end_turn", text: '{"title":1}' },
    ]);
    const err = await new AnthropicClaudeProvider({ apiKey: "unused", client })
      .complete(task)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "CLAUDE_INVALID_OUTPUT", retryable: false });
    expect(err.details.usage.inputTokens).toBe(300);
  });

  it("checks stop_reason before reading the content", async () => {
    const refusal = fakeClient([
      {
        stop_reason: "refusal",
        stop_details: { category: "cyber", explanation: "declined" },
        text: '{"title":"x","scenes":1}',
      },
    ]);
    await expect(
      new AnthropicClaudeProvider({ apiKey: "u", client: refusal.client }).complete(task),
    ).rejects.toMatchObject({
      code: "CLAUDE_REFUSAL",
      retryable: false,
      details: { category: "cyber" },
    });

    const truncated = fakeClient([{ stop_reason: "max_tokens", text: '{"title":"x"' }]);
    await expect(
      new AnthropicClaudeProvider({ apiKey: "u", client: truncated.client }).complete(task),
    ).rejects.toMatchObject({ code: "CLAUDE_MAX_TOKENS", retryable: false });
  });

  it("reports the model that actually answered after a fallback", async () => {
    const { client } = fakeClient([
      { model: "claude-opus-4-8", stop_reason: "end_turn", text: '{"title":"x","scenes":1}' },
    ]);
    const result = await new AnthropicClaudeProvider({ apiKey: "u", client }).complete(task);
    expect(result).toMatchObject({ requestedModel: "claude-opus-5-5", model: "claude-opus-4-8" });
  });

  it("rejects more than 4 cache breakpoints", async () => {
    const { client } = fakeClient([]);
    const many = { ...task, system: Array.from({ length: 5 }, (_, i) => ({ text: `b${i}`, cache: true })) };
    await expect(new AnthropicClaudeProvider({ apiKey: "u", client }).complete(many)).rejects.toMatchObject({
      code: "CLAUDE_BAD_REQUEST",
    });
  });
});

describe("toProviderError", () => {
  const headers = new Headers();
  it("marks transient failures retryable and request/auth problems final", () => {
    expect(toProviderError(new Anthropic.RateLimitError(429, {}, "rate", headers))).toMatchObject({
      code: "CLAUDE_RATE_LIMITED",
      retryable: true,
    });
    expect(toProviderError(new Anthropic.InternalServerError(529, {}, "overloaded", headers))).toMatchObject({
      retryable: true,
    });
    expect(toProviderError(new Anthropic.APIConnectionError({ message: "reset" }))).toMatchObject({
      code: "CLAUDE_CONNECTION",
      retryable: true,
    });
    expect(toProviderError(new Anthropic.AuthenticationError(401, {}, "bad key", headers))).toMatchObject({
      code: "CLAUDE_AUTH",
      retryable: false,
    });
    expect(toProviderError(new Anthropic.BadRequestError(400, {}, "bad", headers))).toMatchObject({
      code: "CLAUDE_BAD_REQUEST",
      retryable: false,
    });
  });

  it("does not leak the API key in messages", () => {
    const err = toProviderError(
      new Anthropic.AuthenticationError(401, {}, "invalid x-api-key sk-ant-secret", headers),
    );
    expect(err.message).not.toContain("sk-ant");
  });
});
