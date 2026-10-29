import { z } from "zod";

/** 台本のシーン（指示書 §17）。priority は尺の短い出力先で省略してよいかどうか（docs/multi-platform.md）。 */
export const SceneSchema = z.object({
  scene_number: z.number().int().positive(),
  duration: z.number().positive(),
  visual_prompt: z.string(),
  narration: z.string(),
  subtitle: z.string(),
  sound_effect: z.string().default(""),
  transition: z.string().default(""),
  priority: z.enum(["CORE", "OPTIONAL"]).default("CORE"),
});
export type Scene = z.infer<typeof SceneSchema>;

/** 尺の合計の許容誤差（秒）。 */
export const DURATION_TOLERANCE_SEC = 1;

/** SNS 中立のマスター台本（指示書 §17 の JSON 形式）。 */
export const ScriptSchema = z
  .object({
    title: z.string().min(1),
    hook: z.string().min(1),
    target: z.string().min(1),
    duration_seconds: z.number().positive(),
    scenes: z.array(SceneSchema).min(1),
    cta: z.string(),
    description: z.string(),
    hashtags: z.array(z.string()),
  })
  .refine((s) => s.scenes.every((scene, i) => scene.scene_number === i + 1), {
    message: "scene_number must be sequential starting at 1",
    path: ["scenes"],
  })
  .refine(
    (s) =>
      Math.abs(s.scenes.reduce((sum, scene) => sum + scene.duration, 0) - s.duration_seconds) <=
      DURATION_TOLERANCE_SEC,
    { message: "sum of scene durations must match duration_seconds", path: ["duration_seconds"] },
  )
  .refine((s) => s.scenes[0]?.priority === "CORE", {
    message: "the first scene (hook) must be CORE",
    path: ["scenes", 0, "priority"],
  });
export type Script = z.infer<typeof ScriptSchema>;
