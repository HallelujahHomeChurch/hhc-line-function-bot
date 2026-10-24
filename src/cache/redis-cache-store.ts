import type { CacheStore, CacheStoreStats } from "./cache-store.js";
import { scanKeyBatches, type RedisScanClient } from "../redis-scan.js";

export interface RedisCacheClient extends RedisScanClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
}

export interface RedisCacheStoreOptions {
  client: RedisCacheClient;
  keyPrefix: string;
}

export class RedisCacheStore implements CacheStore {
  constructor(private readonly options: RedisCacheStoreOptions) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.options.client.get(this.key(key));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.options.client.setEx(this.key(key), ttlSeconds(ttlMs), JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.options.client.del(this.key(key));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for await (const keys of scanKeyBatches(this.options.client, this.key(prefix))) {
      deleted += await this.options.client.del(keys);
    }
    return deleted;
  }

  async stats(): Promise<CacheStoreStats> {
    const seen = new Set<string>();
    for await (const keys of scanKeyBatches(this.options.client, this.key(""))) {
      for (const key of keys) seen.add(key);
    }
    return { totalEntries: seen.size };
  }

  private key(key: string): string {
    return `${this.options.keyPrefix}:cache:${key}`;
  }
}

function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}
