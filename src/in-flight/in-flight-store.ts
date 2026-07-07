export interface InFlightKey {
  profileName: string;
  sourceKey: string;
  action: string;
  queryHash: string;
}

export type InFlightStartResult = "started" | "busy";

export interface InFlightStore {
  tryStart(key: InFlightKey, ttlMs: number): Promise<InFlightStartResult>;
  release(key: InFlightKey): Promise<void>;
}

export interface MemoryInFlightStoreOptions {
  now?: () => Date;
}

export class MemoryInFlightStore implements InFlightStore {
  private readonly now: () => Date;
  private readonly locks = new Map<string, number>();

  constructor(options: MemoryInFlightStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async tryStart(key: InFlightKey, ttlMs: number): Promise<InFlightStartResult> {
    const serialized = serializeKey(key);
    const now = this.now().getTime();
    const expiresAt = this.locks.get(serialized);
    if (expiresAt && expiresAt > now) {
      return "busy";
    }
    this.locks.set(serialized, now + ttlMs);
    this.sweep(now);
    return "started";
  }

  async release(key: InFlightKey): Promise<void> {
    this.locks.delete(serializeKey(key));
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.locks.entries()) {
      if (expiresAt <= now) {
        this.locks.delete(key);
      }
    }
  }
}

export interface RedisInFlightClient {
  set(
    key: string,
    value: string,
    options: { NX: true; PX: number }
  ): Promise<"OK" | "Ok" | "ok" | string | null>;
  del(key: string | string[]): Promise<number>;
}

export interface RedisInFlightStoreOptions {
  client: RedisInFlightClient;
  keyPrefix: string;
}

export class RedisInFlightStore implements InFlightStore {
  constructor(private readonly options: RedisInFlightStoreOptions) {}

  async tryStart(key: InFlightKey, ttlMs: number): Promise<InFlightStartResult> {
    const result = await this.options.client.set(this.key(key), "1", {
      NX: true,
      PX: Math.max(1, ttlMs)
    });
    return result ? "started" : "busy";
  }

  async release(key: InFlightKey): Promise<void> {
    await this.options.client.del(this.key(key));
  }

  private key(key: InFlightKey): string {
    return `${this.options.keyPrefix}:in-flight:${serializeKey(key)}`;
  }
}

function serializeKey(key: InFlightKey): string {
  return [key.profileName, key.sourceKey, key.action, key.queryHash]
    .map((part) => encodeURIComponent(part))
    .join(":");
}
