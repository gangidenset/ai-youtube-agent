import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src";

describe("password hashing", () => {
  it("uses argon2id and verifies correctly", async () => {
    const hashed = await hashPassword("correct horse battery");
    expect(hashed.startsWith("$argon2id$")).toBe(true);
    expect(hashed).toContain("m=65536");
    expect(await verifyPassword(hashed, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hashed, "wrong password!!")).toBe(false);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    await expect(hashPassword("short-pass")).rejects.toThrow(/12/);
  });
});
