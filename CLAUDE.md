# CLAUDE.md — 本リポジトリで開発する Claude 向けルール

## 最初に読むもの

- `docs/design-proposal.md`（全体像・Phase 範囲）
- 作業対象に関係する `docs/*.md`

## 開発フロー

1. Issue の受け入れ条件と関連 docs を確認する
2. 方針を決める。設計変更を伴う場合は Issue/PR で人間の合意を得てから実装する
3. 作業ブランチで実装し、テストを追加する
4. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` が通ることを確認する
5. 設計に影響する変更は `docs/` も同じ PR で更新する
6. Conventional Commits でコミットし、PR テンプレートに沿って PR を作成する

## 絶対に守ること

- API キー・OAuth トークン・Secret をコードやコミットに含めない。`.env` はコミットしない（`.env.example` のみ）
- Frontend（`apps/web`）から Secret や外部 API に直接アクセスしない
- 外部サービスは `packages/providers` のインターフェース経由でのみ使う
- Claude（アプリ内の AI）の出力は必ず Zod で検証し、Workflow Engine のガードを通してから実行する
- `upload_youtube` は人間承認なしに実行できない状態を保つ
- YouTube の Web 画面スクレイピング、Claude Web 版の自動操作を実装しない
- テストを skip / 無効化して CI を通さない

## 人間の承認が必要な操作（Claude 単独では行わない）

- `main` へのマージ・直接 push
- 本番デプロイ、本番 DB マイグレーション
- Secret / API キーの追加・変更
- 予算・課金設定、ブランチ保護設定の変更

## コード規約

- TypeScript strict。`any` は原則禁止（やむを得ない場合は理由をコメント）
- ドメインロジック（`packages/core`）は副作用を持たない純粋関数にし、ユニットテストを書く
- 外部 API 呼び出しには必ずコスト記録（`ai_costs`）とクォータ確認を入れる
- ジョブは冪等に書く（`idempotency_key`）
