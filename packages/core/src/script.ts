import { normalizeForSimilarity } from "./scoring";

/**
 * 台本（指示書 §17）の純粋なチェックと差分。
 * 形の検証は packages/schemas の ScriptSchema が行う。ここでは構造だけを前提にする。
 */
export interface SceneLike {
  scene_number: number;
  duration: number;
  visual_prompt: string;
  narration: string;
  subtitle: string;
  sound_effect: string;
  transition: string;
  priority: "CORE" | "OPTIONAL";
}

export interface ScriptLike {
  title: string;
  hook: string;
  target: string;
  duration_seconds: number;
  scenes: readonly SceneLike[];
  cta: string;
  description: string;
  hashtags: readonly string[];
}

/** NG ワード・断定表現のチェック対象（視聴者に見える文と、動画生成に渡す指示） */
export function scriptTexts(script: ScriptLike): string[] {
  return [
    script.title,
    script.hook,
    script.cta,
    script.description,
    ...script.hashtags,
    ...script.scenes.flatMap((s) => [s.narration, s.subtitle, s.visual_prompt]),
  ];
}

/**
 * 文中に含まれる NG ワードを返す（重複なし・登録順）。
 * 大文字小文字・全角半角・空白・記号の違いは無視する（「Ａ I 副業」も「AI副業」として見つける）。
 */
export function findNgWords(texts: readonly string[], ngWords: readonly string[]): string[] {
  const haystack = texts.map(normalizeForSimilarity).join("\n");
  const found: string[] = [];
  for (const word of ngWords) {
    const needle = normalizeForSimilarity(word);
    if (needle.length === 0 || found.includes(word)) continue;
    if (haystack.includes(needle)) found.push(word);
  }
  return found;
}

export interface FieldChange {
  field: string;
  before: string | number;
  after: string | number;
}

export interface SceneChange {
  sceneNumber: number;
  change: "ADDED" | "REMOVED" | "CHANGED";
  fields: FieldChange[];
}

export interface ScriptDiff {
  fields: FieldChange[];
  scenes: SceneChange[];
  /** 新しい版で作り直しが必要なシーン（追加・変更）。動画・音声の再生成の範囲に使う */
  changedSceneNumbers: number[];
  unchanged: boolean;
}

const SCRIPT_FIELDS = ["title", "hook", "target", "duration_seconds", "cta", "description"] as const;
const SCENE_FIELDS = [
  "duration",
  "visual_prompt",
  "narration",
  "subtitle",
  "sound_effect",
  "transition",
  "priority",
] as const;

/** 2 つの版の差分。シーンは scene_number で対応させる。 */
export function diffScripts(from: ScriptLike, to: ScriptLike): ScriptDiff {
  const fields: FieldChange[] = [];
  for (const field of SCRIPT_FIELDS) {
    if (from[field] !== to[field]) fields.push({ field, before: from[field], after: to[field] });
  }
  const beforeTags = from.hashtags.join(" ");
  const afterTags = to.hashtags.join(" ");
  if (beforeTags !== afterTags) fields.push({ field: "hashtags", before: beforeTags, after: afterTags });

  const scenes: SceneChange[] = [];
  const count = Math.max(from.scenes.length, to.scenes.length);
  for (let i = 0; i < count; i++) {
    const a = from.scenes[i];
    const b = to.scenes[i];
    if (a && !b) {
      scenes.push({ sceneNumber: a.scene_number, change: "REMOVED", fields: [] });
      continue;
    }
    if (!a && b) {
      scenes.push({ sceneNumber: b.scene_number, change: "ADDED", fields: [] });
      continue;
    }
    if (!a || !b) continue;
    const changed: FieldChange[] = [];
    for (const field of SCENE_FIELDS) {
      if (a[field] !== b[field]) changed.push({ field, before: a[field], after: b[field] });
    }
    if (changed.length > 0) scenes.push({ sceneNumber: b.scene_number, change: "CHANGED", fields: changed });
  }

  const changedSceneNumbers = scenes.filter((s) => s.change !== "REMOVED").map((s) => s.sceneNumber);
  return {
    fields,
    scenes,
    changedSceneNumbers,
    unchanged: fields.length === 0 && scenes.length === 0,
  };
}
