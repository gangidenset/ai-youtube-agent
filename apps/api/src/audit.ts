import type { LogCategory, LogLevel, PrismaClient } from "@aya/db";
import type { FastifyRequest } from "fastify";

/** system_logs への記録。context に Secret（パスワード・トークン）を入れないこと。 */
export async function writeAuditLog(
  prisma: PrismaClient,
  request: FastifyRequest,
  entry: {
    level: LogLevel;
    category: LogCategory;
    message: string;
    actorId?: string | null;
    channelId?: string | null;
    context?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  try {
    await prisma.systemLog.create({
      data: {
        level: entry.level,
        category: entry.category,
        message: entry.message,
        actorId: entry.actorId ?? null,
        channelId: entry.channelId ?? null,
        ...(entry.context ? { context: entry.context } : {}),
        ip: request.ip,
      },
    });
  } catch (err) {
    // 監査ログの書き込み失敗で本処理を止めない
    request.log.error({ err }, "failed to write audit log");
  }
}
