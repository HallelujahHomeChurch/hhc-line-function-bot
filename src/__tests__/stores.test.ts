import { describe, expect, it, vi } from "vitest";

import { MemoryCacheStore } from "../cache/cache-store.js";
import { createCacheStore } from "../cache/create-cache-store.js";
import { RedisCacheStore } from "../cache/redis-cache-store.js";
import { createInFlightStore } from "../in-flight/create-in-flight-store.js";
import { MemoryInFlightStore, RedisInFlightStore } from "../in-flight/in-flight-store.js";
import { createWebhookEventStore } from "../idempotency/create-webhook-event-store.js";
import {
  InMemoryWebhookEventStore,
  RedisWebhookEventStore
} from "../idempotency/webhook-event-store.js";
import {
  createLastErrorStore,
  RedisLastErrorStore
} from "../observability/create-last-error-store.js";
import {
  createLastRouteStore,
  RedisLastRouteStore
} from "../observability/create-last-route-store.js";
import { createRateLimiter, RedisRateLimiter } from "../rate-limit.js";
import { createSessionStore } from "../state/create-session-store.js";
import { InMemorySessionStore } from "../state/session-store.js";
import { RedisSessionStore } from "../state/redis-session-store.js";
import { runScheduleMigrations } from "../schedules/migrations.js";
import { PostgresScheduleStore, type PgQueryable } from "../schedules/postgres-store.js";
import { InMemoryScheduleStore } from "../schedules/store.js";

class FakeRedisClient {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
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
      const existed = this.values.has(item) || this.lists.has(item);
      this.values.delete(item);
      this.lists.delete(item);
      removed += existed ? 1 : 0;
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
  it("atomically consumes a Redis selection once", async () => {
    const store = new RedisSessionStore({
      client: new FakeRedisClient(),
      keyPrefix: "test",
      now: () => new Date("2026-07-15T10:00:00.000Z")
    });
    await store.set({
      id: "selection-1",
      type: "selection",
      action: "find_sheet_music",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "G1", userId: "U1" },
      items: [{ id: "item-1", name: "song.pdf", driveId: "drive-1" }],
      expiresAt: "2026-07-15T10:02:00.000Z"
    });

    const results = await Promise.all([store.take("selection-1"), store.take("selection-1")]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("deduplicates webhook events by profile with memory and Redis stores", async () => {
    const stores = [
      new InMemoryWebhookEventStore(() => new Date("2026-07-15T10:00:00.000Z")),
      new RedisWebhookEventStore(new FakeRedisClient(), "test")
    ];
    for (const store of stores) {
      await expect(store.tryStart("helper", "evt-1", 60_000)).resolves.toBe("started");
      await expect(store.tryStart("helper", "evt-1", 60_000)).resolves.toBe("duplicate");
      await expect(store.tryStart("other", "evt-1", 60_000)).resolves.toBe("started");
    }
  });
  it("atomically consumes a Redis upload intent once", async () => {
    const store = new RedisSessionStore({
      client: new FakeRedisClient(),
      keyPrefix: "test",
      now: () => new Date("2026-07-15T10:00:00.000Z")
    });
    await store.set({
      id: "intent-1",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "G1", userId: "U1" },
      expiresAt: "2026-07-15T10:02:00.000Z"
    });

    const results = await Promise.all([
      store.takeUploadIntent({
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U1" },
        requesterUserId: "U1"
      }),
      store.takeUploadIntent({
        profileName: "helper",
        source: { type: "group", groupId: "G1", userId: "U1" },
        requesterUserId: "U1"
      })
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("uses memory stores when Redis is not configured", () => {
    expect(createSessionStore({ redis: undefined })).toBeInstanceOf(InMemorySessionStore);
    expect(createCacheStore({ redis: undefined })).toBeInstanceOf(MemoryCacheStore);
  });

  it("uses Redis stores when Redis is configured", () => {
    const redis = { client: new FakeRedisClient(), keyPrefix: "test" };

    expect(createSessionStore({ redis })).toBeInstanceOf(RedisSessionStore);
    expect(createCacheStore({ redis })).toBeInstanceOf(RedisCacheStore);
    expect(createInFlightStore({ redis })).toBeInstanceOf(RedisInFlightStore);
    expect(createWebhookEventStore(redis)).toBeInstanceOf(RedisWebhookEventStore);
  });

  it("uses a memory webhook idempotency store when Redis is absent", () => {
    expect(createWebhookEventStore()).toBeInstanceOf(InMemoryWebhookEventStore);
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

    expect(await store.list()).toMatchObject([
      { supportId: expect.stringMatching(/^[a-f0-9]{16}$/u), message: "redacted" }
    ]);
  });

  it("stores only sanitized bounded recent routes through Redis", async () => {
    const redis = new FakeRedisClient();
    const store = createLastRouteStore({
      redis: { client: redis, keyPrefix: "test" },
      maxEntries: 1
    });
    expect(store).toBeInstanceOf(RedisLastRouteStore);

    await store.record({
      requestId: "secret-request-1",
      occurredAt: "2026-07-20T00:00:00.000Z",
      profileName: "helper-private",
      sourceType: "group",
      phase: "function",
      action: "find_ppt_slides",
      query: "present"
    });
    await store.record({
      requestId: "secret-request-2",
      occurredAt: "2026-07-20T00:01:00.000Z",
      profileName: "helper-private",
      sourceType: "group",
      phase: "function",
      action: "query_schedule"
    });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        supportId: expect.stringMatching(/^[a-f0-9]{16}$/u),
        action: "query_schedule"
      })
    ]);
    expect(JSON.stringify([...redis.lists.values()])).not.toMatch(/secret-request|helper-private/u);
    expect(await store.clear()).toBe(1);
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

describe("schedule store", () => {
  it("migrates legacy external ids into indexed external keys", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await runScheduleMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("add column if not exists external_key text");
    expect(sql).toContain("set external_key = external_id");
    expect(sql).toContain("schedule_items_external_key_idx");
    expect(sql).toContain("profile_name, source_key, origin, external_key");
  });

  it("persists and maps derived external keys in Postgres", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          profile_name: "helper",
          source_key: "service_schedule",
          origin: "notion",
          external_id: "page-1",
          external_key: "page-1:0:音控",
          service_date: "2026-07-14",
          meeting: "晨更",
          role: "音控",
          assignee: "資恆",
          notes: null,
          normalized_search_text: "晨更音控資恆",
          external_updated_at: null,
          deleted_at: null
        }
      ]
    });
    const store = new PostgresScheduleStore({ query } as PgQueryable);

    await expect(
      store.upsertItem({
        profileName: "helper",
        sourceKey: "service_schedule",
        origin: "notion",
        externalId: "page-1",
        externalKey: "page-1:0:音控",
        serviceDate: "2026-07-14",
        meeting: "晨更",
        role: "音控",
        assignee: "資恆"
      })
    ).resolves.toMatchObject({ externalId: "page-1", externalKey: "page-1:0:音控" });
    expect(query.mock.calls[0]?.[0]).toContain("external_id, external_key");
    expect(query.mock.calls[0]?.[1]?.[5]).toBe("page-1:0:音控");
  });

  it("tombstones missing external keys in Postgres", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "removed" }] });
    const store = new PostgresScheduleStore({ query } as PgQueryable);

    await expect(
      store.tombstoneMissingExternalKeys({
        profileName: "helper",
        sourceKey: "service_schedule",
        origin: "notion",
        liveExternalKeys: ["page-1:0:音控"],
        deletedAt: "2026-07-13T00:00:00.000Z"
      })
    ).resolves.toBe(1);
    expect(query.mock.calls[0]?.[0]).toContain("external_key is not null");
    expect(query.mock.calls[0]?.[0]).toContain("external_key = any($4::text[])");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "helper",
      "service_schedule",
      "notion",
      ["page-1:0:音控"],
      "2026-07-13T00:00:00.000Z"
    ]);
  });

  it("uses derived external keys for idempotent updates", async () => {
    const store = new InMemoryScheduleStore();
    const base = {
      profileName: "helper",
      sourceKey: "service_schedule",
      origin: "notion" as const,
      externalId: "page-1",
      externalKey: "page-1:0:音控",
      serviceDate: "2026-07-14",
      meeting: "晨更",
      role: "音控"
    };

    const original = await store.upsertItem({ ...base, assignee: "資恆" });
    const updated = await store.upsertItem({ ...base, assignee: "Ray" });

    expect(updated.id).toBe(original.id);
    await expect(
      store.searchItems({ profileName: "helper", query: "音控", limit: 10 })
    ).resolves.toMatchObject([{ id: original.id, assignee: "Ray" }]);
  });

  it("tombstones only missing derived keys in the selected profile and source", async () => {
    const store = new InMemoryScheduleStore();
    const item = (profileName: string, sourceKey: string, externalKey: string, role: string) => ({
      profileName,
      sourceKey,
      origin: "notion" as const,
      externalId: "page-1",
      externalKey,
      serviceDate: "2026-07-14",
      meeting: "晨更",
      role,
      assignee: "同工"
    });
    await store.upsertItem(item("helper", "source-a", "page-1:0:音控", "音控"));
    await store.upsertItem(item("helper", "source-a", "page-1:1:導播", "導播"));
    await store.upsertItem(item("helper", "source-b", "page-1:1:導播", "導播"));
    await store.upsertItem(item("main", "source-a", "page-1:1:導播", "導播"));

    await expect(
      store.tombstoneMissingExternalKeys({
        profileName: "helper",
        sourceKey: "source-a",
        origin: "notion",
        liveExternalKeys: ["page-1:0:音控"],
        deletedAt: "2026-07-13T00:00:00.000Z"
      })
    ).resolves.toBe(1);
    await expect(
      store.searchItems({ profileName: "helper", sourceKeys: ["source-a"], limit: 10 })
    ).resolves.toHaveLength(1);
    await expect(
      store.searchItems({ profileName: "helper", sourceKeys: ["source-b"], limit: 10 })
    ).resolves.toHaveLength(1);
    await expect(
      store.searchItems({ profileName: "main", sourceKeys: ["source-a"], limit: 10 })
    ).resolves.toHaveLength(1);
  });
});
