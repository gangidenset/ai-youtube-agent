import type { IdeaSet, ReviseScriptOutput, TrendAnalysis } from "@aya/orchestrator";
import { MockClaudeProvider } from "@aya/providers";
import type { Script } from "@aya/schemas";

/** 企画の尺を、5 秒前後のシーンに分ける */
function mockScenes(durationSec: number, theme: string): Script["scenes"] {
  const count = Math.max(2, Math.round(durationSec / 5));
  const base = Math.floor(durationSec / count);
  const steps = ["問いかけ", "よくある失敗", "解決のステップ 1", "解決のステップ 2", "比較", "まとめ"];
  return Array.from({ length: count }, (_, i) => {
    const step = i === 0 ? "問いかけ" : i === count - 1 ? "まとめ" : (steps[i] ?? `ポイント ${i}`);
    return {
      scene_number: i + 1,
      // 端数は最後のシーンに寄せ、合計を尺に一致させる
      duration: i === count - 1 ? durationSec - base * (count - 1) : base,
      visual_prompt: `（mock）${theme}: ${step}を表す明るいイラスト、縦長 9:16`,
      narration: `（mock）${step}のナレーション`,
      subtitle: `（mock）${step}`,
      sound_effect: "",
      transition: i === 0 ? "" : "cut",
      priority: i === 0 || i === count - 1 ? "CORE" : "OPTIONAL",
    };
  });
}

/**
 * API キーが無いときに使う Claude の代わり（ローカル開発・CI 用）。
 * 入力に含まれる動画 ID を使って、形式だけ正しい応答を返す。分析の質は本物とは無関係。
 */
export function createMockClaude(): MockClaudeProvider {
  return new MockClaudeProvider({
    trend_analysis: (task): TrendAnalysis => {
      const ids = [...task.prompt.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1] ?? "");
      const half = Math.max(1, Math.ceil(ids.length / 2));
      const groups = [ids.slice(0, half), ids.slice(half)].filter((g) => g.length > 0);
      return {
        market_summary: "（mock）収集した動画を 2 つのテーマに分けた仮の分析です。",
        topics: groups.map((g, i) => ({
          topic: `（mock）テーマ ${i + 1}`,
          trend_type: i === 0 ? "RISING" : "EVERGREEN",
          evidence_video_ids: g.slice(0, 30),
          audience_needs: ["短時間で要点を知りたい"],
          title_patterns: ["数字を入れたリスト型"],
          hook_patterns: ["冒頭で問いかける"],
          structure_patterns: ["結論 → 理由 → まとめ"],
          differentiation: ["自分の体験談を加える"],
          competition_level: "MEDIUM",
          novelty: i === 0 ? 0.6 : 0.4,
          demand: 0.6,
          risks: ["mock データのため実際の市場とは無関係"],
          uncertainty_note: "mock の分析です",
        })),
      };
    },
    generate_idea: (task): IdeaSet => {
      const trendIds = [
        ...new Set([...task.prompt.matchAll(/"trend_id": "([^"]+)"/g)].map((m) => m[1] ?? "")),
      ];
      const angles = ["初心者向けの入門", "失敗談から学ぶ", "1 日で試せる実践"];
      return {
        ideas: (["A", "B", "C"] as const).map((label, i) => ({
          label,
          trend_id: trendIds[i % Math.max(1, trendIds.length)] ?? "",
          title: `（mock）${angles[i]}の企画 ${label}`,
          theme: `（mock）${angles[i]}`,
          target: "副業に興味がある会社員",
          hook: `（mock）${angles[i]}で最初につまずく点は？`,
          story: "問題提起 → 解決のステップ → まとめ",
          duration_sec: 30,
          scene_count: 6,
          cta: "続きはプロフィールから",
          common_patterns: ["冒頭で問いかける"],
          original_angle: `${angles[i]}の視点で構成する`,
          differentiation: ["実際の画面を見せる", "数字で比較する"],
          similar_videos: [],
          policy_risk: "LOW",
          risks: ["mock の企画のため内容は未検証"],
        })),
      };
    },
    generate_script: (task): Script => {
      const field = (name: string) => task.prompt.match(new RegExp(`"${name}": "([^"]*)"`))?.[1] ?? "";
      const duration = Number(task.prompt.match(/"duration_sec": (\d+)/)?.[1] ?? 30);
      const theme = field("theme");
      return {
        title: field("title") || "（mock）台本",
        hook: field("hook") || "（mock）フック",
        target: field("target") || "（mock）視聴者",
        duration_seconds: duration,
        scenes: mockScenes(duration, theme),
        cta: field("cta") || "続きはプロフィールから",
        description: `（mock）${theme}について短く解説します。`,
        hashtags: ["#mock", "#shorts"],
      };
    },
    revise: (task): ReviseScriptOutput => {
      // 今の台本を取り出し、冒頭のシーンだけ書き換える（変えていないシーンは一字一句そのまま）
      const json = task.prompt.split("# 今の台本\n")[1]?.split("\n\n# 担当者の修正指示")[0] ?? "{}";
      const current = JSON.parse(json) as Script;
      const instruction = task.prompt.match(/<instruction>\n([\s\S]*?)\n<\/instruction>/)?.[1] ?? "";
      const hook = `（mock 修正）${instruction.slice(0, 30)}`;
      return {
        scope: "SCENES",
        change_summary: `（mock）冒頭のシーンを「${instruction.slice(0, 30)}」に合わせて書き換えました。`,
        new_script: {
          ...current,
          hook,
          scenes: current.scenes.map((s, i) => (i === 0 ? { ...s, narration: hook, subtitle: hook } : s)),
        },
      };
    },
  });
}
