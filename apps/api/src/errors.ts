import type { FastifyError, FastifyInstance } from "fastify";

/** API のエラー応答（docs/api.md）: { error: { code, message, details?, requestId } } */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = () => new AppError(401, "UNAUTHORIZED", "ログインが必要です");
export const forbidden = () => new AppError(403, "FORBIDDEN", "この操作を行う権限がありません");

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details, requestId: request.id },
      });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    const code = status === 429 ? "RATE_LIMITED" : status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
    // 500 系は内部の詳細を返さない
    const message =
      status === 429
        ? "リクエストが多すぎます。しばらくしてから再度お試しください"
        : status >= 500
          ? "サーバーでエラーが発生しました"
          : err.message;
    return reply.status(status).send({ error: { code, message, requestId: request.id } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", message: "見つかりません", requestId: request.id } }),
  );
}
