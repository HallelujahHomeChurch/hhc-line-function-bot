import { createHash } from "node:crypto";

export interface FirstSuccessScope {
  profileName: string;
  sourceType: "user" | "group";
  sourceId: string;
  requesterUserId: string;
}

export interface FirstSuccessStore {
  tryMark(scope: FirstSuccessScope, ttlMs: number): Promise<"first" | "existing">;
}

export interface RedisFirstSuccessClient {
  set(
    key: string,
    value: string,
    options: { NX: true; PX: number }
  ): Promise<"OK" | "Ok" | "ok" | string | null>;
}

export function createFirstSuccessStore(redis?: {
  client: RedisFirstSuccessClient;
  keyPrefix: string;
}): FirstSuccessStore {
  return redis
    ? new RedisFirstSuccessStore({ client: redis.client, keyPrefix: redis.keyPrefix })
    : new InMemoryFirstSuccessStore();
}

export class InMemoryFirstSuccessStore implements FirstSuccessStore {
  private readonly markers = new Map<string, number>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async tryMark(scope: FirstSuccessScope, ttlMs: number): Promise<"first" | "existing"> {
    const key = scopeHash(scope);
    const current = this.now().getTime();
    const expiresAt = this.markers.get(key);
    if (expiresAt !== undefined && expiresAt > current) {
      return "existing";
    }
    this.markers.set(key, current + normalizedTtlMs(ttlMs));
    this.sweep(current);
    return "first";
  }

  private sweep(current: number): void {
    for (const [key, expiresAt] of this.markers) {
      if (expiresAt <= current) {
        this.markers.delete(key);
      }
    }
  }
}

export class RedisFirstSuccessStore implements FirstSuccessStore {
  private readonly client: RedisFirstSuccessClient;
  private readonly keyPrefix: string;

  constructor(options: { client: RedisFirstSuccessClient; keyPrefix: string }) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix;
  }

  async tryMark(scope: FirstSuccessScope, ttlMs: number): Promise<"first" | "existing"> {
    const result = await this.client.set(this.key(scope), "1", {
      NX: true,
      PX: normalizedTtlMs(ttlMs)
    });
    return result ? "first" : "existing";
  }

  private key(scope: FirstSuccessScope): string {
    return `${this.keyPrefix}:first-success:v1:${scopeHash(scope)}`;
  }
}

function scopeHash(scope: FirstSuccessScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([scope.profileName, scope.sourceType, scope.sourceId, scope.requesterUserId]),
      "utf8"
    )
    .digest("hex");
}

function normalizedTtlMs(ttlMs: number): number {
  return Math.max(1, Math.trunc(ttlMs));
}
