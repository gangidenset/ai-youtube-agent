import { describe, expect, it } from "vitest";
import { diffScripts, findNgWords, type ScriptLike, scriptTexts } from "../src/script";

const base: ScriptLike = {
  title: "AI で家計簿を 3 分で",
  hook: "家計簿、続かない人へ",
  target: "20 代の会社員",
  duration_seconds: 20,
  scenes: [
    {
      scene_number: 1,
      duration: 5,
      visual_prompt: "散らかったレシート",
      narration: "家計簿、続かない人へ",
      subtitle: "家計簿、続かない？",
      sound_effect: "",
      transition: "cut",
      priority: "CORE",
    },
    {
      scene_number: 2,
      duration: 15,
      visual_prompt: "スマホの画面",
      narration: "写真を撮るだけで記録できます",
      subtitle: "写真を撮るだけ",
      sound_effect: "",
      transition: "",
      priority: "CORE",
    },
  ],
  cta: "続きはプロフィールから",
  description: "家計簿アプリの使い方",
  hashtags: ["#家計簿", "#節約"],
};

describe("findNgWords", () => {
  it("全角・半角、大文字小文字、空白の違いを無視して見つける", () => {
    expect(findNgWords(["ＡＩ 副業 を始める"], ["ai副業"])).toEqual(["ai副業"]);
    expect(findNgWords(["今日の天気"], ["ai副業"])).toEqual([]);
  });

  it("空の NG ワードや重複は無視し、登録順で返す", () => {
    expect(findNgWords(["節約と家計簿"], ["", "家計簿", "節約", "家計簿", " "])).toEqual(["家計簿", "節約"]);
  });

  it("台本のナレーション・字幕・ハッシュタグも対象にする", () => {
    expect(findNgWords(scriptTexts(base), ["写真を撮る", "#節約"])).toEqual(["写真を撮る", "#節約"]);
  });
});

describe("diffScripts", () => {
  it("同じ台本なら変更なし", () => {
    expect(diffScripts(base, base)).toMatchObject({ unchanged: true, changedSceneNumbers: [] });
  });

  it("項目とシーンの変更を項目単位で返す", () => {
    const next: ScriptLike = {
      ...base,
      hook: "家計簿が 3 日で終わる人へ",
      hashtags: ["#家計簿"],
      scenes: [{ ...base.scenes[0]!, narration: "家計簿が 3 日で終わる人へ" }, base.scenes[1]!],
    };
    const diff = diffScripts(base, next);
    expect(diff.unchanged).toBe(false);
    expect(diff.fields).toEqual([
      { field: "hook", before: "家計簿、続かない人へ", after: "家計簿が 3 日で終わる人へ" },
      { field: "hashtags", before: "#家計簿 #節約", after: "#家計簿" },
    ]);
    expect(diff.scenes).toEqual([
      {
        sceneNumber: 1,
        change: "CHANGED",
        fields: [{ field: "narration", before: "家計簿、続かない人へ", after: "家計簿が 3 日で終わる人へ" }],
      },
    ]);
    expect(diff.changedSceneNumbers).toEqual([1]);
  });

  it("シーンの追加・削除を返す（削除は作り直しの対象に含めない）", () => {
    const three: ScriptLike = {
      ...base,
      duration_seconds: 25,
      scenes: [...base.scenes, { ...base.scenes[1]!, scene_number: 3, duration: 5 }],
    };
    expect(diffScripts(base, three).scenes).toEqual([{ sceneNumber: 3, change: "ADDED", fields: [] }]);
    expect(diffScripts(base, three).changedSceneNumbers).toEqual([3]);
    const back = diffScripts(three, base);
    expect(back.scenes).toEqual([{ sceneNumber: 3, change: "REMOVED", fields: [] }]);
    expect(back.changedSceneNumbers).toEqual([]);
    expect(back.fields).toEqual([{ field: "duration_seconds", before: 25, after: 20 }]);
  });
});
