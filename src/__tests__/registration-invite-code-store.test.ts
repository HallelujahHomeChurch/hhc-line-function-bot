import { describe, expect, it } from "vitest";

import {
  InMemoryRegistrationInviteCodeStore,
  RedisRegistrationInviteCodeStore
} from "../access/registration-invite-code-store.js";

class FakeInviteRedisClient {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    this.values.set(key, value);
    this.expirations.set(key, seconds);
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    this.expirations.delete(key);
    return value;
  }
}

describe("registration invite code store", () => {
  it("creates one-time in-memory registration codes", async () => {
    const store = new InMemoryRegistrationInviteCodeStore();
    const invite = await store.create({
      profileName: "helper",
      createdBy: "Uroot",
      ttlMinutes: 60,
      now: new Date("2099-07-07T00:00:00.000Z")
    });

    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{12,}$/);
    expect(invite.expiresAt).toBe("2099-07-07T01:00:00.000Z");
    await expect(store.consume("helper", invite.code)).resolves.toBe(true);
    await expect(store.consume("helper", invite.code)).resolves.toBe(false);
  });

  it("uses Redis TTL and stores only a hashed code key", async () => {
    const client = new FakeInviteRedisClient();
    const store = new RedisRegistrationInviteCodeStore({
      client,
      keyPrefix: "test",
      codeFactory: () => "PLAIN-CODE-123",
      now: () => new Date("2099-07-07T00:00:00.000Z")
    });

    const invite = await store.create({
      profileName: "helper",
      createdBy: "Uroot",
      ttlMinutes: 15
    });

    expect(invite.code).toBe("PLAIN-CODE-123");
    expect(client.expirations.values().next().value).toBe(900);
    const [[key, value]] = Array.from(client.values.entries());
    expect(key).toContain("test:registration-invite:helper:");
    expect(key).not.toContain("PLAIN-CODE-123");
    expect(value).not.toContain("PLAIN-CODE-123");
    await expect(store.consume("helper", "PLAIN-CODE-123")).resolves.toBe(true);
    await expect(store.consume("helper", "PLAIN-CODE-123")).resolves.toBe(false);
  });
});
