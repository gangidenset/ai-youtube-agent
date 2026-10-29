# API 設計

- REST / JSON、ベースパス `/api/v1`
- Web からは Next.js の rewrite 経由で同一オリジン呼び出し（Cookie セッション）
- 入出力は `packages/schemas` の Zod スキーマで検証（OpenAPI を自動生成して `/api/v1/docs` で公開 ※本番は認証必須）

## 共通仕様

| 項目 | 仕様 |
|------|------|
| 認証 | `sid` Cookie（httpOnly / Secure / SameSite=Lax） |
| CSRF | 状態変更メソッドは `X-CSRF-Token` ヘッダ必須 + `Origin` 検証 |
| 冪等性 | ジョブを起動する POST は `Idempotency-Key` ヘッダ必須（24h 保持） |
| 非同期 | 長時間処理は `202 Accepted` + `{ jobId, entityId }` を返す。進捗は GET ポーリング or `GET /events`（SSE） |
| ページング | `?cursor=&limit=`（最大 100） |
| エラー | `{ "error": { "code": "QUOTA_EXCEEDED", "message": "...", "details": {}, "requestId": "..." } }` |
| Rate Limit | IP + ユーザー単位（例: 認証 API 5 回/分、一般 120 回/分）。`429` + `Retry-After` |
| 認可 | ロール（OWNER / EDITOR / APPROVER / VIEWER）× チャンネル所属で判定 |

## エンドポイント一覧

### 認証

| Method | Path | 説明 | 権限 |
|---|---|---|---|
| POST | `/auth/login` | email + password でログイン | 公開 |
| POST | `/auth/logout` | セッション失効 | ログイン |
| GET | `/auth/me` | 自分の情報・所属チャンネル・CSRF トークン | ログイン |
| POST | `/auth/password` | パスワード変更 | ログイン |

### ユーザー（OWNER）

| Method | Path | 説明 |
|---|---|---|
| GET | `/users` | 一覧 |
| POST | `/users/invite` | 招待（メール） |
| PATCH | `/channels/:channelId/members/:userId` | ロール変更 |

### チャンネル

| Method | Path | 説明 | 権限 |
|---|---|---|---|
| GET | `/channels` | 所属チャンネル一覧 | VIEWER+ |
| POST | `/channels` | 作成 | OWNER |
| GET | `/channels/:id` | 詳細 | VIEWER+ |
| GET | `/channels/:id/settings` | 制作条件 | VIEWER+ |
| PATCH | `/channels/:id/settings` | 制作条件更新（予算・自動投稿設定は OWNER のみ） | EDITOR+ |
| GET | `/channels/:id/youtube/connect` | Google OAuth 開始（state + PKCE） | OWNER |
| GET | `/oauth/youtube/callback` | OAuth コールバック（トークンを暗号化保存） | — |
| DELETE | `/channels/:id/youtube` | 連携解除（トークン失効） | OWNER |

### 市場分析・トレンド

| Method | Path | 説明 |
|---|---|---|
| POST | `/channels/:id/research-runs` | 市場分析開始（body: keywords?, region?, lookbackDays?） → 202 |
| GET | `/channels/:id/research-runs` | 履歴 |
| GET | `/research-runs/:id` | 状態・進捗・クォータ使用量 |
| GET | `/research-runs/:id/trends` | トレンド（Trend Score・根拠・不確実性・リスク） |
| GET | `/research-runs/:id/competitor-videos` | 収集データ |

### 企画

| Method | Path | 説明 |
|---|---|---|
| GET | `/research-runs/:id/ideas` | A/B/C 案 |
| POST | `/research-runs/:id/ideas/regenerate` | 企画再生成（指示付き可） → 202 |
| POST | `/ideas/:id/select` | 企画選択 → Project 作成 + 台本生成開始 → 202 |

### プロジェクト・台本

| Method | Path | 説明 |
|---|---|---|
| GET | `/projects` | 一覧（`?state=&channelId=`） |
| GET | `/projects/:id` | 詳細（状態・現行バージョン・コスト） |
| GET | `/projects/:id/versions` | バージョン履歴（台本・生成物・QC・承認） |
| GET | `/projects/:id/scripts/:version` | 台本 JSON |
| GET | `/projects/:id/scripts/diff?from=1&to=2` | 差分 |
| POST | `/projects/:id/revisions` | 修正指示（body: instruction, scope?: `SCRIPT`/`SCENES`/`METADATA`） → 202 |
| POST | `/projects/:id/pause` / `/resume` / `/cancel` | 制御 |
| GET | `/projects/:id/assets` | 生成物（署名付き URL、有効期限 15 分） |
| GET | `/projects/:id/decisions` | Claude の判断履歴 |

### SNS（Target）

| Method | Path | 説明 |
|---|---|---|
| GET | `/platform-targets` | 利用可能な Target 一覧（Registry から取得。UI のチェックボックスはこれで描画） |
| GET | `/platform-targets/:targetId` | Config（上書きをマージ済み） |
| PATCH | `/platform-targets/:targetId/override` | Config の上書き（OWNER、監査ログに記録） |
| POST | `/quick-generate` | シンプルフロー: `{ channelId, theme, targets[] }` → 市場分析 → AUTO_TOP → 台本 → SNS 別最適化 → 202 |
| GET | `/projects/:id/variants` | Target 別の成果物（メタデータ・プレビュー URL・検証結果） |
| PATCH | `/projects/:id/variants/:targetId` | テキストの手動修正（再レンダリングなし） |
| POST | `/projects/:id/variants/:targetId/regenerate` | その Target のテキストだけ再生成 |
| GET | `/projects/:id/variants/:targetId/download` | MP4 の署名付き URL + テキスト（ダウンロードを `publications` に記録） |
| PUT | `/projects/:id/targets` | 出力先 Target の追加・削除（追加分だけ最適化を実行） |

### 承認

| Method | Path | 説明 | 権限 |
|---|---|---|---|
| GET | `/approvals?status=PENDING` | 承認待ち一覧 | APPROVER+ |
| GET | `/approvals/:id` | 承認画面データ（プレビュー URL・メタデータ・各スコア・根拠・使用 AI・推定コスト・リスク） | APPROVER+ |
| POST | `/approvals/:id/approve` | [承認]（body: targets?: 承認する Target。省略時は全 Target。MVP はダウンロード可能になる。投稿は Phase 3 以降に publishAt 等を指定） | APPROVER+ |
| POST | `/approvals/:id/request-changes` | [修正]（body: instruction） | APPROVER+ |
| POST | `/approvals/:id/reject` | [却下]（body: reason） | APPROVER+ |
| POST | `/approvals/:id/regenerate` | [AIに再生成]（body: target: `SCRIPT`/`VIDEO`/`VOICE`/`ALL`） | APPROVER+ |

### 投稿・分析

| Method | Path | 説明 |
|---|---|---|
| GET | `/uploads` | 投稿履歴・予定 |
| PATCH | `/uploads/:id` | 予約時刻・公開設定変更（YouTube 側にも反映） |
| GET | `/projects/:id/performance` | 1h〜7d の推移 |
| GET | `/channels/:id/success-patterns` | 成功パターン |

### ダッシュボード・コスト

| Method | Path | 説明 |
|---|---|---|
| GET | `/dashboard/today` | 市場トレンド・おすすめ企画・制作中・承認待ち・投稿予定・投稿済み・API 使用量・AI コスト |
| GET | `/dashboard/kpi?period=30d` | 総動画数・総再生数・平均再生数・平均高評価率・平均コメント率・ヒット率・推定収益・1 本あたり制作費・ROI |
| GET | `/costs/summary` | 今日 / 今月 / 1 本平均 |
| GET | `/costs/breakdown?groupBy=provider\|model\|project\|day` | 内訳 |
| GET | `/quota` | YouTube クォータ残量など |

### ジョブ・監査・システム

| Method | Path | 説明 |
|---|---|---|
| GET | `/jobs` | ジョブ一覧（`?status=FAILED`） |
| POST | `/jobs/:id/retry` | 再実行 |
| POST | `/jobs/:id/cancel` | キャンセル |
| GET | `/audit/decisions` | AI 判断ログ |
| GET | `/audit/logs` | 操作ログ（OWNER） |
| GET | `/events` | SSE（ジョブ進捗・承認依頼） |
| GET | `/healthz` / `/readyz` | ヘルスチェック（認証不要・情報最小限） |
