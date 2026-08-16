import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runMediaSyncMigrations } from "../media-sync/migrations.js";
import { PostgresMediaSyncStore } from "../media-sync/store.js";

describe("media sync migrations", () => {
  it("defines active binding uniqueness, canonical work, and skip-locked claims", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runMediaSyncMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("media_sync_bindings_active_group_idx");
    expect(sql).toContain("media_sync_bindings_active_collection_idx");
    expect(sql).toContain("where disabled_at is null");
    expect(sql).toContain("source_key text primary key");
    expect(sql).toContain("primary key (source_key, operation)");
  });
});

const databaseUrl = process.env.KERNEL_POSTGRES_URL?.trim();

describe.runIf(Boolean(databaseUrl))("Postgres media sync store", () => {
  let owner: Pool;
  let left: Pool;
  let right: Pool;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `media_sync_${randomUUID().replaceAll("-", "")}`;
    owner = new Pool({ connectionString: databaseUrl, max: 1 });
    await owner.query(`create schema "${schemaName}"`);
    left = schemaPool(databaseUrl!, schemaName);
    right = schemaPool(databaseUrl!, schemaName);
    await runMediaSyncMigrations(left);
    await runMediaSyncMigrations(left);
  });

  afterAll(async () => {
    await Promise.allSettled([left?.end(), right?.end()]);
    if (owner && schemaName) await owner.query(`drop schema if exists "${schemaName}" cascade`);
    await owner?.end();
  });

  it("stores only a hash and fixes code expiry at 60 minutes", async () => {
    const store = new PostgresMediaSyncStore(left, {
      codeFactory: () => "PLAIN-CODE-123",
      now: () => new Date("2099-07-07T00:00:00.000Z")
    });

    const issued = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-code",
      createdByHhcUserId: "hhc-user"
    });
    const row = (
      await left.query<{ code_hash: string; expires_at: Date }>(
        "select code_hash, expires_at from media_sync_binding_codes"
      )
    ).rows[0];

    expect(issued).toEqual({
      code: "PLAIN-CODE-123",
      expiresAt: "2099-07-07T01:00:00.000Z"
    });
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain(issued.code);
    expect(row?.expires_at.toISOString()).toBe(issued.expiresAt);
  });

  it("serializes code creation per profile and collection", async () => {
    const first = new PostgresMediaSyncStore(left);
    const second = new PostgresMediaSyncStore(right);
    const input = {
      profileName: "helper",
      collectionId: "collection-concurrent-code",
      createdByHhcUserId: "hhc-user"
    };

    const results = await Promise.allSettled([
      first.createBindingCode(input),
      second.createBindingCode(input)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      left.query(
        `select 1 from media_sync_binding_codes
         where profile_name=$1 and collection_id=$2 and consumed_at is null and expires_at > now()`,
        [input.profileName, input.collectionId]
      )
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("binds once without accepting registration state into the atomic store boundary", async () => {
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => "BIND-CODE-123" });
    const issued = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-bind",
      createdByHhcUserId: "manager"
    });
    const bindWithCode = vi.spyOn(store, "bindWithCode");
    const registered = false;
    if (registered) {
      await store.bindWithCode({
        profileName: "helper",
        code: issued.code,
        groupId: "group-unregistered",
        groupDisplayName: "Unregistered",
        boundByLineUserId: "line-user"
      });
    }
    expect(bindWithCode).not.toHaveBeenCalled();

    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: issued.code,
        groupId: "group-bind",
        groupDisplayName: "Bound group",
        boundByLineUserId: undefined
      })
    ).resolves.toMatchObject({ status: "bound", binding: { collectionId: "collection-bind" } });

    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: issued.code,
        groupId: "other-group",
        groupDisplayName: "Other",
        boundByLineUserId: "line-user"
      })
    ).resolves.toEqual({ status: "invalid_code" });
  });

  it("leaves invalid and expired codes unconsumed", async () => {
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => "EXPIRED-CODE-123" });
    const issued = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-expired",
      createdByHhcUserId: "manager",
      now: new Date("2020-01-01T00:00:00.000Z")
    });
    const binding = {
      profileName: "helper",
      groupId: "group-expired",
      groupDisplayName: "Expired",
      boundByLineUserId: "line-user",
      now: new Date("2020-01-01T01:00:00.001Z")
    };

    await expect(store.bindWithCode({ ...binding, code: "WRONG-CODE" })).resolves.toEqual({
      status: "invalid_code"
    });
    await expect(store.bindWithCode({ ...binding, code: issued.code })).resolves.toEqual({
      status: "invalid_code"
    });
    const code = (
      await left.query<{ consumed_at: Date | null }>(
        "select consumed_at from media_sync_binding_codes where collection_id=$1",
        ["collection-expired"]
      )
    ).rows[0];
    expect(code?.consumed_at).toBeNull();
  });

  it("enforces one active group and collection binding without overwriting", async () => {
    const store = new PostgresMediaSyncStore(left);
    await bind(store, "collection-unique-a", "group-unique-a");
    const sameGroupCode = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-unique-b",
      createdByHhcUserId: "manager"
    });
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: sameGroupCode.code,
        groupId: "group-unique-a",
        groupDisplayName: "Replacement",
        boundByLineUserId: "line-user"
      })
    ).resolves.toEqual({ status: "group_already_bound" });

    const sameCollectionCode = await store.createBindingCode({
      profileName: "main",
      collectionId: "collection-unique-a",
      createdByHhcUserId: "manager"
    });
    await expect(
      store.bindWithCode({
        profileName: "main",
        code: sameCollectionCode.code,
        groupId: "group-unique-b",
        groupDisplayName: "Replacement",
        boundByLineUserId: "line-user"
      })
    ).resolves.toEqual({ status: "collection_already_bound" });

    const existing = await store.findActiveBinding({
      profileName: "helper",
      groupId: "group-unique-a"
    });
    expect(existing).toMatchObject({
      collectionId: "collection-unique-a",
      groupDisplayName: "group-unique-a"
    });
    await expect(store.findActiveBindingByCollection("collection-unique-a")).resolves.toMatchObject(
      { groupId: "group-unique-a" }
    );
    await expect(store.disableBindingByCollection("collection-unique-a")).resolves.toBe(true);
    await expect(
      store.bindWithCode({
        profileName: "main",
        code: sameCollectionCode.code,
        groupId: "group-unique-b",
        groupDisplayName: "Rebound",
        boundByLineUserId: "line-user"
      })
    ).resolves.toMatchObject({ status: "bound", binding: { groupId: "group-unique-b" } });
  });

  it("rolls code consumption back when binding insertion fails", async () => {
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => "ROLLBACK-CODE" });
    const issued = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-rollback",
      createdByHhcUserId: "manager"
    });
    await left.query(`
      create function reject_media_sync_binding() returns trigger language plpgsql as $$
      begin raise exception 'rejected'; end $$;
      create trigger reject_media_sync_binding before insert on media_sync_bindings
      for each row execute function reject_media_sync_binding()
    `);
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: issued.code,
        groupId: "group-rollback",
        groupDisplayName: "Rollback",
        boundByLineUserId: "line-user"
      })
    ).rejects.toThrow("rejected");
    await left.query("drop trigger reject_media_sync_binding on media_sync_bindings");

    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: issued.code,
        groupId: "group-rollback",
        groupDisplayName: "Rollback",
        boundByLineUserId: "line-user"
      })
    ).resolves.toMatchObject({ status: "bound" });
  });

  it("reuses one canonical ingest and one work row for duplicate source keys", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("duplicate");
    const [first, second] = await Promise.all([
      store.createIngest(input),
      new PostgresMediaSyncStore(right).createIngest(input)
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.ingest.sourceKey).toBe(input.sourceKey);
    expect(second.ingest.sourceKey).toBe(input.sourceKey);
    await expect(count(left, "media_sync_ingests", input.sourceKey)).resolves.toBe(1);
    await expect(count(left, "media_sync_outbox", input.sourceKey)).resolves.toBe(1);
  });

  it("claims distinct ready work through skip-locked leases", async () => {
    const first = new PostgresMediaSyncStore(left);
    const second = new PostgresMediaSyncStore(right);
    await Promise.all([
      first.createIngest(ingest("claim-a")),
      first.createIngest(ingest("claim-b"))
    ]);

    const [leftClaims, rightClaims] = await Promise.all([
      first.claimOutbox({ limit: 1, now: new Date("2099-01-01T00:00:00.000Z"), leaseMs: 60_000 }),
      second.claimOutbox({ limit: 1, now: new Date("2099-01-01T00:00:00.000Z"), leaseMs: 60_000 })
    ]);

    expect(leftClaims).toHaveLength(1);
    expect(rightClaims).toHaveLength(1);
    expect(leftClaims[0]?.sourceKey).not.toBe(rightClaims[0]?.sourceKey);
  });

  it("keeps tombstones terminal across duplicate enqueue, retry, and publication", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("tombstone");
    await store.createIngest(input);
    await store.recordPublication({
      sourceKey: input.sourceKey,
      publicationType: "collection",
      targetId: input.collectionId,
      state: "published"
    });
    await store.tombstoneSource(input.sourceKey, new Date("2099-01-01T00:00:00.000Z"));

    await expect(store.createIngest(input)).resolves.toMatchObject({
      created: false,
      ingest: { state: "tombstoned" }
    });
    await expect(
      store.retryOutbox({
        sourceKey: input.sourceKey,
        operation: "intake",
        availableAt: new Date("2099-01-01T01:00:00.000Z"),
        lastErrorCategory: "temporary"
      })
    ).resolves.toBe(false);
    await expect(
      store.recordPublication({
        sourceKey: input.sourceKey,
        publicationType: "collection",
        targetId: input.collectionId,
        state: "published"
      })
    ).resolves.toBe(false);
    await expect(
      store.claimOutbox({ limit: 10, now: new Date("2099-01-02T00:00:00.000Z"), leaseMs: 60_000 })
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceKey: input.sourceKey })])
    );
    const publication = (
      await left.query<{ state: string }>(
        "select state from media_sync_publications where source_key=$1",
        [input.sourceKey]
      )
    ).rows[0];
    expect(publication?.state).toBe("revoked");
  });
});

function schemaPool(connectionString: string, schemaName: string): Pool {
  return new Pool({ connectionString, max: 4, options: `-c search_path=${schemaName},public` });
}

async function bind(store: PostgresMediaSyncStore, collectionId: string, groupId: string) {
  const issued = await store.createBindingCode({
    profileName: "helper",
    collectionId,
    createdByHhcUserId: "manager"
  });
  return store.bindWithCode({
    profileName: "helper",
    code: issued.code,
    groupId,
    groupDisplayName: groupId,
    boundByLineUserId: "line-user"
  });
}

function ingest(suffix: string) {
  return {
    sourceKey: `line:helper:message-${suffix}`,
    profileName: "helper",
    messageId: `message-${suffix}`,
    groupId: "bound-group",
    collectionId: "bound-collection",
    displayName: `${suffix}.png`,
    mediaKind: "image" as const,
    expectedMime: "image/png"
  };
}

async function count(pool: Pool, table: string, sourceKey: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*)::text count from ${table} where source_key=$1`,
    [sourceKey]
  );
  return Number(result.rows[0]?.count);
}
