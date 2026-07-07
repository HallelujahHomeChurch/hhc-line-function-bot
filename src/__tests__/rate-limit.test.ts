import { describe, expect, it, vi } from "vitest";

import { createRateLimiter } from "../rate-limit.js";

describe("rate limiter", () => {
  it("uses atomic Redis counters and expires the first hit", async () => {
    const counts = new Map<string, number>();
    const expire = vi.fn().mockResolvedValue(1);
    const client = {
      incr: vi.fn(async (key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
      expire
    };
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 2 },
      redis: { client, keyPrefix: "test" },
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });

    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: false, remaining: 0 });

    expect(client.incr).toHaveBeenCalledTimes(3);
    expect(client.incr).toHaveBeenCalledWith("test:rate-limit:helper:user:U1");
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith("test:rate-limit:helper:user:U1", 60);
  });

  it("keys Redis limits by profile and source", async () => {
    const counts = new Map<string, number>();
    const client = {
      incr: vi.fn(async (key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
      expire: vi.fn().mockResolvedValue(1)
    };
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 1 },
      redis: { client, keyPrefix: "test" }
    });

    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.check({ profileName: "helper", source: { type: "user", userId: "U2" } })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.check({ profileName: "main", source: { type: "user", userId: "U1" } })
    ).resolves.toMatchObject({ allowed: true });
  });
});
