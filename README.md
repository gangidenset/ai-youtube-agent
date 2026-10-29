# AI YouTube Agent

Claude を「AI 動画ディレクター兼 AI オーケストレーター」として使い、YouTube Shorts を中心とした
**市場分析 → 企画 → 台本 → 動画生成 → 編集 → AI 品質チェック → 人間承認 → 投稿 → 投稿後分析 → 改善**
を自動化するプラットフォームです。担当者は制作条件を設定し、最終承認だけを行います。

> **現在のステータス: Phase 1（MVP）実装中**
> 設計は [設計提案書](./docs/design-proposal.md) と [意思決定ログ](./docs/decisions.md) を参照してください。

## ドキュメント

| ドキュメント | 内容 |
|------|------|
| [docs/design-proposal.md](./docs/design-proposal.md) | **設計提案書（まずこれを読む）**: 全体像・MVP 範囲・ロードマップ・制約・コスト |
| [docs/architecture.md](./docs/architecture.md) | システム構成・技術選定理由・フォルダ構成 |
| [docs/database.md](./docs/database.md) | ER 図・テーブル定義・バージョン管理 |
| [docs/api.md](./docs/api.md) | REST API 一覧 |
| [docs/workflow.md](./docs/workflow.md) | 状態機械・ジョブ・エラー処理・修正フロー |
| [docs/ai-orchestrator.md](./docs/ai-orchestrator.md) | Claude の役割・Tool・判断スキーマ・各種スコア |
| [docs/providers.md](./docs/providers.md) | Claude / YouTube / Video / TTS / Storage Adapter と外部 API の制限 |
| [docs/security.md](./docs/security.md) | Secret 管理・認証・脆弱性対策・AI 固有リスク |
| [docs/cost-management.md](./docs/cost-management.md) | コスト記録・予算ガード・試算 |
| [docs/deployment.md](./docs/deployment.md) | 環境・CI/CD・GitHub 開発フロー |
| [docs/decisions.md](./docs/decisions.md) | 意思決定ログ（ADR） |

## システム構成

```
[Web UI (Next.js)] ──HTTPS──> [API (Fastify)] ──> [PostgreSQL]
                                     │                 ▲
                                     └─enqueue─> [Redis / BullMQ] ──> [Worker]
                                                                       ├─ Workflow Engine（状態機械・ガード）
                                                                       ├─ AI Orchestrator ──> Anthropic API (Claude)
                                                                       ├─ YouTube Data / Analytics API
                                                                       ├─ Video / TTS Provider
                                                                       └─ FFmpeg ──> S3 互換ストレージ
```

- Claude は **判断（JSON）を返すだけ**。実際の API 実行は Workflow Engine が検証のうえ行う。
- API キーは Backend（api / worker）のみが保持。Frontend と Claude には渡さない。
- 初期版は **必ず人間承認を経由して投稿**。

## 技術スタック

TypeScript / pnpm + Turborepo / Next.js / Fastify / BullMQ + Redis / PostgreSQL + Prisma / FFmpeg / Anthropic Claude API / YouTube Data API v3 / S3 互換ストレージ（Cloudflare R2・MinIO）/ Docker / GitHub Actions

## 開発環境（予定）

- Node.js 22 LTS
- pnpm 9+
- Docker / Docker Compose
- FFmpeg（ローカルで worker を直接動かす場合）

## セットアップ（Phase 1 で有効化）

```bash
git clone https://github.com/gangidenset/ai-youtube-agent.git
```

```bash
cd ai-youtube-agent && pnpm install
```

```bash
cp .env.example .env
```

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

```bash
pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev
```

- Web: http://localhost:3000 / API: http://localhost:4000 / MinIO: http://localhost:9001
- API キーが未設定の Provider は自動で `mock` 実装に切り替わり、キーなしでも一通りの流れを確認できます。

## 環境変数

`.env.example` を参照してください。**`.env` は絶対にコミットしないでください。**

| 変数 | 必須 | 説明 |
|------|------|------|
| `DATABASE_URL` | ✔ | PostgreSQL 接続文字列 |
| `REDIS_URL` | ✔ | Redis 接続文字列 |
| `SESSION_SECRET` | ✔ | Cookie 署名用（32 byte 以上のランダム値） |
| `TOKEN_ENCRYPTION_KEY` | ✔ | OAuth トークン暗号化（32 byte、base64） |
| `ANTHROPIC_API_KEY` | ✔（mock 時は不要） | Claude API |
| `CLAUDE_DEFAULT_MODEL` | | 既定 `claude-opus-5-5` |
| `YOUTUBE_API_KEY` | ✔（mock 時は不要） | YouTube Data API v3（読取） |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Phase 3 | YouTube 投稿用 OAuth |
| `S3_*` | Phase 2 | ストレージ |
| `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` | Phase 2 | 動画生成（Kling 3.0） |
| `GOOGLE_TTS_CREDENTIALS` | Phase 2 | Google Cloud TTS（サービスアカウント JSON を base64 で） |
| `MAIL_API_KEY` | | 承認依頼メール |

## API 設定

1. **Anthropic**: https://console.anthropic.com で API キーを発行し、利用上限（Spend limit）を設定
2. **YouTube Data API**: Google Cloud Console でプロジェクト作成 → YouTube Data API v3 を有効化 → API キー作成（API 制限を YouTube Data API のみに設定）
3. **YouTube OAuth（Phase 3）**: OAuth 同意画面を設定し、スコープ `youtube.upload` / `youtube.readonly` / `yt-analytics.readonly` を申請。リダイレクト URI に `https://<host>/api/v1/oauth/youtube/callback` を登録。本番公開前に Google の審査が必要
4. 既定クォータは 10,000 units/日。詳細は [docs/providers.md](./docs/providers.md#youtube)

## DB 構築

- スキーマ: `packages/db/prisma/schema.prisma`
- マイグレーション: `pnpm db:migrate`（開発）/ `pnpm db:deploy`（本番、手動承認付きパイプライン）
- シード: `pnpm db:seed`（初期 OWNER ユーザー・サンプルチャンネル）

## 起動方法

| コマンド | 内容 |
|------|------|
| `pnpm dev` | web / api / worker を同時起動 |
| `pnpm --filter @aya/api dev` | API のみ |
| `pnpm --filter @aya/worker dev` | Worker のみ |

## テスト方法

| コマンド | 内容 |
|------|------|
| `pnpm lint` | ESLint + Prettier チェック |
| `pnpm typecheck` | TypeScript 型チェック |
| `pnpm test` | Vitest（ユニット / mock Provider を使った統合テスト） |
| `pnpm build` | 全パッケージのビルド |

## デプロイ方法

Docker イメージ（web / api / worker）をコンテナ PaaS にデプロイします。本番デプロイと本番 DB マイグレーションは GitHub Environments の手動承認が必要です。詳細は [docs/deployment.md](./docs/deployment.md)。

## GitHub 開発フロー

```
Issue → 方針決定 → feature ブランチ → 実装・テスト → Commit → Pull Request
→ GitHub Actions（Lint / Type Check / Unit Test / Build / Security）→ 人間レビュー → Merge
```

- `main` への直接 push は禁止（ブランチ保護）
- コミットは Conventional Commits
- 1 PR = 1 Issue

## Claude 開発フロー

Claude（Claude Code）は本リポジトリで次の範囲を自律的に行えます: Issue の読み取り → 次タスクの判断 → ブランチ作成 → 実装 → テスト → PR 作成。
main へのマージ・本番デプロイ・Secret / API キー変更・本番 DB 変更は人間の承認が必須です。ルールは [CLAUDE.md](./CLAUDE.md) を参照してください。

## ライセンス

未定（社内利用想定）。
