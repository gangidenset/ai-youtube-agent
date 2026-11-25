import type { Redis } from "ioredis";
import type { CacheStore } from "../youtube/guarded";

/** Redis を使ったキャッシュ。 */
export class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: Pick<Redis, "get" | "set">) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }
}
