/**
 * ジョブの種類と、どのキューで実行するか（docs/workflow.md「Job 共通仕様」）。
 * キューを分けることで、外部 API ごとに並列数・レート制限を変え、1 つの API の障害が他を止めないようにする。
 */

export const QUEUE_NAMES = ["llm", "youtube", "analytics"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueSettings {
  /** 同時に処理するジョブ数（ワーカー 1 プロセスあたり） */
  concurrency: number;
  /** 一定時間あたりの最大処理数（外部 API のレート制限に合わせる） */
  limiter?: { max: number; durationMs: number };
}

export const QUEUE_SETTINGS: Readonly<Record<QueueName, QueueSettings>> = {
  llm: { concurrency: 4, limiter: { max: 30, durationMs: 60_000 } },
  youtube: { concurrency: 2, limiter: { max: 5, durationMs: 1_000 } },
  analytics: { concurrency: 2 },
};

export interface JobDefinition {
  queue: QueueName;
  /** 最大試行回数（初回を含む）。超えたら FAILED */
  maxAttempts: number;
}

/** Phase 1 のジョブ。動画生成・音声・レンダリング・投稿は Phase 2 以降で専用キューとともに追加する。 */
export const JOB_DEFINITIONS = {
  market_research: { queue: "youtube", maxAttempts: 3 },
  trend_analysis: { queue: "llm", maxAttempts: 3 },
  generate_idea: { queue: "llm", maxAttempts: 3 },
  generate_script: { queue: "llm", maxAttempts: 3 },
  optimize_platforms: { queue: "llm", maxAttempts: 3 },
  quality_check: { queue: "llm", maxAttempts: 3 },
  revise: { queue: "llm", maxAttempts: 3 },
  analyze_performance: { queue: "analytics", maxAttempts: 5 },
  learn: { queue: "llm", maxAttempts: 3 },
} as const satisfies Record<string, JobDefinition>;

export type JobType = keyof typeof JOB_DEFINITIONS;

export function isJobType(value: string): value is JobType {
  return Object.hasOwn(JOB_DEFINITIONS, value);
}

export function jobDefinition(jobType: JobType): JobDefinition {
  return JOB_DEFINITIONS[jobType];
}
