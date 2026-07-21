import { describe, expect, it } from "vitest";

import {
  InMemoryConfirmationStore,
  RedisConfirmationStore
} from "../actions/confirmation-store.js";

describe("confirmation store", () => {
  it("consumes a confirmation request once for the same admin and profile", async () => {
    const store = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    const request = await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toMatchObject({
      id: request.id,
      action: "invite_code_create"
    });
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
  });

  it("does not consume confirmation requests from another admin or profile", async () => {
    const store = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    await expect(store.consume("CONFIRM1", "Uother", "helper")).resolves.toBeNull();
    await expect(store.consume("CONFIRM1", "Uadmin", "other-profile")).resolves.toBeNull();
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toMatchObject({
      action: "invite_code_create"
    });
  });

  it("expires confirmation requests", async () => {
    let now = new Date("2026-07-07T00:00:00.000Z");
    const store = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => now
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    now = new Date("2026-07-07T00:06:00.000Z");

    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
  });

  it("keeps a Redis confirmation available after a wrong actor attempts consumption", async () => {
    const client = new FakeConfirmationRedisClient();
    const store = new RedisConfirmationStore({
      client,
      keyPrefix: "test",
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    await expect(store.consume("CONFIRM1", "Uother", "helper")).resolves.toBeNull();
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toMatchObject({
      id: "CONFIRM1"
    });
  });

  it("atomically consumes a Redis confirmation once for the correct actor", async () => {
    const client = new FakeConfirmationRedisClient();
    const store = new RedisConfirmationStore({
      client,
      keyPrefix: "test",
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });

    const results = await Promise.all([
      store.consume("CONFIRM1", "Uadmin", "helper"),
      store.consume("CONFIRM1", "Uadmin", "helper")
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not delete malformed or mismatched Redis confirmation payloads", async () => {
    const client = new FakeConfirmationRedisClient();
    const store = new RedisConfirmationStore({
      client,
      keyPrefix: "test",
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5
    });
    const key = client.onlyKey();
    client.setRaw(key, "not-json");
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
    expect(client.has(key)).toBe(true);

    client.setRaw(
      key,
      JSON.stringify({
        id: "CONFIRM1",
        profileName: "other-profile",
        actorUserId: "Uadmin",
        action: "invite_code_create",
        createdAt: "2026-07-07T00:00:00.000Z",
        expiresAt: "2026-07-07T00:05:00.000Z"
      })
    );
    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
    expect(client.has(key)).toBe(true);
  });

  it("rejects an expired Redis confirmation after authorized atomic consumption", async () => {
    const client = new FakeConfirmationRedisClient();
    const store = new RedisConfirmationStore({
      client,
      keyPrefix: "test",
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:06:00.000Z")
    });
    await store.create({
      profileName: "helper",
      actorUserId: "Uadmin",
      action: "invite_code_create",
      ttlMinutes: 5,
      now: new Date("2026-07-07T00:00:00.000Z")
    });

    await expect(store.consume("CONFIRM1", "Uadmin", "helper")).resolves.toBeNull();
    expect(client.size()).toBe(0);
  });
});

class FakeConfirmationRedisClient {
  private readonly values = new Map<string, string>();

  async setEx(key: string, _seconds: number, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<string | null> {
    const [key] = options.keys;
    const [profileName, actorUserId] = options.arguments;
    if (!key) return null;
    const raw = this.values.get(key);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { profileName?: unknown; actorUserId?: unknown };
      if (value.profileName !== profileName || value.actorUserId !== actorUserId) return null;
    } catch {
      return null;
    }
    this.values.delete(key);
    return raw;
  }

  onlyKey(): string {
    return Array.from(this.values.keys())[0]!;
  }

  setRaw(key: string, value: string): void {
    this.values.set(key, value);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  size(): number {
    return this.values.size;
  }
}
