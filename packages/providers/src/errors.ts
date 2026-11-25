/**
 * 外部サービスの失敗。retryable=false はやり直しても結果が変わらない失敗（入力不正・拒否・認証エラー）で、
 * ジョブ基盤（packages/queue）はこれを見て即 FAILED にする。
 */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
