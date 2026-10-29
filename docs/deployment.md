# デプロイ・開発運用

## 環境

| 環境 | 構成 | デプロイ契機 |
|------|------|------|
| local | `docker compose`（Postgres / Redis / MinIO）+ `pnpm dev`（web / api / worker） | — |
| staging | 本番と同構成・別 Secret | `main` へのマージで自動（Phase 3 以降） |
| production | web / api / worker の 3 コンテナ + マネージド Postgres / Redis + R2 | GitHub Release（タグ）+ **手動承認**（GitHub Environments の required reviewers） |

## コンテナ

- `web.Dockerfile`: Next.js standalone 出力
- `api.Dockerfile`: Node.js 22 LTS、非 root ユーザー
- `worker.Dockerfile`: Node.js 22 + 静的 FFmpeg、非 root、`/tmp` を作業領域（容量上限設定）
- いずれもマルチステージビルド、イメージは GHCR に push

## ホスティング候補

| 案 | 長所 | 短所 |
|------|------|------|
| **A. コンテナ PaaS（Render / Railway / Fly.io）** ← **採用（Render を第一候補、ADR-004）** | 設定が簡単、Background Worker・マネージド DB/Redis あり、月 $40〜 | 大規模化で割高 |
| B. AWS（ECS Fargate + RDS + ElastiCache） | スケール・IAM・ネットワーク分離 | 構築・運用コスト |
| C. Vercel（web）+ 他（api/worker） | web の配信が快適 | 2 事業者管理、Cookie ドメイン設計が必要 |

Docker イメージ単位で設計するため、A → B への移行は容易。

## DB マイグレーション

- 開発: `prisma migrate dev`
- 本番: デプロイパイプラインで `prisma migrate deploy`（**production 環境は手動承認ジョブ**）
- 破壊的変更は expand → migrate → contract の 2 段階リリース
- 本番 DB: 日次バックアップ + PITR（7 日以上）

## GitHub Actions

### `ci.yml`（push / pull_request）

```
checkout → setup pnpm/node（キャッシュ）→ pnpm install --frozen-lockfile
→ lint（ESLint + Prettier --check）
→ typecheck（tsc -b）
→ unit test（Vitest、mock Provider、Postgres/Redis は services コンテナ）
→ build（turbo build）
```

### `security.yml`（push / pull_request / 週次）

```
gitleaks（Secret 検知） → pnpm audit --prod → CodeQL（JS/TS）
```

### `deploy.yml`（将来）

```
main マージ → イメージ build & push（GHCR）→ staging デプロイ → smoke test
タグ v* → production（Environment 承認必須）→ migrate deploy → デプロイ → smoke test
```

## GitHub 開発フロー

### ブランチ

- `main`: 保護（PR 必須・CI 必須・レビュー 1 名以上・linear history・force push 禁止）
- 作業ブランチ: `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `docs/…`, `chore/…`
  （Claude Code のセッションでは指定ブランチ名に従う）

### コミット

- Conventional Commits（`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`）
- 1 PR = 1 Issue を原則。PR 本文に `Closes #<issue>`

### Issue

- テンプレート: 機能（目的・受け入れ条件・Phase）/ バグ（再現手順・期待値）
- ラベル: `phase:1`〜`phase:6`, `area:web|api|worker|orchestrator|providers|db|infra|docs`, `type:feature|bug|chore`, `needs-human`（人間判断が必要）
- GitHub Projects（カンバン）で Phase 単位に管理

### Claude による開発フロー

```
1. Issue を読む（受け入れ条件・関連 docs を確認）
2. 実装方針を Issue にコメント（大きな変更・設計変更は人間の合意を待つ）
3. ブランチ作成 → 実装 → テスト追加
4. ローカルで lint / typecheck / test / build を実行
5. 設計変更があれば docs/ を更新
6. Commit → Push → PR 作成（テンプレートに沿って記載）
7. CI 結果を確認し、失敗は修正
8. 人間がレビュー・マージ
```

**Claude が単独で行ってはいけないこと**: main への直接 push / merge、本番デプロイ、Secret・API キーの変更、本番 DB の変更、課金・予算設定の変更、ブランチ保護設定の変更。
