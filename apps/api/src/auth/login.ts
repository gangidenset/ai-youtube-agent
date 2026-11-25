import { hashPassword, type PrismaClient, verifyPassword } from "@aya/db";

/** 連続失敗でロックする回数と時間（docs/security.md） */
export const MAX_FAILED_LOGINS = 10;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "INVALID_CREDENTIALS" | "LOCKED" | "DISABLED"; userId?: string };

/**
 * メールとパスワードを確認する。ユーザーが存在しない場合もダミーのハッシュで検証して、
 * 応答時間からアカウントの有無を推測されないようにする。
 */
export class LoginService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword("dummy-password-for-timing");
    return this.dummyHash;
  }

  async attempt(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) {
      await verifyPassword(await this.getDummyHash(), password);
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    const now = this.now();
    if (user.lockedUntil && user.lockedUntil > now) {
      await verifyPassword(await this.getDummyHash(), password);
      return { ok: false, reason: "LOCKED", userId: user.id };
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const failures = user.failedLoginCount + 1;
      const lock = failures >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failures,
          ...(lock ? { lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS) } : {}),
        },
      });
      return { ok: false, reason: lock ? "LOCKED" : "INVALID_CREDENTIALS", userId: user.id };
    }

    if (user.status !== "ACTIVE") return { ok: false, reason: "DISABLED", userId: user.id };

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    return { ok: true, userId: user.id };
  }
}
