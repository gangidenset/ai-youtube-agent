import type { PrismaClient } from "@aya/db";
import { generateSessionToken, hashToken } from "./tokens";

export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
/** last_seen_at の更新を間引く間隔（毎リクエストの書き込みを避ける） */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
}

/** DB に保存するセッション（トークンはハッシュのみ）。 */
export class SessionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    userId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        lastSeenAt: now,
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      },
    });
    return { token, expiresAt };
  }

  /** 有効なセッションならユーザー情報を返す（失効・期限切れ・アイドル超過・無効ユーザーは null）。 */
  async resolve(token: string): Promise<SessionInfo | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    const now = this.now();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS ||
      session.user.status !== "ACTIVE"
    ) {
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    return {
      sessionId: session.id,
      userId: session.userId,
      email: session.user.email,
      displayName: session.user.displayName,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  /** パスワード変更・ロール変更時に使う（docs/security.md） */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }
}
