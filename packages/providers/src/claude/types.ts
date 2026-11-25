import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** システムプロンプトの 1 ブロック。変わらない部分を先頭に置き、cache を付けるとプロンプトキャッシュの区切りになる。 */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/**
 * Claude に 1 回の構造化出力を依頼するタスク。
 * 出力は schema（Zod）で JSON Schema を指定し、受信後にもう一度 Zod で検証する。
 */
export interface LlmTask<T> {
  /** 処理の名前（ai_costs.operation に記録。例: generate_script） */
  operation: string;
  schema: z.ZodType<T>;
  /** 安定した順に並べる（役割・ルール → チャンネル設定 → 成功パターン）。最大 3 ブロックにキャッシュを付けられる */
  system: SystemBlock[];
  /** 毎回変わる入力（市場データ・指示など）。外部テキストは wrapExternalData で包むこと */
  prompt: string;
  effort: Effort;
  /** 省略時は既定モデル（claude-opus-5-5） */
  model?: string;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResult<T> {
  data: T;
  /** リクエストしたモデル */
  requestedModel: string;
  /** 実際に応答したモデル（拒否時のフォールバックで変わることがある） */
  model: string;
  usage: LlmUsage;
  requestId: string | null;
  latencyMs: number;
  /** 出力が Schema に合わず再要求した回数 */
  schemaRetries: number;
}

export interface ClaudeProvider {
  readonly mode: "live" | "mock";
  complete<T>(task: LlmTask<T>): Promise<LlmResult<T>>;
}
