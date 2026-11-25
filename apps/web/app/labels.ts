// 画面に出す日本語の表示名

export const STATE_LABEL: Record<string, string> = {
  MARKET_RESEARCH: "市場データを収集中",
  TREND_ANALYSIS: "トレンドを分析中",
  IDEA_GENERATION: "企画を作成中",
  WAITING_IDEA_SELECTION: "企画の選択待ち",
  SCRIPT_GENERATION: "台本の作成へ進みました",
  REVISING: "修正中",
  PLATFORM_OPTIMIZATION: "SNS 別のテキストを作成中",
  WAITING_APPROVAL: "承認待ち",
  PAUSED: "一時停止中（クォータ不足など）",
  FAILED: "失敗",
};

export const RISK_LABEL = { LOW: "低", MEDIUM: "中", HIGH: "高" } as const;

/** 処理中で、結果を待っている状態（画面を自動更新する） */
export const IN_PROGRESS_STATES = new Set(["MARKET_RESEARCH", "TREND_ANALYSIS", "IDEA_GENERATION"]);

export const SCOPE_LABEL = {
  SCRIPT: "台本全体",
  SCENES: "フック・シーンだけ",
  METADATA: "タイトル・説明文・ハッシュタグだけ",
} as const;

/** 差分の項目名 */
export const FIELD_LABEL: Record<string, string> = {
  title: "タイトル",
  hook: "フック",
  target: "ターゲット",
  duration_seconds: "尺（秒）",
  cta: "CTA",
  description: "説明文",
  hashtags: "ハッシュタグ",
  duration: "尺（秒）",
  visual_prompt: "映像の指示",
  narration: "ナレーション",
  subtitle: "字幕",
  sound_effect: "効果音",
  transition: "切り替え",
  priority: "優先度",
};
