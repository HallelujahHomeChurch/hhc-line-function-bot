import { sanitizeLastRouteRecord } from "./action-telemetry.js";
import {
  InMemoryLastRouteStore,
  type LastRouteRecord,
  type LastRouteStore
} from "./last-route-store.js";

export interface RedisLastRouteClient {
  lPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
}

export interface LastRouteStoreFactoryOptions {
  maxEntries: number;
  redis?: { client: RedisLastRouteClient; keyPrefix: string };
}

export class RedisLastRouteStore implements LastRouteStore {
  private readonly maxEntries: number;

  constructor(private readonly options: Required<LastRouteStoreFactoryOptions>) {
    this.maxEntries = Math.max(1, Math.min(options.maxEntries, 100));
  }

  async record(route: LastRouteRecord): Promise<void> {
    const sanitized = sanitizeLastRouteRecord(route);
    await this.options.redis.client.lPush(this.key, JSON.stringify(sanitized));
    await this.options.redis.client.lTrim(this.key, 0, this.maxEntries - 1);
  }

  async list(): Promise<LastRouteRecord[]> {
    const values = await this.options.redis.client.lRange(this.key, 0, this.maxEntries - 1);
    return values.flatMap((value) => {
      try {
        return [sanitizeLastRouteRecord(JSON.parse(value) as LastRouteRecord)];
      } catch {
        return [];
      }
    });
  }

  async clear(): Promise<number> {
    return this.options.redis.client.del(this.key);
  }

  private get key(): string {
    return `${this.options.redis.keyPrefix}:last-routes:v2`;
  }
}

export function createLastRouteStore(options: LastRouteStoreFactoryOptions): LastRouteStore {
  if (options.redis) {
    return new RedisLastRouteStore({ maxEntries: options.maxEntries, redis: options.redis });
  }
  return new InMemoryLastRouteStore(Math.max(1, Math.min(options.maxEntries, 100)));
}
