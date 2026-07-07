import { describe, expect, it } from "vitest";

import { MemoryCacheStore } from "../cache/cache-store.js";
import { createCacheStore } from "../cache/create-cache-store.js";
import { RedisCacheStore } from "../cache/redis-cache-store.js";
import { createInFlightStore } from "../in-flight/create-in-flight-store.js";
import { MemoryInFlightStore, RedisInFlightStore } from "../in-flight/in-flight-store.js";
import {
  createLastErrorStore,
  RedisLastErrorStore
} from "../observability/create-last-error-store.js";
import { createRateLimiter, RedisRateLimiter } from "../rate-limit.js";
import { createSessionStore } from "../state/create-session-store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import { RedisSessionStore } from "../state/redis-session-store.js";

class FakeRedisClient {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; PX?: number }
  ): Promise<"OK" | null> {
    if (options?.NX && this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    void options?.PX;
    return "OK";
  }

  async setEx(key: string, _seconds: number, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async incr(key: string): Promise<number> {
    const next = Number.parseInt(this.values.get(key) ?? "0", 10) + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    void _key;
    void _seconds;
    return 1;
  }

  async lPush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop + 1);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let removed = 0;
    for (const item of keys) {
      removed += this.values.delete(item) ? 1 : 0;
      this.lists.delete(item);
    }
    return removed;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return Array.from(new Set([...this.values.keys(), ...this.lists.keys()])).filter((key) =>
      key.startsWith(prefix)
    );
  }

  multi() {
    return {
      del: async () => undefined,
      exec: async () => undefined
    };
  }
}

describe("store factories", () => {
  it("uses memory stores when Redis is not configured", () => {
    expect(createSessionStore({ redis: undefined })).toBeInstanceOf(InMemorySessionStore);
    expect(createCacheStore({ redis: undefined })).toBeInstanceOf(MemoryCacheStore);
  });

  it("uses Redis stores when Redis is configured", () => {
    const redis = { client: new FakeRedisClient(), keyPrefix: "test" };

    expect(createSessionStore({ redis })).toBeInstanceOf(RedisSessionStore);
    expect(createCacheStore({ redis })).toBeInstanceOf(RedisCacheStore);
    expect(createInFlightStore({ redis })).toBeInstanceOf(RedisInFlightStore);
  });

  it("uses memory in-flight store when Redis is not configured", async () => {
    const store = createInFlightStore({ redis: undefined });

    expect(store).toBeInstanceOf(MemoryInFlightStore);
    await expect(
      store.tryStart(
        {
          profileName: "helper",
          sourceKey: "group:C1",
          action: "find_ppt_slides",
          queryHash: "abc"
        },
        60_000
      )
    ).resolves.toBe("started");
    await expect(
      store.tryStart(
        {
          profileName: "helper",
          sourceKey: "group:C1",
          action: "find_ppt_slides",
          queryHash: "abc"
        },
        60_000
      )
    ).resolves.toBe("busy");
    await store.release({
      profileName: "helper",
      sourceKey: "group:C1",
      action: "find_ppt_slides",
      queryHash: "abc"
    });
    await expect(
      store.tryStart(
        {
          profileName: "helper",
          sourceKey: "group:C1",
          action: "find_ppt_slides",
          queryHash: "abc"
        },
        60_000
      )
    ).resolves.toBe("started");
  });

  it("uses Redis NX semantics for in-flight locks", async () => {
    const client = new FakeRedisClient();
    const store = new RedisInFlightStore({ client, keyPrefix: "test" });
    const key = {
      profileName: "helper",
      sourceKey: "group:C1",
      action: "find_ppt_slides",
      queryHash: "abc"
    };

    await expect(store.tryStart(key, 60_000)).resolves.toBe("started");
    await expect(store.tryStart(key, 60_000)).resolves.toBe("busy");
    await store.release(key);
    await expect(store.tryStart(key, 60_000)).resolves.toBe("started");
  });

  it("does not match in-memory group sessions when the requester user id is missing", async () => {
    const store = new InMemorySessionStore({
      now: () => new Date("2026-07-04T10:00:00.000Z")
    });
    await store.set({
      id: "pending-1",
      type: "pending_function",
      action: "find_ppt_slides",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "C1" },
      arguments: { query: "" },
      expiresAt: "2026-07-04T10:10:00.000Z"
    });

    await expect(
      store.findPendingFunction({
        profileName: "helper",
        source: { type: "group", groupId: "C1" }
      })
    ).resolves.toBeUndefined();
    await expect(
      store.findPendingFunction({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ id: "pending-1" });
  });

  it("does not match Redis group sessions when the requester user id is missing", async () => {
    const store = new RedisSessionStore({
      client: new FakeRedisClient(),
      keyPrefix: "test",
      now: () => new Date("2026-07-04T10:00:00.000Z")
    });
    await store.set({
      id: "pending-1",
      type: "pending_function",
      action: "find_ppt_slides",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "C1" },
      arguments: { query: "" },
      expiresAt: "2026-07-04T10:10:00.000Z"
    });

    await expect(
      store.findPendingFunction({
        profileName: "helper",
        source: { type: "group", groupId: "C1" }
      })
    ).resolves.toBeUndefined();
    await expect(
      store.findPendingFunction({
        profileName: "helper",
        source: { type: "group", groupId: "C1", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toMatchObject({ id: "pending-1" });
  });

  it("stores cache values and deletes by prefix through Redis", async () => {
    const client = new FakeRedisClient();
    const cache = new RedisCacheStore({ client, keyPrefix: "test" });

    await cache.set("sheet:index", [{ id: "1" }], 60_000);
    await cache.set("other:index", "kept", 60_000);

    expect(await cache.get("sheet:index")).toEqual([{ id: "1" }]);
    expect(await cache.deleteByPrefix("sheet:")).toBe(1);
    expect(await cache.get("sheet:index")).toBeUndefined();
    expect(await cache.get("other:index")).toBe("kept");
    expect(await cache.stats()).toEqual({ totalEntries: 1 });
  });

  it("uses Redis error and rate-limit stores when Redis is configured", () => {
    const redis = { client: new FakeRedisClient(), keyPrefix: "test" };

    expect(createLastErrorStore({ redis, maxEntries: 5 })).toBeInstanceOf(RedisLastErrorStore);
    expect(
      createRateLimiter({
        redis,
        config: { enabled: true, windowMs: 60_000, maxRequests: 2 }
      })
    ).toBeInstanceOf(RedisRateLimiter);
  });

  it("stores last errors through Redis", async () => {
    const store = createLastErrorStore({
      redis: { client: new FakeRedisClient(), keyPrefix: "test" },
      maxEntries: 1
    });

    await store.record({
      requestId: "req-1",
      occurredAt: "2026-07-06T00:00:00.000Z",
      profileName: "helper",
      sourceType: "user",
      phase: "function",
      action: "find_ppt_slides",
      errorName: "Error",
      message: "failed"
    });

    expect(await store.list()).toMatchObject([{ requestId: "req-1", message: "failed" }]);
  });

  it("rate limits through Redis", async () => {
    const limiter = createRateLimiter({
      redis: { client: new FakeRedisClient(), keyPrefix: "test" },
      config: { enabled: true, windowMs: 60_000, maxRequests: 1 }
    });

    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: false });
  });
});
