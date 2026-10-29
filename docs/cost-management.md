# コスト管理

## 記録（§30）

すべての外部 API 呼び出しを `ai_costs` に記録する（Claude 以外の動画生成・TTS も同テーブル）。

| カラム | 内容 |
|------|------|
| provider / model / operation | 例: `anthropic` / `claude-opus-5-5` / `generate_script` |
| input_tokens / output_tokens / cache_read_tokens / cache_write_tokens | Claude の `usage` から |
| units / unit_type | 動画秒数・TTS 文字数など |
| cost_usd / estimated | `provider_pricing` × 使用量。請求確定前は `estimated=true` |
| latency_ms / request_id | 実行時間・追跡用 |
| job_id / project_id / channel_id | 集計キー |

YouTube API は無料だがクォータを `api_quota_usage` に記録し、同じダッシュボードに表示する。

## 予算ガード

| 設定 | 既定 | 超過時 |
|------|------|------|
| `per_video_budget_usd` | $10 | 該当 Project を `PAUSED(BUDGET)`、承認を求める |
| `daily_budget_usd` | $30 | 新規 COSTLY ジョブを翌日まで保留 |
| `monthly_budget_usd` | $600 | 全 COSTLY ジョブ停止、OWNER に通知 |
| 再生成上限 | 動画 3 回 / 台本 5 回 | ESCALATE_TO_HUMAN |

COSTLY ジョブ（動画生成・TTS）は実行前に見積もり、`実績 + 見積 ≤ 上限` の場合のみ実行。予算到達 80% で警告通知。

## ダッシュボード

- 今日の AI 費用 / 今月の AI 費用（Provider 別積み上げ）
- 動画 1 本あたり平均制作費（承認済み Project の合計 / 本数、再生成分を含む）
- Provider 別・モデル別・工程別費用
- API 使用量（トークン、動画秒数、TTS 文字数、YouTube クォータ残量）
- ROI = 推定収益 / 制作費（推定収益は YouTube Analytics の値、取得不可時は RPM 仮定値で「推定」表示）

## 単価（2026-10 時点の概算、`provider_pricing` で管理）

| Provider | 単価 |
|------|------|
| Claude Opus 5.5 | 入力 $4 / 出力 $20 per 1M tokens（キャッシュ読取 $0.20） |
| Claude Sonnet 5.5 | 入力 $2 / 出力 $10 per 1M tokens |
| Claude Haiku 5.5 | 入力 $0.10 / 出力 $0.50 per 1M tokens（〜100K トークンのプロンプト） |
| Batch API | 上記の 50% |
| 動画生成（Kling 3.0 Standard・音声なし） | 720p 約 $0.084 / 秒、1080p 約 $0.112 / 秒（要確認） |
| TTS（Google Cloud TTS） | Chirp 3: HD $30 / 100 万文字、WaveNet・Standard $4 / 100 万文字（月ごとの無料枠あり） |

## 1 本あたりコスト試算（30 秒 Shorts・6 シーン、既定 Opus 5.5）

| 工程 | 入力 tokens | 出力 tokens | 費用 |
|------|------|------|------|
| トレンド分析（1 回の ResearchRun を 3 本で按分） | 60,000 / 3 | 8,000 / 3 | 約 $0.13 |
| 企画生成（按分） | 20,000 / 3 | 6,000 / 3 | 約 $0.07 |
| 台本生成 | 15,000 | 4,000 | 約 $0.14 |
| メタデータ | 5,000 | 1,000 | 約 $0.04 |
| 品質チェック（フレーム画像含む） | 40,000 | 3,000 | 約 $0.22 |
| 修正 1 回 + 再 QC | 50,000 | 6,000 | 約 $0.32 |
| **Claude 小計** | | | **約 $0.6〜$1.2**（thinking トークン込みの幅） |
| 動画生成（Kling） | 30 秒 × 再生成率 1.3 ≒ 39 秒 × $0.084〜$0.112 | | **約 $3.3〜$4.4** |
| TTS（Google） | 約 300 文字 | | 約 $0.01（無料枠内なら $0） |

→ **1 本あたり約 $4〜$6。コストの大半は動画生成。** 静止画 + 動き（Ken Burns）+ 一部のみ動画生成、といった「ハイブリッド構成」を RenderProfile として選べるようにすると大幅に削減できる（Phase 2 で検討）。

## 月額概算（月 60 本）

| 項目 | 低 | 高 |
|------|------|------|
| Claude | $40 | $90 |
| 動画生成（Kling） | $200 | $270 |
| TTS（Google） | $0 | $5 |
| インフラ（web/api/worker + Postgres + Redis） | $40 | $100 |
| ストレージ | $1 | $5 |
| メール等 | $0 | $20 |
| **合計** | **約 $280** | **約 $490** |

Phase 1（動画生成なし、台本まで）: **約 $60〜$150 / 月**。

## 削減策

1. プロンプトキャッシュ（固定システムプロンプト・チャンネル設定・成功パターンを先頭に）
2. Batch API（投稿後分析・学習）
3. `effort` をタスク毎に調整（メタデータ生成は low）
4. 市場データの事前集計（生データを全部渡さず、統計値 + 上位抜粋のみ）
5. 未変更シーンの生成物再利用
6. 動画生成前に台本承認を挟むモード（高額工程の前で人間が止められる）
7. 必要に応じタスク単位でより安価なモデルへ切替（設定のみで可能。品質評価してから担当者が判断）
