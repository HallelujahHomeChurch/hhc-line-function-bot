import { describe, expect, it } from "vitest";

import {
  InMemoryFirstSuccessStore,
  RedisFirstSuccessStore,
  type FirstSuccessScope
} from "../observability/first-success-store.js";

const scope: FirstSuccessScope = {
  profileName: "helper",
  sourceType: "group",
  sourceId: "C-private",
  requesterUserId: "U-private"
};

class AtomicRedisClient {
  readonly calls: Array<{
    key: string;
    value: string;
    options: { NX: true; PX: number };
  }> = [];
  private readonly values = new Set<string>();

  async set(key: string, value: string, options: { NX: true; PX: number }): Promise<"OK" | null> {
    this.calls.push({ key, value, options });
    if (this.values.has(key)) return null;
    this.values.add(key);
    return "OK";
  }
}

describe("first success stores", () => {
  it("atomically marks a scope only once in memory", async () => {
    const store = new InMemoryFirstSuccessStore();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.tryMark(scope, 60_000))
    );

    expect(results.filter((result) => result === "first")).toHaveLength(1);
    expect(results.filter((result) => result === "existing")).toHaveLength(7);
  });

  it.each([
    ["profile", { ...scope, profileName: "main" }],
    ["source type", { ...scope, sourceType: "user" as const }],
    ["source id", { ...scope, sourceId: "C-other" }],
    ["requester", { ...scope, requesterUserId: "U-other" }]
  ])("isolates the in-memory marker by %s", async (_dimension, isolatedScope) => {
    const store = new InMemoryFirstSuccessStore();

    await expect(store.tryMark(scope, 60_000)).resolves.toBe("first");
    await expect(store.tryMark(isolatedScope, 60_000)).resolves.toBe("first");
  });

  it("allows a new first success after the in-memory marker expires", async () => {
    let currentTimeMs = Date.parse("2026-07-26T00:00:00.000Z");
    const store = new InMemoryFirstSuccessStore({
      now: () => new Date(currentTimeMs)
    });

    await expect(store.tryMark(scope, 1_000)).resolves.toBe("first");
    currentTimeMs += 999;
    await expect(store.tryMark(scope, 1_000)).resolves.toBe("existing");
    currentTimeMs += 1;
    await expect(store.tryMark(scope, 1_000)).resolves.toBe("first");
  });

  it("uses one atomic Redis SET NX PX command with an opaque bounded key", async () => {
    const client = new AtomicRedisClient();
    const store = new RedisFirstSuccessStore({ client, keyPrefix: "test" });

    await expect(store.tryMark(scope, 31_536_000_000)).resolves.toBe("first");
    await expect(store.tryMark(scope, 31_536_000_000)).resolves.toBe("existing");

    expect(client.calls).toEqual([
      {
        key: expect.stringMatching(/^test:first-success:v1:[a-f0-9]{64}$/u),
        value: "1",
        options: { NX: true, PX: 31_536_000_000 }
      },
      {
        key: expect.stringMatching(/^test:first-success:v1:[a-f0-9]{64}$/u),
        value: "1",
        options: { NX: true, PX: 31_536_000_000 }
      }
    ]);
    expect(client.calls[0]?.key).toBe(client.calls[1]?.key);
    expect(JSON.stringify(client.calls)).not.toMatch(/helper|C-private|U-private/u);
  });
});
