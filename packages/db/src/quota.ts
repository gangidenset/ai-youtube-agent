import { pacificDate, YOUTUBE_UPLOAD_RESERVE_UNITS } from "@aya/core";
import type { PrismaClient } from "./client";

export interface QuotaStoreOptions {
  provider: string;
  /** 例: youtube:default（Google Cloud プロジェクトごとにクォータが分かれる） */
  bucket: string;
  dailyLimit: number;
  /** この分は残しておく（既定: 投稿 1 回分 = 1,600 units） */
  keepReserve?: number;
  now?: () => Date;
}

/**
 * api_quota_usage を使ったクォータの台帳（packages/providers の QuotaStore を満たす）。
 * 「上限 - 予備 を超えないときだけ加算」を 1 つの UPDATE で行うので、複数のワーカーが同時に予約しても超過しない。
 * 日付は YouTube のクォータがリセットされる太平洋時間で区切る。
 */
export class PrismaQuotaStore {
  private readonly keepReserve: number;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: QuotaStoreOptions,
  ) {
    this.keepReserve = options.keepReserve ?? YOUTUBE_UPLOAD_RESERVE_UNITS;
    this.now = options.now ?? (() => new Date());
  }

  /** クォータ日（太平洋時間の日付）。DB の date 型と比べるので YYYY-MM-DD の文字列でも持つ */
  private today(): { key: string; date: Date } {
    const key = pacificDate(this.now());
    return { key, date: new Date(`${key}T00:00:00Z`) };
  }

  private async ensureRow(date: Date): Promise<void> {
    const where = {
      provider_quotaBucket_date: { provider: this.options.provider, quotaBucket: this.options.bucket, date },
    };
    try {
      await this.prisma.apiQuotaUsage.upsert({
        where,
        create: {
          provider: this.options.provider,
          quotaBucket: this.options.bucket,
          date,
          unitsLimit: this.options.dailyLimit,
        },
        update: {},
      });
    } catch (err) {
      // 同時に別のワーカーが作成した場合（一意制約違反）は作成済みなので続ける
      if (!(err instanceof Error && "code" in err && err.code === "P2002")) throw err;
    }
  }

  async reserve(units: number): Promise<{ ok: true } | { ok: false; remaining: number }> {
    const { key, date } = this.today();
    await this.ensureRow(date);
    const updated = await this.prisma.$queryRaw<{ units_used: number }[]>`
      UPDATE api_quota_usage
      SET units_used = units_used + ${units}, updated_at = now()
      WHERE provider = ${this.options.provider}
        AND quota_bucket = ${this.options.bucket}
        AND date = ${key}::date
        AND units_used + ${units} + ${this.keepReserve} <= units_limit
      RETURNING units_used`;
    if (updated.length > 0) return { ok: true };
    return { ok: false, remaining: await this.remaining() };
  }

  /** 予備を除いて、今日あと何 units 使えるか */
  async remaining(): Promise<number> {
    const row = await this.prisma.apiQuotaUsage.findUnique({
      where: {
        provider_quotaBucket_date: {
          provider: this.options.provider,
          quotaBucket: this.options.bucket,
          date: this.today().date,
        },
      },
    });
    const used = row?.unitsUsed ?? 0;
    const limit = row?.unitsLimit ?? this.options.dailyLimit;
    return Math.max(0, limit - used - this.keepReserve);
  }
}
