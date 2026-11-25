/**
 * リトライ方針（docs/workflow.md）: 指数バックオフ + ジッター（例: 約 30 秒 → 2 分 → 8 分）。
 * 入力不正やコンテンツ拒否のように、やり直しても結果が変わらない失敗はリトライしない。
 */

export interface RetryPolicy {
  /** 1 回目のリトライまでの基準時間 */
  baseMs: number;
  /** 回数ごとの倍率 */
  factor: number;
  /** 上限 */
  maxMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseMs: 30_000, factor: 4, maxMs: 15 * 60_000 };

/**
 * failedAttempts 回失敗した後の待ち時間。半分を固定、半分をランダムにする（equal jitter）。
 * 多数のジョブが同時に失敗しても、再試行が同じ瞬間に集中しないようにするため。
 */
export function computeBackoffMs(
  failedAttempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * policy.factor ** Math.max(0, failedAttempts - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** やり直しても成功しない失敗（入力不正・コンテンツ拒否・ハンドラ未登録など）。すぐ FAILED にする。 */
export class NonRetryableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** ワーカー内部で使う: 次の試行までの待ち時間をキュー（BullMQ）に伝えるためのエラー */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
    this.name = "RetryLaterError";
  }
}

export function errorCodeOf(err: unknown): string {
  if (err instanceof NonRetryableError) return err.code;
  if (err instanceof Error && "code" in err && typeof err.code === "string") return err.code;
  return "ERROR";
}

/** エラーメッセージは DB に保存するので長さを制限する（Secret を含めないのは呼び出し側の責任） */
export function errorMessageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 2000);
}
