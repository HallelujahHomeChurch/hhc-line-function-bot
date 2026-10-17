import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../rate-limit.js";

const input = (userId = "U1", groupId = "C1") => ({
  profileName: "helper",
  source: { type: "group", userId, groupId }
});

describe("rate limiter", () => {
  it("isolates requesters and claims one warning per window", async () => {
    let now = new Date("2026-07-07T00:00:00Z");
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 2 },
      now: () => now
    });
    expect((await limiter.check(input())).allowed).toBe(true);
    expect((await limiter.check(input())).allowed).toBe(true);
    expect(await limiter.check(input())).toMatchObject({ allowed: false, shouldNotify: true });
    expect(await limiter.check(input())).toMatchObject({ allowed: false, shouldNotify: false });
    expect((await limiter.check(input("U2"))).allowed).toBe(true);
    expect((await limiter.check(input("U1", "C2"))).allowed).toBe(true);
    now = new Date(now.getTime() + 60_000);
    expect((await limiter.check(input())).allowed).toBe(true);
    await limiter.check(input());
    expect((await limiter.check(input())).shouldNotify).toBe(true);
  });

  it("bounds group resources with one group warning across requesters", async () => {
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 2, groupMaxRequests: 2 }
    });
    await limiter.check(input());
    await limiter.check(input());
    expect(await limiter.check(input("U2"))).toMatchObject({ allowed: false, shouldNotify: true });
    expect(await limiter.check(input("U3"))).toMatchObject({ allowed: false, shouldNotify: false });
  });

  it("does not let an exhausted requester consume additional group capacity", async () => {
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 1, groupMaxRequests: 2 }
    });
    await limiter.check(input());
    for (let i = 0; i < 60; i++) await limiter.check(input());
    expect((await limiter.check(input("U2"))).allowed).toBe(true);
  });

  it("does not admit an unidentified requester", async () => {
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 2 }
    });
    expect(await limiter.check({ profileName: "helper", source: { type: "user" } })).toMatchObject({
      allowed: false,
      shouldNotify: false
    });
  });

  it("uses the atomic result TTL and keeps the existing group resource key", async () => {
    const client = { eval: vi.fn().mockResolvedValue([0, 0, 12_345, 1]) };
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 20 },
      redis: { client, keyPrefix: "test" },
      now: () => new Date("2026-07-07T00:00:00Z")
    });
    expect(await limiter.check(input())).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: "2026-07-07T00:00:12.345Z",
      shouldNotify: true
    });
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ["test:rate-limit:helper:group:C1:requester:U1", "test:rate-limit:helper:group:C1"],
      arguments: ["60000", "20", "100"]
    });
  });

  it("rejects malformed Redis results", async () => {
    const limiter = createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 20 },
      redis: { client: { eval: vi.fn().mockResolvedValue(null) }, keyPrefix: "test" }
    });
    await expect(limiter.check(input())).rejects.toThrow("Invalid rate limit result");
  });
});
