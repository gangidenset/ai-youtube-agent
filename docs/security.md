# セキュリティ設計

## 基本原則

1. **Secret は Backend（api / worker）だけが持つ。** Frontend・Claude・ログ・Git には出さない。
2. **AI の出力も外部データも「信頼できない入力」として扱う。**
3. **副作用の大きい操作（投稿・課金・Secret 変更・本番 DB）は人間承認。**

## Secret 一覧

| 変数 | 用途 | 保管 | ローテーション |
|------|------|------|------|
| `ANTHROPIC_API_KEY` | Claude API | 環境変数（本番: ホスティングの Secret 管理） | 90 日 / 漏洩時即時 |
| `YOUTUBE_API_KEY` | Data API 読取（HTTP リファラ/IP 制限 + API 制限を設定） | 同上 | 90 日 |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | YouTube OAuth | 同上 | 年 1 回 |
| `TOKEN_ENCRYPTION_KEY`（+ `_PREVIOUS`） | OAuth トークン暗号化（AES-256-GCM） | 同上 | key_version で段階移行 |
| `SESSION_SECRET` | Cookie 署名 | 同上 | 年 1 回 |
| `DATABASE_URL` / `REDIS_URL` | 接続 | 同上 | 事業者に依存 |
| `S3_*` | ストレージ（バケット単位の最小権限キー） | 同上 | 90 日 |
| `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` | 動画生成（Kling 3.0） | 同上 | 90 日 |
| `GOOGLE_TTS_CREDENTIALS` | TTS（Google Cloud TTS サービスアカウント、TTS 権限のみ） | 同上 | 90 日 |
| `MAIL_API_KEY` | 通知メール | 同上 | 90 日 |

- `.env` は `.gitignore` 済み。リポジトリには `.env.example`（値なし）のみ。
- `packages/config` が起動時に Zod で必須変数を検証。`NEXT_PUBLIC_` 接頭辞の変数に Secret 系の名前が含まれていたら起動失敗させる。
- CI: **gitleaks** で全コミットを走査、GitHub の Secret scanning / Push protection を有効化。
- 本番 Secret は **GitHub Secrets**（デプロイ用最小限）またはホスティング側 Secret 管理。環境（staging / production）毎に別キー・別 Google Cloud プロジェクト。

## 認証・セッション

- パスワード: argon2id（メモリ 64MB 以上）、最低 12 文字、漏洩パスワードリスト照合（任意）
- セッション: ランダム 256bit トークン、DB にはハッシュのみ保存。Cookie は `httpOnly; Secure; SameSite=Lax; Path=/`
- 有効期限: アイドル 12h / 絶対 7d。パスワード変更・ロール変更時は全セッション失効
- ログイン試行: IP + アカウント単位で Rate Limit、連続失敗で一時ロック、監査ログ記録
- Phase 6: TOTP 2FA（OWNER は必須化）

## 認可

- ロール: OWNER（全権・予算・連携・自動投稿設定）/ EDITOR（設定・企画・修正）/ APPROVER（承認・却下）/ VIEWER
- 全リソースアクセスで `channel_members` を確認（IDOR 防止）。Repository 層で `channel_id` 条件を必須化

## Web 脆弱性対策

| 脅威 | 対策 |
|------|------|
| CSRF | SameSite=Lax + 状態変更 API に CSRF トークン（セッション紐付け）+ `Origin`/`Referer` 検証 |
| XSS | React の自動エスケープ、`dangerouslySetInnerHTML` を ESLint で禁止、CSP（`default-src 'self'`、nonce）、AI 生成テキスト・外部動画タイトルもエスケープ表示 |
| SQL Injection | Prisma のパラメータ化クエリのみ。`$queryRawUnsafe` を ESLint で禁止 |
| SSRF | Provider の取得 URL は許可ドメインのみ。ユーザー入力 URL を Worker が直接取得しない |
| ヘッダ | `@fastify/helmet`（HSTS, X-Content-Type-Options, frame-ancestors 'none'） |
| Rate Limit | `@fastify/rate-limit`（Redis ストア） |
| ファイル | アップロードは MIME / サイズ検証、ストレージは非公開 + 署名付き URL |
| 依存関係 | Dependabot、`pnpm audit`、CodeQL |

## OAuth トークン保護

- 認可コードフロー + PKCE + `state`（CSRF 防止）
- リフレッシュトークンは AES-256-GCM で暗号化（IV はランダム、`key_version` を保存）。アクセストークンは保存せずメモリ上で都度更新
- 復号は Worker の `upload_youtube` / `analyze_performance` 実行時のみ。復号イベントを `system_logs(SECRET_ACCESS)` に記録（値は記録しない）
- 連携解除時は Google 側でも revoke

## AI 固有のリスク

| リスク | 対策 |
|------|------|
| プロンプトインジェクション（競合動画のタイトル/説明/コメント経由） | 外部テキストを `<external_data untrusted>` タグで隔離、システムプロンプトで指示無視を明示、Claude の出力は Schema + 許可リスト + ガードで検証、副作用 Tool は対話ループで実行しない |
| 越境アクセス | Decision の parameters に含まれる ID がチャンネルに属するか検証 |
| コスト暴走 | 日次 / 月次 / 1 本あたり予算、再生成回数上限、ループ回数上限 |
| 不適切・誤情報コンテンツ | QC、NG ワード、事実主張の「要確認」フラグ、人間承認 |
| ログへの機微情報 | プロンプト・応答の保存は必要最小限、Secret/トークンはマスク |

## 監査ログ

- `ai_decisions`: Claude の全判断
- `system_logs`: ログイン・権限変更・設定変更・承認/却下・Secret 復号・Provider エラー
- 監査系テーブルは追記のみ（アプリ用 DB ロールに UPDATE/DELETE 権限を付与しない）

## 環境分離

| 環境 | DB | API キー | YouTube | 用途 |
|------|------|------|------|------|
| local | docker compose | 開発用（または mock Provider） | テスト用チャンネル | 開発 |
| staging | 専用 | staging 専用 | テスト用チャンネル（非公開投稿のみ） | 結合確認 |
| production | 専用（バックアップ・PITR） | 本番専用 | 本番チャンネル | 運用 |

## YouTube ポリシー対応（§42）

- 量産型コンテンツ回避: 同一テンプレート・同一パターンの連続使用上限、QC の量産型リスク評価、1 日の投稿本数上限（設定値）
- 他人の動画の単純コピー禁止: Originality Score 閾値、コピーリスク HIGH は提案しない
- 権利のない音源禁止: ライセンス記録必須、不明素材はレンダラが拒否
- 実在人物の誤認回避: 実在人物名を含むプロンプトは動画生成前にブロック / 承認時警告
- AI 生成コンテンツ開示: リアルな合成映像は `containsSyntheticMedia=true`
- ポリシー更新: `docs/youtube-policy-notes.md`（Phase 2 で作成）に要点と確認日を管理し、QC プロンプトに注入。四半期毎に人間がレビュー
