/**
 * 市場データの派生指標（docs/database.md の competitor_videos、docs/ai-orchestrator.md の Trend Score の材料）。
 * 純粋関数。値が非公開（高評価数・コメント数・登録者数）の場合は null にする。
 */

export interface VideoStatsInput {
  publishedAt: Date;
  fetchedAt: Date;
  viewCount: number;
  likeCount: number | null;
  commentCount: number | null;
  channelSubscribers: number | null;
}

export interface DerivedVideoMetrics {
  ageHours: number;
  viewsPerHour: number;
  viewsPerSubscriber: number | null;
  likeRate: number | null;
  commentRate: number | null;
}

/** 公開直後の動画の再生速度が極端な値にならないよう、経過時間は最低 1 時間として計算する */
export const MIN_AGE_HOURS = 1;

const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

export function deriveVideoMetrics(v: VideoStatsInput): DerivedVideoMetrics {
  const ageHours = Math.max(MIN_AGE_HOURS, (v.fetchedAt.getTime() - v.publishedAt.getTime()) / 3_600_000);
  const rate = (n: number | null) => (n === null || v.viewCount <= 0 ? null : round(n / v.viewCount));
  return {
    ageHours: round(ageHours, 3),
    viewsPerHour: round(v.viewCount / ageHours, 3),
    viewsPerSubscriber:
      v.channelSubscribers === null || v.channelSubscribers <= 0
        ? null
        : round(v.viewCount / v.channelSubscribers),
    likeRate: rate(v.likeCount),
    commentRate: rate(v.commentCount),
  };
}

/** Shorts の上限は 3 分。API では縦型かどうかが分からないため、尺だけで推定する（docs/design-proposal.md §13） */
export const SHORTS_MAX_DURATION_SEC = 180;

export function isShortEstimated(durationSec: number | null): boolean {
  return durationSec !== null && durationSec > 0 && durationSec <= SHORTS_MAX_DURATION_SEC;
}

/** ISO 8601 の尺（例: PT1M2S、P0D）を秒にする。解釈できなければ null。 */
export function parseIsoDuration(value: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m || value === "P" || value.endsWith("T")) return null;
  const [, d, h, min, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return (d ?? 0) * 86_400 + (h ?? 0) * 3_600 + (min ?? 0) * 60 + (s ?? 0);
}

// ---------------------------------------------------------------- YouTube のクォータ日（太平洋時間）

const PT_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function ptParts(at: Date) {
  const parts = Object.fromEntries(PT_PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    y: Number(parts["year"]),
    m: Number(parts["month"]),
    d: Number(parts["day"]),
    h: Number(parts["hour"]),
  };
}

/** YouTube のクォータは太平洋時間の 0 時にリセットされる。その日付（YYYY-MM-DD）。 */
export function pacificDate(at: Date): string {
  const { y, m, d } = ptParts(at);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 次に太平洋時間の 0 時になる時刻（クォータ不足で延期したジョブの再開時刻） */
export function nextPacificMidnight(at: Date): Date {
  const { y, m, d } = ptParts(at);
  // 翌日 0 時（PST = UTC-8 と仮定）。夏時間（PDT = UTC-7）なら 1 時間前にずらす
  const guess = new Date(Date.UTC(y, m - 1, d + 1, 8));
  return ptParts(guess).h === 1 ? new Date(guess.getTime() - 3_600_000) : guess;
}
