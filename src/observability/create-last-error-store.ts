import {
  InMemoryLastErrorStore,
  type LastErrorRecord,
  type LastErrorStore
} from "./last-error-store.js";
import { sanitizeLastErrorRecord } from "./action-telemetry.js";

export interface RedisLastErrorClient {
  lPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
}

export interface LastErrorStoreFactoryOptions {
  maxEntries: number;
  redis?: {
    client: RedisLastErrorClient;
    keyPrefix: string;
  };
}

export class RedisLastErrorStore implements LastErrorStore {
  constructor(private readonly options: Required<LastErrorStoreFactoryOptions>) {}

  async record(error: LastErrorRecord): Promise<void> {
    await this.options.redis.client.lPush(this.key(), JSON.stringify(sanitizeLastErrorRecord(error)));
    await this.options.redis.client.lTrim(this.key(), 0, this.options.maxEntries - 1);
  }

  async list(): Promise<LastErrorRecord[]> {
    const values = await this.options.redis.client.lRange(
      this.key(),
      0,
      this.options.maxEntries - 1
    );
    return values.map((value) => JSON.parse(value) as LastErrorRecord);
  }

  async clear(): Promise<number> {
    return this.options.redis.client.del(this.key());
  }

  private key(): string {
    return `${this.options.redis.keyPrefix}:last-errors`;
  }
}

export function createLastErrorStore(options: LastErrorStoreFactoryOptions): LastErrorStore {
  if (options.redis) {
    return new RedisLastErrorStore({
      maxEntries: options.maxEntries,
      redis: options.redis
    });
  }
  return new InMemoryLastErrorStore(options.maxEntries);
}
