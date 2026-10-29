# Provider / Adapter 設計

外部サービスはすべて `packages/providers` のインターフェース越しに利用する。ビジネスロジック（core / orchestrator / worker jobs）は実装クラスを知らない。

## インターフェース（設計）

```ts
interface ClaudeProvider {
  complete<T>(req: LlmTaskRequest<T>): Promise<LlmResult<T>>;     // 構造化出力 + usage
  runWithTools<T>(req: LlmToolLoopRequest<T>): Promise<LlmResult<T>>; // 読取系 Tool ループ
  submitBatch(reqs: LlmTaskRequest<unknown>[]): Promise<BatchHandle>;
}

interface YouTubeProvider {
  searchVideos(q: SearchQuery): Promise<SearchResult[]>;          // search.list (100u)
  getVideos(ids: string[]): Promise<VideoStats[]>;                // videos.list (1u / 50件)
  getMostPopular(region: string, categoryId?: string): Promise<VideoStats[]>;
  getChannels(ids: string[]): Promise<ChannelStats[]>;
  getComments(videoId: string, max: number): Promise<CommentSample[]>;
  uploadVideo(auth: ChannelAuth, file: AssetRef, meta: UploadMeta): Promise<UploadResult>; // 1600u
  setThumbnail(auth: ChannelAuth, videoId: string, image: AssetRef): Promise<void>;
  getAnalytics(auth: ChannelAuth, videoId: string, metrics: string[]): Promise<AnalyticsRow[]>;
  estimateQuota(op: YouTubeOp, n?: number): number;
}

interface VideoProvider {
  readonly id: string;
  readonly capabilities: { maxClipSec: number; aspectRatios: string[]; imageToVideo: boolean; audio: boolean; webhook: boolean };
  generateVideo(req: VideoGenRequest): Promise<{ externalJobId: string }>;
  getGenerationStatus(externalJobId: string): Promise<GenStatus>;   // QUEUED | RUNNING | SUCCEEDED | FAILED | BLOCKED
  downloadVideo(externalJobId: string): Promise<NodeJS.ReadableStream>;
  cancelGeneration(externalJobId: string): Promise<void>;
  getCost(req: VideoGenRequest | { externalJobId: string }): Promise<CostEstimate>;
}

interface TTSProvider {
  readonly id: string;
  generateSpeech(req: { text: string; voiceId: string; language: string; speed?: number }): Promise<{ audio: Buffer; durationSec: number; wordTimings?: WordTiming[] }>;
  getVoiceList(language?: string): Promise<Voice[]>;
  estimateCost(text: string, voiceId: string): Promise<CostEstimate>;
}

interface StorageProvider {
  put(key: string, body: Buffer | NodeJS.ReadableStream, meta: { contentType: string }): Promise<AssetRef>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  getSignedUrl(key: string, expiresSec: number): Promise<string>;
  delete(key: string): Promise<void>;
}

interface Renderer {             // FFmpeg 実装
  render(plan: RenderPlan): Promise<RenderResult>;
  probe(asset: AssetRef): Promise<MediaInfo>;   // 尺・解像度・fps・LUFS
  extractFrames(asset: AssetRef, timesSec: number[]): Promise<AssetRef[]>;
}
```

## Provider Registry

- チャンネル設定の優先順（例: `video: ["veo", "kling"]`）で Provider を選択
- Circuit Breaker: 直近 N 回の失敗率が閾値超えで一定時間除外
- フォールバック時は `capabilities`（最大尺・縦型対応）を満たすものだけを候補にする
- すべての Provider に `mock` 実装（固定の短い動画・無音/ビープ音声）→ CI・ローカル開発用
- 単価は `provider_pricing` テーブルから取得（価格改定に追従）

## YouTube

| 項目 | 内容 |
|------|------|
| API | YouTube Data API v3（検索・統計・投稿）、YouTube Analytics API（自チャンネル指標） |
| 認証 | 読取: API Key / 投稿・Analytics: OAuth 2.0（`youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`） |
| クォータ | 既定 10,000u/日/プロジェクト。`search.list`=100, `videos.list`=1, `channels.list`=1, `commentThreads.list`=1, `videos.insert`=1600, `thumbnails.set`=50 |
| 実装 | `api_quota_usage` に操作前に予約 → 実行 → 確定。残量不足は `QuotaExceeded` を投げ、ジョブを翌日（PT 0 時）に延期 |
| キャッシュ | 検索結果 6〜24h、動画統計 1h（Redis） |
| 投稿 | Resumable upload（途中失敗から再開）。`status.containsSyntheticMedia`（改変・合成コンテンツ開示）を AI 生成リアル映像の場合 true |
| 審査 | 投稿用 OAuth アプリは Google の OAuth 同意画面審査と YouTube API 監査が必要。未審査の場合アップロード動画が非公開に制限されることがある |
| 禁止 | Web 画面のスクレイピング |

## Video

**採用: Kling 3.0 Standard（ADR-002）**。他の Provider は将来のフォールバック候補（2026-10 時点の参考値。**価格・仕様は導入時に公式ドキュメントで再確認する**）:

| Provider | 特徴 | 1 クリップ | 概算単価 | 備考 |
|------|------|------|------|------|
| Google Veo（Gemini API / Vertex AI） | 高品質、音声付き生成可、縦型対応 | 〜8 秒 | $0.15〜$0.75 / 秒（モデル・音声有無で変動） | SynthID 透かし。安全フィルタ厳しめ |
| **Kling 3.0 Standard（採用）** | コスパ良、text/image-to-video | 5〜10 秒（要確認） | 720p 音声なし 約 $0.084 / 秒、1080p 音声なし 約 $0.112 / 秒（公式 API の第三者報告値） | Access Key + Secret Key → JWT。音声なしで生成する |
| Runway（Gen-4 系） | API 成熟、image-to-video | 5〜10 秒 | $0.05〜$0.15 / 秒相当（クレジット制） | |
| その他（Luma, Pika, MiniMax 等） | Provider 追加で対応 | | | |

制約と対策:

- **クリップ長が短い** → シーン（3〜6 秒）単位で生成し FFmpeg で結合
- **非同期・長時間** → `WAITING_EXTERNAL` 状態でポーリング（指数間隔）/ Webhook
- **同時実行・RPM 制限** → Provider 別 BullMQ Rate Limiter
- **コンテンツフィルタ拒否** → `BLOCKED` として Claude にプロンプト修正依頼
- **キャラクター一貫性** → 参照画像（image-to-video）対応 Provider を優先、スタイル記述の固定
- **費用暴走** → 生成前に `getCost` で見積 → 予算ガード。1 プロジェクトの再生成回数上限

## TTS

**採用: Google Cloud TTS（ADR-003）**

| Provider | 特徴 | 概算単価 |
|------|------|------|
| **Google Cloud TTS（採用）** | 低価格・安定、日本語ボイス多数 | Chirp 3: HD $30 / 100 万文字、WaveNet・Standard $4 / 100 万文字（月ごとの無料枠あり） |
| ElevenLabs（将来候補） | 日本語の自然さ、多数の声、word timestamps | 約 $0.10〜$0.30 / 1,000 文字（プラン依存） |

既定の音声は `ja-JP` の Chirp 3: HD 系。字幕タイミングは SSML `<mark>` の timepoint を優先し、取得できない音声タイプは文字数比例で割り当てる。

## Storage

- 本番: Cloudflare R2（S3 互換、エグレス無料）/ 開発: MinIO
- キー設計: `channels/{channelId}/projects/{projectId}/v{version}/{kind}/{uuid}.{ext}`
- 非公開バケット + 署名付き URL（15 分）。ライフサイクル: 中間生成物は 90 日で削除、最終動画は保持

## BGM・効果音

- **権利が明確な素材のみ**（自社所有 / 商用ライセンス購入済みライブラリ / YouTube オーディオライブラリから手動取り込み）
- `generated_assets.license_type` / `license_ref` を必須とし、ライセンス不明の素材はレンダリングで使用不可（コードで拒否）
