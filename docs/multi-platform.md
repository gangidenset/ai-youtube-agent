# 複数 SNS 対応設計

> 決定: [decisions.md](./decisions.md) の ADR-007
> 方針: 特定 SNS 専用ではなく「**1 つの企画から複数 SNS 向けコンテンツを生成するプラットフォーム**」にする。
> 既存の仕様（市場分析・Trend Score・自動企画採用・Kling 3.0・Google Cloud TTS・人間承認）はすべて維持する。

---

## 1. 現在の実装状況（2026-10-29 時点）

| 区分 | 状況 |
|------|------|
| アプリケーションコード | **未着手**（Phase 0 設計のみ） |
| 設計ドキュメント | `docs/` 配下 11 ファイル（YouTube 投稿を前提にした記述が一部にある） |
| GitHub | Phase 1 の Issue #1〜#12 を登録済み |
| SNS 依存箇所（設計上） | `youtube_uploads` テーブル、`YOUTUBE_UPLOAD` 状態、`upload_youtube` / `create_youtube_metadata` Tool、`channels.youtube_channel_id`、`RenderProfile` が 9:16 固定 |

コードはまだないので、**既存機能を壊すリスクはない**。今のうちに設計の中心を SNS 中立にしておけば、後から改修するコストもかからない。

## 2. SNS 対応に必要な変更点

| # | 変更点 | 内容 |
|---|------|------|
| 1 | **出力先（Output Target）の抽象化** | 「SNS（Platform）」と「出力形式（Target）」を分ける。例: YouTube（Platform）→ `youtube_shorts` / `youtube_video`（Target） |
| 2 | **PlatformConfig をデータとして管理** | アスペクト比・尺・文字数・ハッシュタグ数などの仕様はコードに埋め込まず、設定ファイル（Zod で検証）+ DB の上書き設定で管理する |
| 3 | **Platform Adapter** | 共通動作は `DefaultPlatformAdapter`（設定駆動）で処理し、SNS 固有の違いだけをサブクラスで上書きする |
| 4 | **マスターコンテンツ** | 台本・シーン動画（Kling）・ナレーション（TTS）は **1 回だけ生成**する。SNS 別の出力は FFmpeg の後処理とテキスト生成だけで作る |
| 5 | **SNS 別メタデータの一括生成** | 選ばれたすべての SNS のタイトル・投稿文・説明文・ハッシュタグ・CTA・フックを **Claude 1 回の呼び出し** でまとめて生成する |
| 6 | **フックテンプレート** | 冒頭 3 秒の構成をテンプレート（データ）として登録し、追加できるようにする |
| 7 | **ワークフロー** | `VIDEO_EDITING` を「マスター編集」とし、その後に `PLATFORM_OPTIMIZATION` を追加。MVP の終点は `READY_FOR_DOWNLOAD`。投稿は `PUBLISHING`（Target ごと）に一般化する |
| 8 | **DB** | `platform_variants`（Target 別の成果物）、`publications`（投稿の汎用テーブル）、`platform_accounts`、`platform_config_overrides` を追加する。`youtube_uploads` は YouTube 固有の詳細テーブルとして残す |
| 9 | **投稿 Adapter（将来）** | `Publisher` インターフェースを作る。MVP では「ダウンロード」だけを実装する |
| 10 | **トレンド情報源の抽象化** | `TrendSource` インターフェースを作る。公式 API で市場データを取れるのは現状 YouTube のみ（後述） |
| 11 | **UI** | テーマ入力 → SNS 選択（複数）→ [動画を生成] → SNS 別プレビュー・ダウンロード のシンプルな流れ |

## 3. 推奨アーキテクチャ

```
┌──────────────────────────────────────────────┐
│ AI コンテンツ生成エンジン（SNS 中立）             │
│  市場分析 → Trend Score → 企画（AUTO_TOP）       │
│  → マスター台本 → マスター素材（Kling / TTS）     │
│  → マスター動画（FFmpeg）                        │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ SNS 最適化レイヤー（packages/platforms）          │
│  PlatformRegistry ─ PlatformConfig（設定）        │
│                  └ PlatformAdapter（差分ロジック）│
│  HookTemplate Registry                          │
│  ・メタデータ一括生成（Claude 1 回）               │
│  ・Target 別レンダリング（FFmpeg のみ）            │
│  ・制約チェック（文字数・尺・サイズ）               │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ 配信レイヤー                                     │
│  MVP: ダウンロード（署名付き URL）                 │
│  将来: Publisher Adapter（YouTube → TikTok →     │
│        Instagram → Facebook → X …）+ 予約投稿     │
└──────────────────────────────────────────────┘
```

### 3.1 Platform と Target

| Platform | Target ID | 表示名 | 既定アスペクト比 | コンテンツ系統 |
|------|------|------|------|------|
| tiktok | `tiktok` | TikTok | 9:16 | SHORT_VERTICAL |
| instagram | `instagram_reels` | Instagram Reels | 9:16 | SHORT_VERTICAL |
| youtube | `youtube_shorts` | YouTube Shorts | 9:16 | SHORT_VERTICAL |
| youtube | `youtube_video` | YouTube（通常動画） | 16:9 | LONG_HORIZONTAL |
| x | `x_video` | X | 1:1（16:9 / 9:16 も可） | FEED |
| facebook | `facebook_reels` | Facebook Reels | 9:16 | SHORT_VERTICAL |

コード内で SNS 名を分岐（`if (platform === "tiktok")`）するのは **禁止**。差異は Config の値か Adapter の上書きで表す。

### 3.2 PlatformConfig（設定）

```ts
// packages/platforms/src/types.ts
PlatformTargetConfig = {
  id: "tiktok",                       // Target ID（安定キー）
  platform: "tiktok",                 // SNS
  displayName: "TikTok",
  contentFamily: "SHORT_VERTICAL",
  specVersion: "2026-10-29",          // 仕様を更新したら変える → レンダーキャッシュも無効化
  verified: false,                    // 公式仕様で確認済みか
  video: {
    aspectRatio: "9:16", width: 1080, height: 1920, fps: 30,
    maxDurationSec: 600, recommendedDurationSec: { min: 15, max: 45 },
    maxFileSizeMb: 500, loudnessLufs: -14,
    safeArea: { top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 }, // UI に隠れる領域（字幕を避ける）
  },
  text: {
    titleLimit: null, captionLimit: 4000, descriptionLimit: null,
    hashtagLimit: 5, recommendedHashtags: { min: 3, max: 5 },
    hashtagPlacement: "CAPTION_END", textLengthUnit: "CHAR",   // X は "WEIGHTED"
    fields: ["caption", "hashtags", "cta"],                   // このTargetが必要とする項目
  },
  style: {
    captionStyle: "CASUAL", hookEmphasis: "HIGH", hookMaxSec: 2,
    preferredHookTemplates: ["shock_fact", "question_loss"],
    subtitleStyle: "BOLD_CENTER",
  },
  features: { chapters: false, thumbnail: false, scheduling: true },
}
```

- 既定値は `packages/platforms/src/targets/*.ts` に置く（Git でバージョン管理する）。
- 実行時の調整は DB の `platform_config_overrides`（OWNER のみ、監査ログに記録）。読み込み時に既定値とマージし、Zod で再検証する。
- 仕様の値（尺上限・文字数など）は各 SNS が頻繁に変える。**初期値は `verified: false`** とし、各社の公式ドキュメントで確認した時点で `verified: true` と `specVersion` を更新する。

### 3.3 Platform Adapter（差分ロジック）

```ts
interface PlatformAdapter {
  readonly config: PlatformTargetConfig;
  buildRenderSpec(master: MasterRenderInfo): RenderSpec;          // リフレーム・トリム・字幕の位置・エンドカード
  buildMetadataPromptHints(): string;                             // Claude に渡す SNS 別の作法（データから生成）
  normalizeMetadata(raw: TargetMetadata): TargetMetadata;         // ハッシュタグの整形・重複除去
  validateMetadata(m: TargetMetadata): ValidationIssue[];         // 文字数・個数・必須項目
  formatPostText(m: TargetMetadata): string;                      // 投稿文 + ハッシュタグの組み立て
  readonly publisher?: Publisher;                                 // 将来: 投稿 Adapter
}
```

- `DefaultPlatformAdapter` が Config だけで上記をすべて処理する。
- 固有処理がある SNS だけサブクラスを作る:
  - `YouTubeShortsAdapter`: 必要に応じて `#Shorts` を付ける
  - `YouTubeVideoAdapter`: 説明文にチャプター（将来）
  - `XAdapter`: 加重文字数（全角 = 2）で投稿文を数える
- **新しい SNS の追加手順**:
  1. `targets/threads.ts` に Config を書く（必要なら Adapter サブクラスも）
  2. `targets/index.ts` の一覧に 1 行追加する
  3. （投稿する場合）`publishers/threads.ts` を追加する

  ワークフロー・DB・UI・プロンプトは Registry から一覧を取得するので、修正は不要。

### 3.4 マスターコンテンツと再利用（コスト最優先）

```
企画（AUTO_TOP）
 ↓
マスター台本（SNS 中立、§17 JSON + scene.priority）        … Claude 1 回
 ↓
マスター素材
 ├─ シーン動画: Kling 3.0（9:16、被写体を中央に寄せる構図指示）  … シーン数分 × 1 回だけ
 └─ ナレーション: Google TTS                                    … 1 回だけ
 ↓
マスター動画（9:16 / 1080×1920 / 字幕なしのクリーン版 + 字幕データ）  … FFmpeg
 ↓
SNS 最適化（PLATFORM_OPTIMIZATION）
 ├─ メタデータ: 選択された全 Target を Claude 1 回で一括生成
 ├─ フック: Target 別のフックの文言（同じ呼び出しで生成）→ 必要ならフック部分だけ TTS
 └─ Target 別レンダリング: FFmpeg のみ（AI 呼び出しなし）
      ├─ 9:16 → そのまま + SNS 別の字幕スタイル・セーフエリア・エンドカード
      ├─ 1:1 → 中央クロップ（被写体中央の構図で生成しているため成立する）
      └─ 16:9 → ぼかし背景のピラーボックス（または 2 分割レイアウト）
```

| 方針 | 実装 |
|------|------|
| 動画生成 AI はマスターに対して 1 回だけ | 3 SNS を選んでも Kling の呼び出し回数は同じ |
| 差分は後処理 | アスペクト比・尺・字幕・フックのテロップ・CTA エンドカードは FFmpeg |
| テキストは一括生成 | Target が増えても Claude の呼び出しは 1 回（出力トークンが少し増えるだけ） |
| キャッシュ | レンダーキャッシュキー = `hash(マスター素材の sha256 群 + target.id + specVersion + overlay パラメータ)`。同じキーなら再レンダリングしない。TTS は `hash(text + voice)` でキャッシュ |
| 部分再生成 | 投稿文だけの修正 → 再レンダリングなし／シーン 3 の修正 → シーン 3 のクリップだけ Kling で再生成し、全 Target は FFmpeg で作り直す（安価）／フックの修正 → フックのテロップと音声だけ |
| 尺の調整 | 台本のシーンに `priority`（`CORE` / `OPTIONAL`）を持たせ、Target の上限を超える場合は OPTIONAL シーンを省いて組み直す（AI の再呼び出しなし） |
| YouTube 通常動画 | MVP はマスターを 16:9 にリフレームした簡易版。本格的な長尺は「同じ企画から長尺用マスター台本を作る」別系統として将来対応（`contentFamily` で区別） |

**追加コストの目安**（30 秒動画・3 SNS 選択）: Kling $0（追加なし）／Claude 約 $0.02〜$0.05（一括生成の出力増分）／TTS（フック分）約 $0.001／FFmpeg（CPU のみ）。

### 3.5 フックテンプレート（冒頭 3 秒）

`packages/platforms/src/hooks/templates.ts` にデータとして登録する（追加はファイルへの追記だけ）。

| ID | 名称 | 構成 |
|------|------|------|
| `problem_fact_conclusion` | 問題提起型 | 問題提起 → 意外な事実 → 結論 → 理由 → CTA |
| `question_loss` | 損失回避の質問型 | 「知らないと損」質問 → 結論 → 理由 → CTA |
| `shock_fact` | 衝撃事実型 | 意外な数字・事実 → 理由 → 具体例 → CTA |
| `conclusion_first` | 結論先出し型 | 結論 → 理由 × 3 → まとめ → CTA |
| `before_after` | ビフォーアフター型 | 結果を先に見せる → 過程 → 方法 → CTA |
| `list_teaser` | リスト予告型 | 「〇〇 3 選」 → 1 → 2 → 3 → CTA |

各テンプレートは `steps[]`、`suitableFamilies[]`、Claude 用の `promptGuidance` を持つ。Target の `style.preferredHookTemplates` と成功パターン（`success_patterns`）から、Claude が Target ごとに最適なテンプレートを選ぶ。

### 3.6 SNS 別に生成するもの

| 項目 | 生成元 | 例（テーマ: AI 副業） |
|------|------|------|
| 動画 | マスター + Target 別レンダリング | — |
| タイトル | Claude（`titleLimit` を守る） | YouTube Shorts:「【初心者向け】AI副業で最初にやるべき3つ」 |
| 投稿文 / キャプション | Claude（`captionStyle` を反映） | TikTok:「これ知らないと損するAI副業3選」／ Instagram:「AI副業を始めるなら、まずこの3つから。」 |
| 説明文 | Claude（`descriptionLimit`） | YouTube 系のみ |
| ハッシュタグ | Claude 生成 → Adapter で整形・個数制限 | |
| CTA | Claude（SNS の作法に合わせる: 保存／フォロー／チャンネル登録） | |
| フック | テンプレート + Claude | Target ごとの冒頭テロップ・ナレーション |

生成結果はコードで検証する（`validateMetadata`）。超過した Target だけ、短縮の再要求（小さい呼び出し）を行う。

### 3.7 トレンド情報源について（制約）

| SNS | 市場データの公式 API | 扱い |
|------|------|------|
| YouTube | Data API v3（公開統計） | **主な情報源**（既存仕様） |
| TikTok | Research API は学術・非商用向けに限定、Creative Center に公開 API なし | 使わない。スクレイピングもしない |
| Instagram / Facebook | 自アカウントの Insights のみ（他人のトレンドは不可） | 投稿後分析（将来）でのみ使う |
| X | API は有料プラン。検索は高コスト | 将来の任意オプション |

そのため Trend Score は YouTube のデータで算出し、他の SNS への適合度は Claude の定性評価と、自アカウントの投稿後実績（将来）で補正する。**「他 SNS のトレンドは推定値」であることを UI の不確実性欄に表示する。**

### 3.8 将来の自動投稿（Publisher Adapter）

```ts
interface Publisher {
  readonly platform: string;
  connect(): OAuthStartInfo;                                  // アカウント連携
  publish(req: PublishRequest): Promise<PublishResult>;       // 即時 or 予約
  getStatus(externalPostId: string): Promise<PublishStatus>;
  getMetrics?(externalPostId: string): Promise<PostMetrics>;  // 投稿後分析
}
```

| SNS | 公式 API（要確認・審査あり） | 優先度 |
|------|------|------|
| YouTube | Data API v3 `videos.insert`（OAuth 審査） | Phase 3（既存計画） |
| TikTok | Content Posting API（アプリ審査前は非公開投稿のみ） | Phase 7 |
| Instagram Reels | Instagram Graph API（ビジネス / クリエイターアカウント） | Phase 7 |
| Facebook Reels | Pages API（Reels 投稿） | Phase 7 |
| X | API v2 メディアアップロード（有料プラン） | Phase 7 |

人間承認は Target ごとに行う（「全部承認」ボタンも用意する）。自動投稿の条件（§41）も Target ごとに評価する。

## 4. 変更するファイル

### ドキュメント

| ファイル | 変更 |
|------|------|
| `docs/multi-platform.md` | **新規**（本書） |
| `docs/decisions.md` | ADR-007 を追加 |
| `docs/design-proposal.md` | 全体図・ロードマップ・MVP に複数 SNS を反映 |
| `docs/architecture.md` | `packages/platforms` を追加、レイヤー図を更新 |
| `docs/database.md` | `platform_variants` / `publications` / `platform_accounts` / `platform_config_overrides` を追加 |
| `docs/workflow.md` | `PLATFORM_OPTIMIZATION` / `READY_FOR_DOWNLOAD` / `PUBLISHING` を追加 |
| `docs/api.md` | Target 一覧・Variant・ダウンロード API を追加 |
| `docs/ai-orchestrator.md` | Tool の一般化（`create_platform_metadata`, `publish_content`） |
| `docs/providers.md` | `Publisher` / `TrendSource` を追加 |

### コード（新規。既存コードがないため変更はなし）

```
packages/platforms/
├── package.json
├── src/
│   ├── index.ts
│   ├── types.ts                 # PlatformTargetConfig / TargetMetadata の Zod スキーマ
│   ├── registry.ts              # PlatformRegistry（登録・検索・上書きのマージ）
│   ├── adapters/
│   │   ├── default-adapter.ts   # 設定駆動の共通実装
│   │   ├── youtube-shorts.ts
│   │   └── x.ts
│   ├── targets/
│   │   ├── index.ts             # 登録一覧（SNS 追加時はここに 1 行）
│   │   ├── tiktok.ts
│   │   ├── instagram-reels.ts
│   │   ├── youtube-shorts.ts
│   │   ├── youtube-video.ts
│   │   ├── x-video.ts
│   │   └── facebook-reels.ts
│   ├── hooks/templates.ts       # フックテンプレート
│   ├── render-spec.ts           # アスペクト比変換の計画（純粋関数）
│   ├── text.ts                  # 文字数カウント（CHAR / WEIGHTED）・ハッシュタグ整形
│   └── cache-key.ts             # レンダーキャッシュキー
└── test/*.test.ts
```

## 5. 実装手順

| 順番 | 内容 | Issue |
|------|------|------|
| 1 | Monorepo 基盤 + CI | #1 |
| 2 | `packages/platforms`: Config・Registry・Adapter・フックテンプレート・テキスト検証・レンダー計画・キャッシュキー（純粋関数とテスト） | #13 |
| 3 | DB に Variant / Publication 系テーブルを追加（Phase 1 のスキーマに含める） | #3 に追記 |
| 4 | SNS 別メタデータの一括生成（Claude 1 回）+ 検証 + 短縮の再要求 | #14 |
| 5 | SNS 選択 UI とシンプルな生成フロー（テーマ → SNS → 生成 → SNS 別の結果） | #14 |
| 6 | （Phase 2）マスター動画 + Target 別 FFmpeg レンダリング + キャッシュ + ダウンロード | #15 |
| 7 | （Phase 3）Publisher: YouTube から実装 | 既存計画 |
| 8 | （Phase 7）Publisher: TikTok / Instagram / Facebook / X | 未作成 |

**MVP の範囲（複数 SNS）**: 動画生成 → SNS 別最適化 → プレビュー / ダウンロード。自動投稿は含めない（YouTube 投稿は既存計画どおり Phase 3）。
