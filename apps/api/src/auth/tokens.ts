import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** セッショントークン（256 bit）。Cookie にだけ載せ、DB には hashToken の結果を保存する。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** CSRF トークンはセッショントークンから導出する（DB に保存せず、/auth/me でいつでも再発行できる）。 */
export function deriveCsrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
