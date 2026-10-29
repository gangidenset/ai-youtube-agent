# 意思決定ログ（ADR）

設計上の重要な決定を時系列で記録する。変更時は新しいエントリを追加し、旧エントリは「置き換え」と明記する。

## ADR-001 設計提案（Phase 0）の承認 — 2026-10-29

[design-proposal.md](./design-proposal.md) の構成・技術スタック・MVP 範囲を承認。Phase 1 の実装を開始する。

## ADR-002 動画生成 Provider: Kling 3.0 Standard — 2026-10-29

- **決定**: 最初の `VideoProvider` 実装は **Kling 3.0（Standard）**。
- **理由**: 品質に対して秒単価が低く、image-to-video に対応し、5〜10 秒程度のクリップを API で非同期生成できる。
- **運用方針**:
  - 音声なし（silent）で生成する。ナレーションは TTS、BGM・効果音は権利確認済み素材を FFmpeg で合成する → 音声付き生成より安く、音の権利も管理しやすい
  - 720p で生成し、FFmpeg で 1080×1920 にアップスケールする。品質が足りなければ 1080p に切り替える（設定値）
  - 単価は `provider_pricing` で管理する（参考値: 公式 API の 720p 音声なしで約 $0.084/秒、1080p 音声なしで約 $0.112/秒。第三者による 2026 年時点の報告値で、**契約時に公式価格を確認する**）
  - 認証は Access Key + Secret Key から生成する JWT。キーは Backend の環境変数（`KLING_ACCESS_KEY` / `KLING_SECRET_KEY`）だけに置く
- **フォールバック**: Phase 2 では Kling のみ。2 社目（Veo / Runway）は Phase 6 で追加する。それまでは Kling で 3 回失敗したら担当者へ通知する。

## ADR-003 TTS Provider: Google Cloud Text-to-Speech — 2026-10-29

- **決定**: 最初の `TTSProvider` 実装は **Google Cloud TTS**。
- **理由**: 日本語の音声が多く、低価格で安定している。無料枠の範囲内で月 60 本分を賄える見込み。
- **既定の音声**: `ja-JP` の Chirp 3: HD 系（参考 $30 / 100 万文字、毎月 100 万文字まで無料）。コスト優先時は WaveNet / Standard（$4 / 100 万文字）を選べるようにする。
- **字幕タイミング**: SSML の `<mark>` による timepoint で取得する（取得できない音声タイプは文字数比例で割り当てる）。
- **認証**: サービスアカウント（JSON は環境変数 `GOOGLE_TTS_CREDENTIALS` に base64 で格納。ファイルはコミット禁止）。

## ADR-004 ホスティング: コンテナ PaaS（Render を第一候補） — 2026-10-29

- **決定**: MVP は **Render**（Web Service × 2 [web / api] + Background Worker + Render Postgres + Render Key Value [Redis 互換]）。Railway も同等に移行可能な構成（Docker イメージ単位）にする。
- 本番デプロイは GitHub Actions から Deploy Hook を呼ぶ。production は GitHub Environments の手動承認付き。
- 規模が大きくなったら AWS へ移行する（[deployment.md](./deployment.md)）。

## ADR-005 既定の言語・市場: 日本語 / 日本 — 2026-10-29

- `channel_settings.language = "ja"`、`region = "JP"` を既定値にする。
- YouTube 検索は `regionCode=JP`, `relevanceLanguage=ja`。Trend Score のジャンル中央値も JP のデータから算出する。
- UI・Claude の出力も日本語を既定とする（多言語化できるよう、UI 文言は辞書ファイルにまとめる）。

## ADR-006 企画選択: Trend Score 最高案を自動採用（手動モード併存） — 2026-10-29

- `channel_settings.idea_selection_mode` の既定値を **`AUTO_TOP`** にする。`MANUAL` に切り替えられる。
- `AUTO_TOP` の動作:
  - Originality Score が閾値（既定 60）以上で、コピーリスク・ポリシーリスクが HIGH でない案のうち、Trend Score が最も高い案を自動で選ぶ
  - 同点の場合は Originality Score が高い方を選ぶ
  - 条件を満たす案がない場合は `WAITING_IDEA_SELECTION` で止め、担当者に通知する
  - 自動選択の判断は `ai_decisions` に記録し（trigger = `SYSTEM`）、選ばれなかった案も一覧で確認・差し替えできる
- `MANUAL`: 従来どおり `WAITING_IDEA_SELECTION` で担当者の選択を待つ。
- いずれのモードでも **投稿前の人間承認は省略しない**（§22）。

## ADR-007 複数 SNS 対応（1 企画 → マスター → SNS 別出力） — 2026-10-29

- **決定**: SNS 中立の「AI コンテンツ生成エンジン」と「SNS 最適化レイヤー」を分ける。詳細は [multi-platform.md](./multi-platform.md)。
- **初期 Target**: `tiktok` / `instagram_reels` / `youtube_shorts` / `youtube_video` / `x_video` / `facebook_reels`。
- **SNS の仕様**（アスペクト比・尺・文字数・ハッシュタグ数・スタイル）は `PlatformTargetConfig` として **データで管理**する（コード内の SNS 名による分岐は禁止）。実行時の調整は `platform_config_overrides` で行う。
- **SNS の追加** = Config ファイル（必要なら Adapter サブクラス）を追加し、登録一覧に 1 行加えるだけ。
- **コスト**: 動画生成 AI（Kling）と TTS はマスターに対して 1 回だけ呼ぶ。SNS 別の差分は FFmpeg の後処理とし、テキストは選択された全 Target を Claude 1 回で一括生成する。レンダーキャッシュと部分再生成で無駄を省く。
- **マスターのアスペクト比**: 9:16 で生成し、被写体を中央に寄せる構図を指示する。1:1 は中央クロップ、16:9 はぼかし背景のピラーボックスで作る。本格的な長尺 YouTube 動画は将来、別系統のマスター台本で対応する。
- **MVP**: 動画生成 → SNS 別最適化 → プレビュー / ダウンロード。自動投稿は `Publisher` Adapter として後から追加する（YouTube は既存計画どおり Phase 3、他 SNS は Phase 7）。
- **トレンドデータ**: 公式 API で市場データを取れる YouTube を主な情報源とする。他 SNS への適合度は推定値として不確実性を明示する。
- **既存仕様の維持**: Trend Score、AUTO_TOP、Kling 3.0、Google Cloud TTS、人間承認はすべて変更しない。
