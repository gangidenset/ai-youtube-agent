import { WORKFLOW_STATES } from "@aya/core";
import { createDefaultRegistry } from "@aya/platforms";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowState } from "../src";

// DB を使わない整合性チェック（スキーマと他パッケージの定義がずれていないか）
describe("schema consistency", () => {
  it("WorkflowState enum matches packages/core", () => {
    expect(Object.values(WorkflowState)).toEqual([...WORKFLOW_STATES]);
  });

  it("default_targets only contains registered platform targets", () => {
    const schema = readFileSync(join(import.meta.dirname, "../prisma/schema.prisma"), "utf8");
    const match = schema.match(/defaultTargets\s+String\[\]\s+@default\(\[([^\]]*)\]\)/);
    expect(match).not.toBeNull();
    const targets = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(targets).toEqual(["tiktok", "instagram_reels", "youtube_shorts"]);
    const registry = createDefaultRegistry();
    for (const id of targets) expect(registry.has(id ?? "")).toBe(true);
  });
});
