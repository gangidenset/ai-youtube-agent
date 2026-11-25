import { hash, verify } from "@node-rs/argon2";

/** パスワードの最低文字数（docs/security.md） */
export const MIN_PASSWORD_LENGTH = 12;

// argon2id・メモリ 64MB（docs/security.md）
const ARGON2_OPTIONS = {
  algorithm: 2 /* Argon2id */,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    throw new Error(`パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`);
  }
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
