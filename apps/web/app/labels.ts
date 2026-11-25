// 画面に出す日本語の表示名

export const STATE_LABEL: Record<string, string> = {
  MARKET_RESEARCH: "市場データを収集中",
  TREND_ANALYSIS: "トレンドを分析中",
  IDEA_GENERATION: "企画を作成中",
  WAITING_IDEA_SELECTION: "企画の選択待ち",
  SCRIPT_GENERATION: "台本の作成へ進みました",
  PAUSED: "一時停止中（クォータ不足など）",
  FAILED: "失敗",
};

export const RISK_LABEL = { LOW: "低", MEDIUM: "中", HIGH: "高" } as const;

/** 処理中で、結果を待っている状態（画面を自動更新する） */
export const IN_PROGRESS_STATES = new Set(["MARKET_RESEARCH", "TREND_ANALYSIS", "IDEA_GENERATION"]);
