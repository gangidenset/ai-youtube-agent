import { describe, expect, it } from "vitest";
import { CHANNEL_ROLES, hasPermission, PERMISSIONS, permissionsOf } from "../src";

describe("channel roles", () => {
  it("OWNER can do everything", () => {
    for (const p of PERMISSIONS) expect(hasPermission("OWNER", p)).toBe(true);
  });

  it("every role can read", () => {
    for (const role of CHANNEL_ROLES) expect(hasPermission(role, "channel:read")).toBe(true);
  });

  it("separates editing from approving", () => {
    expect(permissionsOf("EDITOR")).toEqual(["channel:read", "channel:edit"]);
    expect(permissionsOf("APPROVER")).toEqual(["channel:read", "approval:decide"]);
    expect(hasPermission("EDITOR", "approval:decide")).toBe(false);
    expect(hasPermission("APPROVER", "channel:edit")).toBe(false);
  });

  it("only OWNER can administer (budget, integrations, members)", () => {
    for (const role of CHANNEL_ROLES) expect(hasPermission(role, "channel:admin")).toBe(role === "OWNER");
  });

  it("VIEWER can only read", () => {
    expect(permissionsOf("VIEWER")).toEqual(["channel:read"]);
  });
});
