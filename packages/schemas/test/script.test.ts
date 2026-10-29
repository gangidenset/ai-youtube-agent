import { describe, expect, it } from "vitest";
import { ScriptSchema } from "../src";

const scene = (n: number, duration: number, priority?: "CORE" | "OPTIONAL") => ({
  scene_number: n,
  duration,
  visual_prompt: "v",
  narration: "n",
  subtitle: "s",
  ...(priority ? { priority } : {}),
});

const base = {
  title: "AI副業で最初にやるべき3つ",
  hook: "これ知らないと損します",
  target: "副業初心者",
  duration_seconds: 30,
  scenes: [scene(1, 3), scene(2, 9), scene(3, 9, "OPTIONAL"), scene(4, 9)],
  cta: "フォローしてね",
  description: "説明",
  hashtags: ["#AI副業"],
};

describe("ScriptSchema", () => {
  it("accepts the §17 format and defaults optional fields", () => {
    const parsed = ScriptSchema.parse(base);
    expect(parsed.scenes[0]).toMatchObject({ priority: "CORE", sound_effect: "", transition: "" });
    expect(parsed.scenes[2]?.priority).toBe("OPTIONAL");
  });

  it("rejects mismatched total duration", () => {
    expect(ScriptSchema.safeParse({ ...base, duration_seconds: 20 }).success).toBe(false);
  });

  it("rejects non-sequential scenes and an optional hook scene", () => {
    expect(ScriptSchema.safeParse({ ...base, scenes: [scene(2, 30)] }).success).toBe(false);
    expect(ScriptSchema.safeParse({ ...base, scenes: [scene(1, 30, "OPTIONAL")] }).success).toBe(false);
  });
});
