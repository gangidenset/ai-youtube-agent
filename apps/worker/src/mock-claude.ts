import type { TrendAnalysis } from "@aya/orchestrator";
import { MockClaudeProvider } from "@aya/providers";

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
  });
}
