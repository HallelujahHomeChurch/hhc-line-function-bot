import { describe, expect, it, vi } from "vitest";

import { RedisCacheStore } from "../cache/redis-cache-store.js";
import { scanKeyBatches } from "../redis-scan.js";
import { RedisSessionStore } from "../state/redis-session-store.js";

describe("bounded Redis enumeration", () => {
  it("escapes literal prefixes, continues empty pages and splits oversized SCAN replies", async () => {
    const scanIterator = vi.fn(async function* () {
      yield [];
      yield Array.from({ length: 205 }, (_, index) => String(index));
    });
    const batches = [];
    for await (const batch of scanKeyBatches({ scanIterator }, "test[1]*?\\:cache:")) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(scanIterator).toHaveBeenCalledWith({
      MATCH: "test\\[1\\]\\*\\?\\\\:cache:*",
      COUNT: 100
    });
  });

  it("counts duplicate SCAN keys once and propagates scan/delete errors", async () => {
    const client = {
      get: vi.fn(),
      setEx: vi.fn(),
      del: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
      async *scanIterator() {
        yield [];
        yield ["test:cache:a"];
        yield ["test:cache:a"];
      }
    };
    const cache = new RedisCacheStore({ client, keyPrefix: "test" });
    expect(await cache.stats()).toEqual({ totalEntries: 1 });
    expect(await cache.deleteByPrefix("a")).toBe(1);
    client.del.mockRejectedValueOnce(new Error("delete_unavailable"));
    await expect(cache.deleteByPrefix("a")).rejects.toThrow("delete_unavailable");
    client.scanIterator = async function* () {
      yield [];
      throw new Error("scan_unavailable");
    };
    await expect(cache.stats()).rejects.toThrow("scan_unavailable");
  });

  it("bounds concurrent session reads and deduplicates keys that expire during enumeration", async () => {
    let active = 0;
    let maximum = 0;
    const client = {
      async get(key: string) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        if (key === "expired") return null;
        return JSON.stringify({
          id: key,
          type: "profile_update",
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      },
      getDel: vi.fn(),
      setEx: vi.fn(),
      del: vi.fn(),
      async *scanIterator() {
        yield Array.from({ length: 205 }, (_, index) => String(index));
        yield ["0", "expired"];
      }
    };
    const sessions = new RedisSessionStore({ client, keyPrefix: "test" });
    expect(await sessions.summary()).toEqual({ total: 205, byType: { profile_update: 205 } });
    expect(maximum).toBe(100);
  });
});
