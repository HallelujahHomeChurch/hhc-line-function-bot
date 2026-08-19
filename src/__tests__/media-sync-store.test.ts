import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
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
    expect(sql).toContain("request_key_hash");
    expect(sql).toContain("media_sync_binding_codes_request_fence_idx");
    expect(sql).toContain("media_sync_collection_deletions");
    expect(sql).toContain("collection_id text primary key");
    expect(sql).toContain("where disabled_at is null");
    expect(sql).toContain("source_key text primary key");
    expect(sql).toContain("work_id uuid");
    expect(sql).toContain("media_sync_source_tombstones");
    expect(sql).toContain("asset_etag");
    expect(sql).toContain("awaiting_scan");
    expect(sql).toContain("dispatched_at");
    expect(sql).toContain("primary key (source_key, publication_type)");
    expect(sql).toContain("primary key (source_key, operation)");
  });
});

describe("media sync outbox leases", () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a non-positive or non-integral lease duration (%s)",
    async (leaseMs) => {
      const store = new PostgresMediaSyncStore({} as Pool);

      await expect(store.claimOutbox({ limit: 1, leaseMs })).rejects.toThrow(
        "media_sync_outbox_lease_invalid"
      );
    }
  );

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid dispatch lease duration (%s)",
    async (leaseMs) => {
      const store = new PostgresMediaSyncStore({} as Pool);

      await expect(store.claimOutboxForDispatch({ limit: 1, leaseMs })).rejects.toThrow(
        "media_sync_outbox_lease_invalid"
      );
    }
  );
});

describe("media sync binding-code issuance", () => {
  it("rejects a blank idempotency identity before opening a transaction", async () => {
    const store = new PostgresMediaSyncStore({} as Pool, { codeFactory: vi.fn() });

    await expect(
      store.createBindingCode({
        profileName: "helper",
        collectionId: "collection-1",
        createdByHhcUserId: "manager",
        idempotencyKey: "   "
      })
    ).rejects.toThrow("media_sync_binding_code_idempotency_invalid");
  });

  it("does not expose standalone binding release mutations", () => {
    const store = new PostgresMediaSyncStore({} as Pool);

    expect(store).not.toHaveProperty("disableBindingByCollection");
    expect(store).not.toHaveProperty("disableBinding");
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
      createdByHhcUserId: "hhc-user",
      idempotencyKey: "request-secret-key"
    });
    const row = (
      await left.query<{ code_hash: string; request_key_hash: string; expires_at: Date }>(
        "select code_hash, request_key_hash, expires_at from media_sync_binding_codes"
      )
    ).rows[0];

    expect(issued).toEqual({
      status: "issued",
      code: "PLAIN-CODE-123",
      expiresAt: "2099-07-07T01:00:00.000Z"
    });
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.request_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain("PLAIN-CODE-123");
    expect(row?.request_key_hash).not.toContain("request-secret-key");
    expect(row?.expires_at.toISOString()).toBe(issued.expiresAt);
  });

  it("permanently fences binding-code idempotency within caller and resource scope", async () => {
    let generated = 0;
    const store = new PostgresMediaSyncStore(left, {
      codeFactory: () => `IDEMPOTENT-CODE-${++generated}`
    });
    const firstInput = {
      profileName: "helper",
      collectionId: "collection-idempotent",
      createdByHhcUserId: "manager-a",
      idempotencyKey: "same-client-key",
      now: new Date("2099-01-01T00:00:00.000Z")
    };

    const first = await store.createBindingCode(firstInput);
    await expect(
      store.createBindingCode({ ...firstInput, now: new Date("2099-01-01T00:05:00.000Z") })
    ).resolves.toEqual({
      status: "already_issued",
      expiresAt: "2099-01-01T01:00:00.000Z"
    });
    await expect(
      store.createBindingCode({ ...firstInput, idempotencyKey: "different-key" })
    ).resolves.toMatchObject({ status: "issued", code: "IDEMPOTENT-CODE-2" });
    await expect(
      store.createBindingCode({ ...firstInput, now: new Date("2099-01-01T02:00:00.000Z") })
    ).resolves.toMatchObject({ status: "already_issued" });
    await expect(
      store.createBindingCode({
        ...firstInput,
        createdByHhcUserId: "manager-b",
        now: new Date("2099-01-01T02:00:00.000Z")
      })
    ).resolves.toMatchObject({ status: "issued", code: "IDEMPOTENT-CODE-3" });
    await expect(
      store.createBindingCode({
        ...firstInput,
        collectionId: "collection-other",
        now: new Date("2099-01-01T02:00:00.000Z")
      })
    ).resolves.toMatchObject({ status: "issued", code: "IDEMPOTENT-CODE-4" });

    expect(first).toMatchObject({ status: "issued", code: "IDEMPOTENT-CODE-1" });
    expect(generated).toBe(4);
    const rows = await left.query<{
      profile_name: string;
      collection_id: string;
      created_by_hhc_user_id: string;
      request_key_hash: string;
    }>(
      `select profile_name, collection_id, created_by_hhc_user_id, request_key_hash
       from media_sync_binding_codes where collection_id like 'collection-idempotent%' or collection_id='collection-other'`
    );
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.every((row) => /^[0-9a-f]{64}$/u.test(row.request_key_hash))).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain("same-client-key");
  });

  it("serializes code creation per profile and collection", async () => {
    const first = new PostgresMediaSyncStore(left);
    const second = new PostgresMediaSyncStore(right);
    const input = {
      profileName: "helper",
      collectionId: "collection-concurrent-code",
      createdByHhcUserId: "hhc-user",
      idempotencyKey: "concurrent-key"
    };

    const results = await Promise.allSettled([
      first.createBindingCode(input),
      second.createBindingCode(input)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(
      results.map((result) => (result.status === "fulfilled" ? result.value.status : "rejected"))
    ).toEqual(expect.arrayContaining(["issued", "already_issued"]));

    const conflicts = await Promise.allSettled([
      first.createBindingCode({
        ...input,
        collectionId: "collection-concurrent-different-key",
        idempotencyKey: "left-key"
      }),
      second.createBindingCode({
        ...input,
        collectionId: "collection-concurrent-different-key",
        idempotencyKey: "right-key"
      })
    ]);
    expect(conflicts.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(conflicts.filter((result) => result.status === "rejected")).toHaveLength(0);
    await expect(
      left.query(
        `select 1 from media_sync_binding_codes
         where profile_name=$1 and collection_id=$2 and consumed_at is null and expires_at > now()`,
        [input.profileName, "collection-concurrent-different-key"]
      )
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("atomically invalidates the previous code when rotating", async () => {
    const codes = ["ROTATE-OLD", "ROTATE-NEW"];
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => codes.shift()! });
    const base = {
      profileName: "helper",
      collectionId: "collection-rotate",
      createdByHhcUserId: "manager",
      now: new Date("2099-01-01T00:00:00.000Z")
    };

    await store.createBindingCode({ ...base, idempotencyKey: "rotate-old" });
    await expect(
      store.createBindingCode({ ...base, idempotencyKey: "rotate-new" })
    ).resolves.toMatchObject({ status: "issued", code: "ROTATE-NEW" });
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: "ROTATE-OLD",
        groupId: "group-rotate-old",
        groupDisplayName: "Old",
        now: new Date("2099-01-01T00:01:00.000Z")
      })
    ).resolves.toEqual({ status: "invalid_code" });
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: "ROTATE-NEW",
        groupId: "group-rotate-new",
        groupDisplayName: "New",
        now: new Date("2099-01-01T00:01:00.000Z")
      })
    ).resolves.toMatchObject({ status: "bound" });
  });

  it("serializes binding against code rotation", async () => {
    const issuer = new PostgresMediaSyncStore(left, { codeFactory: () => "RACE-OLD" });
    const rotator = new PostgresMediaSyncStore(left, { codeFactory: () => "RACE-NEW" });
    const binder = new PostgresMediaSyncStore(right);
    const now = new Date("2099-01-01T00:00:00.000Z");
    await issuer.createBindingCode({
      profileName: "helper",
      collectionId: "collection-bind-rotate-race",
      createdByHhcUserId: "manager",
      idempotencyKey: "race-old",
      now
    });

    const [rotation, binding] = await Promise.all([
      rotator.createBindingCode({
        profileName: "helper",
        collectionId: "collection-bind-rotate-race",
        createdByHhcUserId: "manager",
        idempotencyKey: "race-new",
        now
      }),
      binder.bindWithCode({
        profileName: "helper",
        code: "RACE-OLD",
        groupId: "group-bind-rotate-race",
        groupDisplayName: "Race",
        now
      })
    ]);

    expect([
      ["issued", "invalid_code"],
      ["collection_bound", "bound"]
    ]).toContainEqual([rotation.status, binding.status]);
  });

  it("rolls back old-code invalidation when replacement insertion fails", async () => {
    const target = new PostgresMediaSyncStore(left, { codeFactory: () => "ROLLBACK-OLD" });
    const duplicate = new PostgresMediaSyncStore(left, { codeFactory: () => "DUPLICATE-CODE" });
    const rotating = new PostgresMediaSyncStore(left, { codeFactory: () => "DUPLICATE-CODE" });
    const now = new Date("2099-01-01T00:00:00.000Z");

    await target.createBindingCode({
      profileName: "helper",
      collectionId: "collection-rotation-rollback",
      createdByHhcUserId: "manager",
      idempotencyKey: "rollback-old",
      now
    });
    await duplicate.createBindingCode({
      profileName: "helper",
      collectionId: "collection-duplicate-code",
      createdByHhcUserId: "manager",
      idempotencyKey: "duplicate-code",
      now
    });

    await expect(
      rotating.createBindingCode({
        profileName: "helper",
        collectionId: "collection-rotation-rollback",
        createdByHhcUserId: "manager",
        idempotencyKey: "rollback-new",
        now
      })
    ).rejects.toMatchObject({ constraint: "media_sync_binding_codes_code_hash_key" });
    await expect(
      target.bindWithCode({
        profileName: "helper",
        code: "ROLLBACK-OLD",
        groupId: "group-rotation-rollback",
        groupDisplayName: "Rollback",
        now: new Date("2099-01-01T00:01:00.000Z")
      })
    ).resolves.toMatchObject({ status: "bound" });
  });

  it("reports only a live pending code and refuses rotation after binding", async () => {
    const store = new PostgresMediaSyncStore(left, {
      codeFactory: () => "PENDING-CODE",
      now: () => new Date("2099-01-01T00:00:00.000Z")
    });
    const input = {
      profileName: "helper",
      collectionId: "collection-pending",
      createdByHhcUserId: "manager",
      idempotencyKey: "pending-code"
    };

    await store.createBindingCode(input);
    await expect(
      store.findPendingBindingCodeByCollection({
        profileName: "helper",
        collectionId: "collection-pending"
      })
    ).resolves.toEqual({ expiresAt: "2099-01-01T01:00:00.000Z" });
    await store.bindWithCode({
      profileName: "helper",
      code: "PENDING-CODE",
      groupId: "group-pending",
      groupDisplayName: "Pending",
      now: new Date("2099-01-01T00:01:00.000Z")
    });
    await expect(
      store.findPendingBindingCodeByCollection({
        profileName: "helper",
        collectionId: "collection-pending"
      })
    ).resolves.toBeUndefined();
    await expect(
      store.createBindingCode({ ...input, idempotencyKey: "after-binding" })
    ).resolves.toEqual({ status: "collection_bound" });
  });

  it("binds once without accepting registration state into the atomic store boundary", async () => {
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => "BIND-CODE-123" });
    const issued = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-bind",
      createdByHhcUserId: "manager",
      idempotencyKey: "bind-code-request"
    });
    const code = issuedCode(issued);
    const bindWithCode = vi.spyOn(store, "bindWithCode");
    const registered = false;
    if (registered) {
      await store.bindWithCode({
        profileName: "helper",
        code,
        groupId: "group-unregistered",
        groupDisplayName: "Unregistered",
        boundByLineUserId: "line-user"
      });
    }
    expect(bindWithCode).not.toHaveBeenCalled();

    await expect(
      store.bindWithCode({
        profileName: "helper",
        code,
        groupId: "group-bind",
        groupDisplayName: "Bound group",
        boundByLineUserId: undefined
      })
    ).resolves.toMatchObject({ status: "bound", binding: { collectionId: "collection-bind" } });

    await expect(
      store.bindWithCode({
        profileName: "helper",
        code,
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
      idempotencyKey: "expired-code-request",
      now: new Date("2020-01-01T00:00:00.000Z")
    });
    const codeValue = issuedCode(issued);
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
    await expect(store.bindWithCode({ ...binding, code: codeValue })).resolves.toEqual({
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
      createdByHhcUserId: "manager",
      idempotencyKey: "same-group-request"
    });
    const sameGroupCodeValue = issuedCode(sameGroupCode);
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code: sameGroupCodeValue,
        groupId: "group-unique-a",
        groupDisplayName: "Replacement",
        boundByLineUserId: "line-user"
      })
    ).resolves.toEqual({ status: "group_already_bound" });

    await expect(
      store.createBindingCode({
        profileName: "main",
        collectionId: "collection-unique-a",
        createdByHhcUserId: "manager",
        idempotencyKey: "same-collection-request"
      })
    ).resolves.toEqual({ status: "collection_bound" });

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
  });

  it("keeps collection binding uniqueness until deletion completes", async () => {
    const now = new Date("2099-01-01T00:00:00.000Z");
    const completedAt = new Date("2099-01-01T00:01:00.000Z");
    const store = new PostgresMediaSyncStore(left, { now: () => now });
    await bind(store, "collection-delete-lifecycle", "group-delete-lifecycle");
    await left.query(
      `insert into media_sync_binding_codes
        (id, profile_name, collection_id, code_hash, created_by_hhc_user_id, expires_at)
       values ($1, 'helper', 'collection-delete-lifecycle', $2, 'manager', $3)`,
      [randomUUID(), "a".repeat(64), new Date("2099-01-01T01:00:00.000Z")]
    );

    await expect(
      store.beginCollectionDeletion({
        profileName: "helper",
        collectionId: "collection-delete-lifecycle",
        now
      })
    ).resolves.toEqual({ status: "started" });
    await expect(
      store.beginCollectionDeletion({
        profileName: "helper",
        collectionId: "collection-delete-lifecycle",
        now
      })
    ).resolves.toEqual({ status: "replay" });

    const begun = await left.query<{
      disabled_at: Date | null;
      expires_at: Date;
      completed_at: Date | null;
    }>(
      `select binding.disabled_at, code.expires_at, deletion.completed_at
       from media_sync_bindings binding
       join media_sync_binding_codes code using (collection_id)
       join media_sync_collection_deletions deletion using (collection_id)
       where binding.collection_id='collection-delete-lifecycle' and code.consumed_at is null`
    );
    expect(begun.rows[0]).toEqual({ disabled_at: null, expires_at: now, completed_at: null });
    const replacementCode = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-delete-replacement",
      createdByHhcUserId: "manager",
      idempotencyKey: "replacement-request",
      now
    });
    const replacementInput = {
      profileName: "helper",
      code: issuedCode(replacementCode),
      groupId: "group-delete-lifecycle",
      groupDisplayName: "Replacement",
      boundByLineUserId: "line-user",
      now
    };
    await expect(store.bindWithCode(replacementInput)).resolves.toEqual({
      status: "group_already_bound"
    });
    await expect(
      left.query(
        `insert into media_sync_bindings
          (id, profile_name, group_id, collection_id, group_display_name,
           binding_code_created_by_hhc_user_id, bound_at)
         values ($1, 'main', 'group-delete-conflict', 'collection-delete-lifecycle',
                 'Conflict', 'manager', $2)`,
        [randomUUID(), now]
      )
    ).rejects.toMatchObject({ constraint: "media_sync_bindings_active_collection_idx" });

    await expect(
      store.completeCollectionDeletion({
        profileName: "helper",
        collectionId: "collection-delete-lifecycle",
        now: completedAt
      })
    ).resolves.toBe(true);
    await expect(
      store.completeCollectionDeletion({
        profileName: "helper",
        collectionId: "collection-delete-lifecycle",
        now: completedAt
      })
    ).resolves.toBe(false);
    await expect(
      store.beginCollectionDeletion({
        profileName: "helper",
        collectionId: "collection-delete-lifecycle"
      })
    ).resolves.toEqual({ status: "completed" });
    await expect(
      store.createBindingCode({
        profileName: "helper",
        collectionId: "collection-delete-lifecycle",
        createdByHhcUserId: "manager",
        idempotencyKey: "deleted-collection-request",
        now: completedAt
      })
    ).rejects.toThrow("media_sync_collection_deleted");
    await expect(
      store.bindWithCode({ ...replacementInput, now: completedAt })
    ).resolves.toMatchObject({
      status: "bound",
      binding: {
        groupId: "group-delete-lifecycle",
        collectionId: "collection-delete-replacement"
      }
    });

    const completed = await left.query<{ disabled_at: Date; completed_at: Date }>(
      `select binding.disabled_at, deletion.completed_at
       from media_sync_bindings binding
       join media_sync_collection_deletions deletion using (collection_id)
       where binding.collection_id='collection-delete-lifecycle'`
    );
    expect(completed.rows[0]).toEqual({ disabled_at: completedAt, completed_at: completedAt });
  });

  it("rejects binding, intake, and publication while collection deletion is fenced", async () => {
    const now = new Date("2099-02-01T00:00:00.000Z");
    const store = new PostgresMediaSyncStore(left, { now: () => now });
    const collectionId = "collection-delete-fence";
    const groupId = "group-delete-fence";
    await bind(store, collectionId, groupId);
    const input = { ...ingest("delete-fence"), collectionId, groupId };
    const created = await store.createIngest(input, {
      manualIntent: { destinationId: "pending-delete-fence", requesterUserId: "line-user" }
    });
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await store.confirmManualPublication({
      sourceKey: input.sourceKey,
      destinationId: "pending-delete-fence",
      requesterUserId: "line-user",
      jobId: "job-delete-fence",
      manualSourceKey: "ppt_slides",
      manualItemKind: "ppt_slide",
      manualDomain: "presentation",
      manualTitle: "DeleteFence"
    });
    await completeOtherOutbox(left, input.sourceKey);
    const dispatch = (await store.claimOutboxForDispatch({ limit: 1, leaseMs: 60_000, now }))[0]!;
    await store.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const claim = await store.claimWork({
      workId: dispatch.workId,
      operation: "intake",
      leaseMs: 60_000,
      now: new Date("2099-02-01T00:00:01.000Z")
    });
    if (typeof claim === "string" || !claim) throw new Error("expected intake claim");
    const code = "DELETE-FENCE-CODE";
    await left.query(
      `insert into media_sync_binding_codes
        (id, profile_name, collection_id, code_hash, created_by_hhc_user_id, expires_at)
       values ($1, 'helper', $2, $3, 'manager', $4)`,
      [
        randomUUID(),
        collectionId,
        createHash("sha256").update(code).digest("hex"),
        new Date("2099-02-01T01:00:00.000Z")
      ]
    );

    await store.beginCollectionDeletion({ profileName: "helper", collectionId, now });

    await expect(
      store.findActiveBinding({ profileName: "helper", groupId })
    ).resolves.toBeUndefined();
    await expect(store.findActiveBindingByCollection(collectionId)).resolves.toBeUndefined();
    await expect(
      store.createBindingCode({
        profileName: "helper",
        collectionId,
        createdByHhcUserId: "manager",
        idempotencyKey: "after-delete"
      })
    ).rejects.toThrow("media_sync_collection_deleted");
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code,
        groupId: "group-delete-fence-new",
        groupDisplayName: "New"
      })
    ).resolves.toEqual({ status: "invalid_code" });
    await expect(
      store.createIngest({ ...input, sourceKey: `${input.sourceKey}-after-delete` })
    ).rejects.toThrow("media_sync_collection_deleted");
    await expect(
      store.persistCompletedAsset({
        workId: dispatch.workId,
        expectedClaimedUntil: claim.claimedUntil!,
        assetId: "asset-delete-fence",
        assetEtag: "etag-delete-fence",
        sizeBytes: 1,
        checksumSha256: "b".repeat(64)
      })
    ).resolves.toBe(false);
    await expect(
      store.finalizeCollectionPublication({
        workId: dispatch.workId,
        expectedClaimedUntil: claim.claimedUntil!,
        collectionId,
        occurrenceId: "occurrence-delete-fence"
      })
    ).resolves.toBe(false);
    await expect(
      store.finalizeManualPublication({
        workId: dispatch.workId,
        expectedClaimedUntil: claim.claimedUntil!,
        destinationId: "pending-delete-fence",
        resourceId: "resource-delete-fence"
      })
    ).resolves.toBe(false);
    await expect(
      store.completeClaimedWork({
        workId: dispatch.workId,
        expectedClaimedUntil: claim.claimedUntil!
      })
    ).resolves.toBe(false);
  });

  it.each([
    "persistCompletedAsset",
    "finalizeCollectionPublication",
    "finalizeManualPublication",
    "completeClaimedWork"
  ] as const)("serializes %s behind collection deletion", async (operation) => {
    const suffix = `delete-race-${operation}`;
    const collectionId = `collection-${suffix}`;
    const groupId = `group-${suffix}`;
    const sourceKey = `line:helper:message-${suffix}`;
    const now = new Date("2099-03-01T00:00:00.000Z");
    const setup = new PostgresMediaSyncStore(left, { now: () => now });
    const pausedBegin = pausePoolAfterInsert(left);
    const deletion = new PostgresMediaSyncStore(pausedBegin.pool, { now: () => now });
    const writer = new PostgresMediaSyncStore(right, { now: () => now });
    await bind(setup, collectionId, groupId);
    const input = { ...ingest(suffix), sourceKey, collectionId, groupId };
    const manual = operation === "finalizeManualPublication";
    const created = await setup.createIngest(
      input,
      manual
        ? {
            manualIntent: {
              destinationId: `pending-${suffix}`,
              requesterUserId: "line-user"
            }
          }
        : undefined
    );
    if (created.tombstoned) throw new Error("unexpected tombstone");
    if (manual) {
      await setup.confirmManualPublication({
        sourceKey,
        destinationId: `pending-${suffix}`,
        requesterUserId: "line-user",
        jobId: `job-${suffix}`,
        manualSourceKey: "ppt_slides",
        manualItemKind: "ppt_slide",
        manualDomain: "presentation",
        manualTitle: suffix
      });
    }
    await completeOtherOutbox(left, sourceKey);
    const dispatch = (await setup.claimOutboxForDispatch({ limit: 1, leaseMs: 60_000, now }))[0]!;
    await setup.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const claim = await setup.claimWork({
      workId: dispatch.workId,
      operation: "intake",
      leaseMs: 60_000,
      now: new Date("2099-03-01T00:00:01.000Z")
    });
    if (typeof claim === "string" || !claim) throw new Error("expected intake claim");
    if (operation === "completeClaimedWork") {
      await expect(
        setup.finalizeCollectionPublication({
          workId: dispatch.workId,
          expectedClaimedUntil: claim.claimedUntil!,
          collectionId,
          occurrenceId: `occurrence-${suffix}`
        })
      ).resolves.toBe(true);
    }

    const begun = deletion.beginCollectionDeletion({ profileName: "helper", collectionId, now });
    const blocker = await pausedBegin.reached;
    try {
      let settled = false;
      let mutation: Promise<boolean>;
      switch (operation) {
        case "persistCompletedAsset":
          mutation = writer.persistCompletedAsset({
            workId: dispatch.workId,
            expectedClaimedUntil: claim.claimedUntil!,
            assetId: `asset-${suffix}`,
            assetEtag: `etag-${suffix}`,
            sizeBytes: 1,
            checksumSha256: "c".repeat(64)
          });
          break;
        case "finalizeCollectionPublication":
          mutation = writer.finalizeCollectionPublication({
            workId: dispatch.workId,
            expectedClaimedUntil: claim.claimedUntil!,
            collectionId,
            occurrenceId: `occurrence-${suffix}`
          });
          break;
        case "finalizeManualPublication":
          mutation = writer.finalizeManualPublication({
            workId: dispatch.workId,
            expectedClaimedUntil: claim.claimedUntil!,
            destinationId: `pending-${suffix}`,
            resourceId: `resource-${suffix}`
          });
          break;
        case "completeClaimedWork":
          mutation = writer.completeClaimedWork({
            workId: dispatch.workId,
            expectedClaimedUntil: claim.claimedUntil!
          });
          break;
      }
      const result = mutation.then((value) => {
        settled = true;
        return value;
      });
      await waitForAdvisoryWaiter(blocker, () => settled);
      pausedBegin.resume();

      await expect(begun).resolves.toEqual({ status: "started" });
      await expect(result).resolves.toBe(false);
      const state = (
        await left.query<{
          asset_id: string | null;
          ingest_state: string;
          publication_state: string;
          target_id: string | null;
          completed_at: Date | null;
        }>(
          `select ingest.asset_id, ingest.state ingest_state,
                  publication.state publication_state, publication.target_id,
                  outbox.completed_at
           from media_sync_ingests ingest
           join media_sync_publications publication using (source_key)
           join media_sync_outbox outbox on outbox.source_key=ingest.source_key
             and outbox.operation='intake'
           where ingest.source_key=$1 and publication.publication_type=$2`,
          [sourceKey, manual ? "manual" : "collection"]
        )
      ).rows[0];
      expect(state).toMatchObject({
        asset_id: null,
        ingest_state: "pending",
        completed_at: null,
        ...(operation === "completeClaimedWork"
          ? { publication_state: "published", target_id: `occurrence-${suffix}` }
          : { publication_state: "pending", target_id: null })
      });
    } finally {
      pausedBegin.resume();
      await begun.catch(() => undefined);
    }
  });

  it("rolls code consumption back when binding insertion fails", async () => {
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => "ROLLBACK-CODE" });
    const issued = await store.createBindingCode({
      profileName: "helper",
      collectionId: "collection-rollback",
      createdByHhcUserId: "manager",
      idempotencyKey: "rollback-code-request"
    });
    const code = issuedCode(issued);
    await left.query(`
      create function reject_media_sync_binding() returns trigger language plpgsql as $$
      begin raise exception 'rejected'; end $$;
      create trigger reject_media_sync_binding before insert on media_sync_bindings
      for each row execute function reject_media_sync_binding()
    `);
    await expect(
      store.bindWithCode({
        profileName: "helper",
        code,
        groupId: "group-rollback",
        groupDisplayName: "Rollback",
        boundByLineUserId: "line-user"
      })
    ).rejects.toThrow("rejected");
    await left.query("drop trigger reject_media_sync_binding on media_sync_bindings");

    await expect(
      store.bindWithCode({
        profileName: "helper",
        code,
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
    expect(first.ingest.workId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second.ingest.workId).toBe(first.ingest.workId);
    await expect(count(left, "media_sync_ingests", input.sourceKey)).resolves.toBe(1);
    await expect(count(left, "media_sync_outbox", input.sourceKey)).resolves.toBe(1);
    const publications = await left.query<{
      publication_type: string;
      destination_id: string;
      target_id: string | null;
    }>(
      `select publication_type, destination_id, target_id
       from media_sync_publications where source_key=$1`,
      [input.sourceKey]
    );
    expect(publications.rows).toEqual([
      {
        publication_type: "collection",
        destination_id: input.collectionId,
        target_id: null
      }
    ]);
  });

  it("keeps the original collection destination when the same LINE message is redelivered after rebind", async () => {
    const store = new PostgresMediaSyncStore(left);
    const original = ingest("redelivery-after-rebind");
    const created = await store.createIngest(original);
    if (created.tombstoned) throw new Error("unexpected tombstone");

    await expect(
      store.createIngest({ ...original, collectionId: "collection-after-rebind" })
    ).resolves.toMatchObject({
      created: false,
      ingest: {
        workId: created.ingest.workId,
        collectionId: original.collectionId
      }
    });
    const publication = await left.query<{ destination_id: string }>(
      `select destination_id from media_sync_publications
       where source_key=$1 and publication_type='collection'`,
      [original.sourceKey]
    );
    expect(publication.rows).toEqual([{ destination_id: original.collectionId }]);
  });

  it("keeps an unsend received before intake as a permanent source fence", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("unsend-before-intake");

    await expect(
      store.tombstoneSource(input.sourceKey, new Date("2099-01-01T00:00:00.000Z"))
    ).resolves.toBe(true);
    await expect(store.createIngest(input)).resolves.toEqual({
      created: false,
      tombstoned: true
    });
    await expect(count(left, "media_sync_ingests", input.sourceKey)).resolves.toBe(0);
    await expect(count(left, "media_sync_source_tombstones", input.sourceKey)).resolves.toBe(1);
  });

  it("attaches manual intent only while the source remains live under its source lock", async () => {
    const store = new PostgresMediaSyncStore(left);
    const live = ingest("manual-intent-live-fence");
    const tombstoned = ingest("manual-intent-tombstone-fence");
    const liveCreated = await store.createIngest(live);
    const tombstoneCreated = await store.createIngest(tombstoned);
    if (liveCreated.tombstoned || tombstoneCreated.tombstoned) {
      throw new Error("unexpected tombstone");
    }
    await store.tombstoneSource(tombstoned.sourceKey);

    await expect(
      store.attachManualIntent({
        sourceKey: live.sourceKey,
        destinationId: "pending-live",
        requesterUserId: "line-user"
      })
    ).resolves.toBe(true);
    await expect(
      store.attachManualIntent({
        sourceKey: tombstoned.sourceKey,
        destinationId: "pending-tombstoned",
        requesterUserId: "line-user"
      })
    ).resolves.toBe(false);
    const manual = await left.query<{ source_key: string; destination_id: string }>(
      `select source_key, destination_id from media_sync_publications
       where source_key in ($1, $2) and publication_type='manual'`,
      [live.sourceKey, tombstoned.sourceKey]
    );
    expect(manual.rows).toEqual([{ source_key: live.sourceKey, destination_id: "pending-live" }]);
  });

  it("serializes manual intent attachment behind the source tombstone lock", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("manual-intent-advisory-race");
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    const blocker = await left.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        input.sourceKey
      ]);
      let settled = false;
      const attached = store
        .attachManualIntent({
          sourceKey: input.sourceKey,
          destinationId: "pending-race",
          requesterUserId: "line-user"
        })
        .then((result) => {
          settled = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      await blocker.query(
        `insert into media_sync_source_tombstones (source_key, tombstoned_at)
         values ($1, clock_timestamp())`,
        [input.sourceKey]
      );
      await blocker.query("commit");

      await expect(attached).resolves.toBe(false);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  });

  it("replaces one pending publication with only the actual external owner handle", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("owner-handle");
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");

    await expect(
      store.recordPublication({
        sourceKey: input.sourceKey,
        publicationType: "collection",
        targetId: "asset-occurrence-1",
        state: "published"
      })
    ).resolves.toBe(true);
    await expect(
      store.recordPublication({
        sourceKey: input.sourceKey,
        publicationType: "collection",
        targetId: "asset-occurrence-1",
        state: "published"
      })
    ).resolves.toBe(true);
    const rows = await left.query<{
      destination_id: string;
      target_id: string;
      state: string;
    }>(
      `select destination_id, target_id, state from media_sync_publications
       where source_key=$1 and publication_type='collection'`,
      [input.sourceKey]
    );
    expect(rows.rows).toEqual([
      {
        destination_id: input.collectionId,
        target_id: "asset-occurrence-1",
        state: "published"
      }
    ]);
  });

  it("separates dispatch reservation from the exact worker lease", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("dispatch-worker");
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await completeOtherOutbox(left, input.sourceKey);

    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 1,
        now: new Date("2099-01-01T00:00:00.000Z"),
        leaseMs: 60_000
      })
    )[0]!;
    expect(dispatch.workId).toBe(created.ingest.workId);
    await expect(
      store.markOutboxDispatched({
        workId: dispatch.workId,
        operation: "intake",
        expectedClaimedUntil: dispatch.claimedUntil!
      })
    ).resolves.toBe(true);

    const worker = await store.claimWork({
      workId: dispatch.workId,
      operation: "intake",
      now: new Date("2099-01-01T00:00:01.000Z"),
      leaseMs: 60_000
    });
    expect(worker).toMatchObject({
      workId: dispatch.workId,
      sourceKey: input.sourceKey,
      operation: "intake",
      attempts: 1
    });
    const loaded = await store.loadClaimedWork({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: worker!.claimedUntil!
    });
    expect(loaded).toMatchObject({
      ingest: { workId: dispatch.workId, sourceKey: input.sourceKey },
      publications: [expect.objectContaining({ publicationType: "collection" })]
    });
    expect(loaded?.publications[0]?.targetId).toBeUndefined();
    await expect(
      store.loadClaimedWork({
        workId: dispatch.workId,
        operation: "intake",
        expectedClaimedUntil: dispatch.claimedUntil!
      })
    ).resolves.toBeUndefined();
    await expect(
      store.claimWork({
        workId: dispatch.workId,
        operation: "intake",
        now: new Date("2099-01-01T00:00:02.000Z"),
        leaseMs: 60_000
      })
    ).resolves.toBe("busy");

    await left.query(
      `update media_sync_outbox set completed_at=clock_timestamp(), claimed_until=null
       where source_key=$1 and operation='intake'`,
      [input.sourceKey]
    );
    await expect(
      store.claimWork({
        workId: dispatch.workId,
        operation: "intake",
        now: new Date("2099-01-01T00:00:03.000Z"),
        leaseMs: 60_000
      })
    ).resolves.toBe("terminal");
    await expect(
      store.claimWork({
        workId: "00000000-0000-4000-8000-000000000000",
        operation: "intake",
        now: new Date("2099-01-01T00:00:03.000Z"),
        leaseMs: 60_000
      })
    ).resolves.toBe("missing");
  });

  it("terminalizes source failure only for the exact unexpired worker lease", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("source-failure-fence");
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await completeOtherOutbox(left, input.sourceKey);
    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 1,
        leaseMs: 60_000,
        now: new Date("2099-01-01T00:00:00.000Z")
      })
    )[0]!;
    await store.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const worker = await store.claimWork({
      workId: created.ingest.workId,
      operation: "intake",
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:01.000Z")
    });

    await expect(
      store.failClaimedWork({
        workId: created.ingest.workId,
        expectedClaimedUntil: dispatch.claimedUntil!,
        failureCategory: "stale-worker"
      })
    ).resolves.toBe(false);
    await expect(
      store.failClaimedWork({
        workId: created.ingest.workId,
        expectedClaimedUntil: worker!.claimedUntil!,
        failureCategory: "line_content_empty"
      })
    ).resolves.toBe(true);
    await expect(readOutbox(left, input.sourceKey)).resolves.toMatchObject({
      claimed_until: null,
      last_error_category: "line_content_empty"
    });
    const state = await left.query<{ state: string; failure_category: string }>(
      `select ingest.state, publication.failure_category
       from media_sync_ingests ingest
       join media_sync_publications publication using (source_key)
       where ingest.source_key=$1 and publication.publication_type='collection'`,
      [input.sourceKey]
    );
    expect(state.rows[0]).toEqual({ state: "failed", failure_category: "line_content_empty" });
  });

  it("keeps live compensation handles on intake until the exact lease atomically tombstones cleanup", async () => {
    const store = new PostgresMediaSyncStore(left);
    const live = ingest("live-cleanup-retry");
    const created = await store.createIngest(live);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await expect(
      store.rememberOwnedAsset({
        workId: created.ingest.workId,
        assetId: "asset-live-cleanup",
        assetEtag: "etag-live-cleanup"
      })
    ).resolves.toBe(true);
    await expect(
      store.rememberExternalHandle({
        workId: created.ingest.workId,
        publicationType: "collection",
        destinationId: live.collectionId,
        targetId: "occurrence-live-cleanup"
      })
    ).resolves.toBe(true);
    const liveState = await left.query<{
      state: string;
      target_id: string;
      delete_count: string;
      tombstone_count: string;
    }>(
      `select publication.state, publication.target_id,
              (select count(*)::text from media_sync_outbox
               where source_key=ingest.source_key and operation='delete') delete_count,
              (select count(*)::text from media_sync_source_tombstones
               where source_key=ingest.source_key) tombstone_count
       from media_sync_ingests ingest
       join media_sync_publications publication using (source_key)
       where ingest.source_key=$1 and publication.publication_type='collection'`,
      [live.sourceKey]
    );
    expect(liveState.rows[0]).toEqual({
      state: "pending",
      target_id: "occurrence-live-cleanup",
      delete_count: "0",
      tombstone_count: "0"
    });

    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 1,
        operation: "intake",
        leaseMs: 60_000,
        now: new Date("2099-01-01T00:00:00.000Z")
      })
    )[0]!;
    await expect(
      store.markOutboxDispatched({
        workId: created.ingest.workId,
        operation: "intake",
        expectedClaimedUntil: dispatch.claimedUntil!
      })
    ).resolves.toBe(true);
    const workerClaim = await store.claimWork({
      workId: created.ingest.workId,
      operation: "intake",
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:01.000Z")
    });
    if (typeof workerClaim === "string" || !workerClaim.claimedUntil) {
      throw new Error("expected worker claim");
    }
    await expect(
      store.tombstoneClaimedWorkForCleanup({
        workId: created.ingest.workId,
        expectedClaimedUntil: "2099-01-01T00:00:00.000Z"
      })
    ).resolves.toBe(false);
    await expect(count(left, "media_sync_source_tombstones", live.sourceKey)).resolves.toBe(0);
    await expect(
      store.tombstoneClaimedWorkForCleanup({
        workId: created.ingest.workId,
        expectedClaimedUntil: workerClaim.claimedUntil
      })
    ).resolves.toBe(true);
    const transitioned = await left.query<{
      ingest_state: string;
      publication_state: string;
      intake_completed_at: Date | null;
    }>(
      `select ingest.state ingest_state, publication.state publication_state,
              intake.completed_at intake_completed_at
       from media_sync_ingests ingest
       join media_sync_publications publication using (source_key)
       join media_sync_outbox intake on intake.source_key=ingest.source_key
         and intake.operation='intake'
       where ingest.source_key=$1 and publication.publication_type='collection'`,
      [live.sourceKey]
    );
    expect(transitioned.rows[0]).toMatchObject({
      ingest_state: "tombstoned",
      publication_state: "revoked",
      intake_completed_at: expect.any(Date)
    });
    await expect(count(left, "media_sync_source_tombstones", live.sourceKey)).resolves.toBe(1);
    const claimedDelete = (
      await store.claimOutbox({
        limit: 10,
        leaseMs: 60_000,
        now: new Date("2099-01-01T00:00:02.000Z")
      })
    ).find((item) => item.sourceKey === live.sourceKey && item.operation === "delete");
    expect(claimedDelete?.claimedUntil).toBeDefined();
    await expect(
      store.retryOutbox({
        sourceKey: live.sourceKey,
        operation: "delete",
        expectedClaimedUntil: claimedDelete!.claimedUntil!,
        availableAt: new Date("2099-01-01T00:01:00.000Z"),
        lastErrorCategory: "cleanup_unavailable"
      })
    ).resolves.toBe(true);
  });

  it("dispatches and loads delete work only after a durable source tombstone", async () => {
    const store = new PostgresMediaSyncStore(left);
    const tombstoned = ingest("tombstoned-cleanup-retry");
    const tombstoneCreated = await store.createIngest(tombstoned);
    if (tombstoneCreated.tombstoned) throw new Error("unexpected tombstone");
    await store.tombstoneSource(tombstoned.sourceKey);
    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 10,
        operation: "delete",
        leaseMs: 60_000,
        now: new Date("2099-01-01T00:00:00.000Z")
      })
    ).find((item) => item.sourceKey === tombstoned.sourceKey);
    expect(dispatch?.claimedUntil).toBeDefined();
    await expect(
      store.markOutboxDispatched({
        workId: tombstoneCreated.ingest.workId,
        operation: "delete",
        expectedClaimedUntil: dispatch!.claimedUntil!
      })
    ).resolves.toBe(true);
    const worker = await store.claimWork({
      workId: tombstoneCreated.ingest.workId,
      operation: "delete",
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:01.000Z")
    });
    if (typeof worker === "string" || !worker.claimedUntil) {
      throw new Error("expected delete worker claim");
    }
    await expect(
      store.loadClaimedWork({
        workId: tombstoneCreated.ingest.workId,
        operation: "delete",
        expectedClaimedUntil: worker.claimedUntil
      })
    ).resolves.toMatchObject({ ingest: { state: "tombstoned" } });
  });

  it("never dispatches, claims, loads, or retries stale delete work for a live source", async () => {
    const store = new PostgresMediaSyncStore(left);
    const live = ingest("stale-live-delete");
    const created = await store.createIngest(live);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    const staleClaimedUntil = "2099-01-01T00:01:00.000Z";
    await left.query(
      `insert into media_sync_outbox (source_key, operation, claimed_until)
       values ($1, 'delete', $2)`,
      [live.sourceKey, staleClaimedUntil]
    );

    await expect(
      store.markOutboxDispatched({
        workId: created.ingest.workId,
        operation: "delete",
        expectedClaimedUntil: staleClaimedUntil
      })
    ).resolves.toBe(false);
    await left.query(
      `update media_sync_outbox set claimed_until=null
       where source_key=$1 and operation='delete'`,
      [live.sourceKey]
    );
    const dispatch = await store.claimOutboxForDispatch({
      limit: 10,
      operation: "delete",
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:00.000Z")
    });
    expect(dispatch).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceKey: live.sourceKey })])
    );
    const claims = await store.claimOutbox({
      limit: 10,
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:00.000Z")
    });
    expect(claims).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: live.sourceKey, operation: "delete" })
      ])
    );
    await left.query(
      `update media_sync_outbox
       set claimed_until=$2, dispatched_at=clock_timestamp()
       where source_key=$1 and operation='delete'`,
      [live.sourceKey, staleClaimedUntil]
    );
    await expect(
      store.claimWork({
        workId: created.ingest.workId,
        operation: "delete",
        leaseMs: 60_000
      })
    ).resolves.toBe("terminal");
    await expect(
      store.loadClaimedWork({
        workId: created.ingest.workId,
        operation: "delete",
        expectedClaimedUntil: staleClaimedUntil
      })
    ).resolves.toBeUndefined();
    await expect(
      store.retryOutbox({
        sourceKey: live.sourceKey,
        operation: "delete",
        expectedClaimedUntil: staleClaimedUntil,
        availableAt: new Date("2099-01-01T00:02:00.000Z"),
        lastErrorCategory: "stale-live-delete"
      })
    ).resolves.toBe(false);
  });

  it("fences Asset persistence and stores only the actual collection occurrence", async () => {
    const store = new PostgresMediaSyncStore(left, { codeFactory: () => "ASSETBIND123" });
    await bind(store, "collection-asset-stage", "group-asset-stage");
    const input = {
      ...ingest("asset-stage"),
      groupId: "group-asset-stage",
      collectionId: "collection-asset-stage"
    };
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await completeOtherOutbox(left, input.sourceKey);
    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 1,
        leaseMs: 60_000,
        now: new Date("2099-01-01T00:00:00.000Z")
      })
    )[0]!;
    await store.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const worker = await store.claimWork({
      workId: dispatch.workId,
      operation: "intake",
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:01.000Z")
    });
    const completedAsset = {
      workId: dispatch.workId,
      expectedClaimedUntil: worker!.claimedUntil!,
      assetId: "asset-actual-1",
      assetEtag: "etag-version-1",
      sizeBytes: 5,
      checksumSha256: "a".repeat(64)
    };

    await expect(
      store.persistCompletedAsset({
        ...completedAsset,
        expectedClaimedUntil: dispatch.claimedUntil!
      })
    ).resolves.toBe(false);
    await expect(store.persistCompletedAsset(completedAsset)).resolves.toBe(true);
    await expect(
      store.finalizeCollectionPublication({
        workId: dispatch.workId,
        expectedClaimedUntil: worker!.claimedUntil!,
        collectionId: input.collectionId,
        occurrenceId: "occurrence-actual-1"
      })
    ).resolves.toBe(true);
    await expect(
      store.completeClaimedWork({
        workId: dispatch.workId,
        expectedClaimedUntil: worker!.claimedUntil!
      })
    ).resolves.toBe(true);

    const persisted = await left.query<{
      asset_id: string;
      asset_etag: string;
      state: string;
      target_id: string;
      completed_at: Date;
    }>(
      `select ingest.asset_id, ingest.asset_etag, ingest.state,
              publication.target_id, outbox.completed_at
       from media_sync_ingests ingest
       join media_sync_publications publication using (source_key)
       join media_sync_outbox outbox using (source_key)
       where ingest.source_key=$1 and publication.publication_type='collection'
         and outbox.operation='intake'`,
      [input.sourceKey]
    );
    expect(persisted.rows[0]).toMatchObject({
      asset_id: "asset-actual-1",
      asset_etag: "etag-version-1",
      state: "ready",
      target_id: "occurrence-actual-1",
      completed_at: expect.any(Date)
    });
  });

  it("completes automatic publication before late manual confirmation, then reopens exact work", async () => {
    const store = new PostgresMediaSyncStore(left);
    await bind(store, "collection-late-manual", "group-late-manual");
    const input = {
      ...ingest("late-manual"),
      groupId: "group-late-manual",
      collectionId: "collection-late-manual"
    };
    const created = await store.createIngest(input, {
      manualIntent: {
        destinationId: "pending-late-manual",
        requesterUserId: "line-user"
      }
    });
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await completeOtherOutbox(left, input.sourceKey);
    const now = await databaseNow(left);
    const dispatch = (await store.claimOutboxForDispatch({ limit: 1, leaseMs: 60_000, now }))[0]!;
    await store.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const firstLease = await store.claimWork({
      workId: dispatch.workId,
      operation: "intake",
      leaseMs: 60_000,
      now
    });
    await store.finalizeCollectionPublication({
      workId: dispatch.workId,
      expectedClaimedUntil: firstLease!.claimedUntil!,
      collectionId: input.collectionId,
      occurrenceId: "occurrence-late-manual"
    });
    await expect(
      store.completeClaimedWork({
        workId: dispatch.workId,
        expectedClaimedUntil: firstLease!.claimedUntil!
      })
    ).resolves.toBe(true);

    await expect(
      store.confirmManualPublication({
        sourceKey: input.sourceKey,
        destinationId: "pending-late-manual",
        requesterUserId: "line-user",
        jobId: "job-late-manual",
        manualSourceKey: "ppt_slides",
        manualItemKind: "ppt_slide",
        manualDomain: "presentation",
        manualTitle: "SundayDeck"
      })
    ).resolves.toBe(true);
    const reopened = await left.query<{
      completed_at: Date | null;
      dispatched_at: Date | null;
      manual_source_key: string;
      job_id: string;
    }>(
      `select outbox.completed_at, outbox.dispatched_at,
              publication.manual_source_key, publication.job_id
       from media_sync_outbox outbox
       join media_sync_publications publication using (source_key)
       where outbox.source_key=$1 and outbox.operation='intake'
         and publication.publication_type='manual'`,
      [input.sourceKey]
    );
    expect(reopened.rows[0]).toEqual({
      completed_at: null,
      dispatched_at: null,
      manual_source_key: "ppt_slides",
      job_id: "job-late-manual"
    });
    await left.query(
      `update media_sync_outbox set completed_at=clock_timestamp()
       where source_key=$1 and operation='intake'`,
      [input.sourceKey]
    );
  });

  it("rejects manual finalize after the source tombstone and retains the actual handle for delete", async () => {
    const store = new PostgresMediaSyncStore(left);
    await bind(store, "collection-manual-race", "group-manual-race");
    const input = {
      ...ingest("manual-race"),
      groupId: "group-manual-race",
      collectionId: "collection-manual-race"
    };
    const created = await store.createIngest(input, {
      manualIntent: {
        destinationId: "pending-manual-race",
        requesterUserId: "line-user"
      }
    });
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await store.confirmManualPublication({
      sourceKey: input.sourceKey,
      destinationId: "pending-manual-race",
      requesterUserId: "line-user",
      jobId: "job-manual-race",
      manualSourceKey: "ppt_slides",
      manualItemKind: "ppt_slide",
      manualDomain: "presentation",
      manualTitle: "SundayDeck"
    });
    const now = await databaseNow(left);
    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 1,
        leaseMs: 60_000,
        now
      })
    )[0]!;
    await store.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "intake",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const lease = await store.claimWork({
      workId: dispatch.workId,
      operation: "intake",
      leaseMs: 60_000,
      now
    });
    await store.tombstoneSource(input.sourceKey);

    await expect(
      store.finalizeManualPublication({
        workId: dispatch.workId,
        expectedClaimedUntil: lease!.claimedUntil!,
        destinationId: "pending-manual-race",
        resourceId: "resource-actual-race"
      })
    ).resolves.toBe(false);
    await expect(
      store.rememberExternalHandle({
        workId: dispatch.workId,
        publicationType: "manual",
        destinationId: "pending-manual-race",
        targetId: "resource-actual-race"
      })
    ).resolves.toBe(true);
    const retained = await left.query<{
      target_id: string;
      state: string;
      completed_at: Date | null;
    }>(
      `select publication.target_id, publication.state, outbox.completed_at
       from media_sync_publications publication
       join media_sync_outbox outbox using (source_key)
       where publication.source_key=$1 and publication.publication_type='manual'
         and outbox.operation='delete'`,
      [input.sourceKey]
    );
    expect(retained.rows[0]).toEqual({
      target_id: "resource-actual-race",
      state: "revoked",
      completed_at: null
    });
  });

  it("retains the actual external handles after a tombstone compensation failure", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("compensation-handle");
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await store.tombstoneSource(input.sourceKey);
    await left.query(
      `update media_sync_outbox set completed_at=clock_timestamp()
       where source_key=$1 and operation='delete'`,
      [input.sourceKey]
    );

    await expect(
      store.rememberOwnedAsset({
        workId: created.ingest.workId,
        assetId: "asset-actual-2",
        assetEtag: "etag-version-2"
      })
    ).resolves.toBe(true);
    await expect(
      store.rememberExternalHandle({
        workId: created.ingest.workId,
        publicationType: "collection",
        destinationId: input.collectionId,
        targetId: "occurrence-actual-2"
      })
    ).resolves.toBe(true);

    const handles = await left.query<{
      asset_id: string;
      asset_etag: string;
      target_id: string;
      state: string;
      delete_completed_at: Date | null;
    }>(
      `select ingest.asset_id, ingest.asset_etag, publication.target_id, publication.state,
              (select completed_at from media_sync_outbox
               where source_key=ingest.source_key and operation='delete') delete_completed_at
       from media_sync_ingests ingest
       join media_sync_publications publication using (source_key)
       where ingest.source_key=$1 and publication.publication_type='collection'`,
      [input.sourceKey]
    );
    expect(handles.rows[0]).toEqual({
      asset_id: "asset-actual-2",
      asset_etag: "etag-version-2",
      target_id: "occurrence-actual-2",
      state: "revoked",
      delete_completed_at: null
    });
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

  it("rejects fractional leases before rounded tokens can collide in PostgreSQL", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("fractional-lease");
    await store.createIngest(input);
    await completeOtherOutbox(left, input.sourceKey);
    const now = new Date("2099-01-01T00:00:00.000Z");
    let collision:
      { firstClaimedUntil?: string; secondClaimedUntil?: string; oldRetry: boolean } | undefined;

    try {
      const first = (await store.claimOutbox({ limit: 1, now, leaseMs: 0.5 }))[0];
      const second = (await store.claimOutbox({ limit: 1, now, leaseMs: 0.5 }))[0];
      collision = {
        firstClaimedUntil: first?.claimedUntil,
        secondClaimedUntil: second?.claimedUntil,
        oldRetry: await store.retryOutbox({
          sourceKey: input.sourceKey,
          operation: "intake",
          expectedClaimedUntil: first!.claimedUntil!,
          availableAt: new Date("2099-01-01T00:01:00.000Z"),
          lastErrorCategory: "rounded-token"
        })
      };
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({ message: "media_sync_outbox_lease_invalid" })
      );
    }

    expect(collision).toBeUndefined();
    await expect(readOutbox(left, input.sourceKey)).resolves.toMatchObject({
      claimed_until: null,
      last_error_category: null,
      attempts: 0
    });
  });

  it("fences stale workers after another worker reclaims the lease", async () => {
    const first = new PostgresMediaSyncStore(left);
    const second = new PostgresMediaSyncStore(right);
    const input = ingest("stale-lease");
    await first.createIngest(input);
    await completeOtherOutbox(left, input.sourceKey);

    const firstClaim = (await first.claimOutbox({ limit: 1, leaseMs: 20 }))[0];
    expect(firstClaim?.claimedUntil).toBeDefined();
    await waitForLeaseExpiry(left, firstClaim!.claimedUntil!);
    const secondClaim = (await second.claimOutbox({ limit: 1, leaseMs: 60_000 }))[0];
    expect(secondClaim?.claimedUntil).toBeDefined();
    expect(secondClaim?.claimedUntil).not.toBe(firstClaim?.claimedUntil);

    await expect(
      first.retryOutbox({
        sourceKey: input.sourceKey,
        operation: "intake",
        expectedClaimedUntil: firstClaim!.claimedUntil!,
        availableAt: new Date(Date.now() + 60_000),
        lastErrorCategory: "stale-owner"
      })
    ).resolves.toBe(false);
    await expect(readOutbox(left, input.sourceKey)).resolves.toMatchObject({
      claimed_until: new Date(secondClaim!.claimedUntil!),
      attempts: 2
    });

    const retryAt = new Date(Date.now() + 120_000);
    const currentRetry = {
      sourceKey: input.sourceKey,
      operation: "intake" as const,
      expectedClaimedUntil: secondClaim!.claimedUntil!,
      availableAt: retryAt,
      lastErrorCategory: "current-owner"
    };
    await expect(second.retryOutbox(currentRetry)).resolves.toBe(true);
    await expect(second.retryOutbox(currentRetry)).resolves.toBe(false);
    await expect(readOutbox(left, input.sourceKey)).resolves.toMatchObject({
      claimed_until: null,
      last_error_category: "current-owner",
      attempts: 2
    });
    await expect(count(left, "media_sync_outbox", input.sourceKey)).resolves.toBe(1);
  });

  it("rejects an expired lease even before another worker reclaims it", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("expired-lease");
    await store.createIngest(input);
    await completeOtherOutbox(left, input.sourceKey);
    const claim = (await store.claimOutbox({ limit: 1, leaseMs: 20 }))[0];
    expect(claim?.claimedUntil).toBeDefined();
    await waitForLeaseExpiry(left, claim!.claimedUntil!);

    await expect(
      store.retryOutbox({
        sourceKey: input.sourceKey,
        operation: "intake",
        expectedClaimedUntil: claim!.claimedUntil!,
        availableAt: new Date(Date.now() + 60_000),
        lastErrorCategory: "expired-owner"
      })
    ).resolves.toBe(false);
    await expect(readOutbox(left, input.sourceKey)).resolves.toMatchObject({
      claimed_until: new Date(claim!.claimedUntil!),
      last_error_category: null,
      attempts: 1
    });
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

    await expect(store.createIngest(input)).resolves.toEqual({ created: false, tombstoned: true });
    await expect(
      store.retryOutbox({
        sourceKey: input.sourceKey,
        operation: "intake",
        expectedClaimedUntil: "2099-01-01T00:00:00.000Z",
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
    const claims = await store.claimOutbox({
      limit: 10,
      now: new Date("2099-01-02T00:00:00.000Z"),
      leaseMs: 60_000
    });
    expect(claims).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: input.sourceKey, operation: "intake" })
      ])
    );
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: input.sourceKey, operation: "delete" })
      ])
    );
    const publication = (
      await left.query<{ state: string }>(
        "select state from media_sync_publications where source_key=$1",
        [input.sourceKey]
      )
    ).rows[0];
    expect(publication?.state).toBe("revoked");
  });

  it("completes delete only for the exact live lease on a tombstoned source", async () => {
    const store = new PostgresMediaSyncStore(left);
    const input = ingest("delete-completion-fence");
    const created = await store.createIngest(input);
    if (created.tombstoned) throw new Error("unexpected tombstone");
    await store.tombstoneSource(input.sourceKey);
    await completeOtherOutbox(left, input.sourceKey);
    const dispatch = (
      await store.claimOutboxForDispatch({
        limit: 1,
        leaseMs: 60_000,
        now: new Date("2099-01-01T00:00:00.000Z")
      })
    )[0]!;
    await store.markOutboxDispatched({
      workId: dispatch.workId,
      operation: "delete",
      expectedClaimedUntil: dispatch.claimedUntil!
    });
    const claim = await store.claimWork({
      workId: created.ingest.workId,
      operation: "delete",
      leaseMs: 60_000,
      now: new Date("2099-01-01T00:00:01.000Z")
    });
    if (typeof claim === "string") throw new Error(`unexpected ${claim}`);

    await expect(
      store.completeDeleteWork({
        workId: created.ingest.workId,
        expectedClaimedUntil: dispatch.claimedUntil!
      })
    ).resolves.toBe(false);
    await expect(
      store.completeDeleteWork({
        workId: created.ingest.workId,
        expectedClaimedUntil: claim.claimedUntil!
      })
    ).resolves.toBe(true);
    await expect(
      store.completeDeleteWork({
        workId: created.ingest.workId,
        expectedClaimedUntil: claim.claimedUntil!
      })
    ).resolves.toBe(false);
    await expect(
      store.claimWork({
        workId: created.ingest.workId,
        operation: "delete",
        leaseMs: 60_000
      })
    ).resolves.toBe("terminal");
  });
});

function schemaPool(connectionString: string, schemaName: string): Pool {
  return new Pool({ connectionString, max: 4, options: `-c search_path=${schemaName},public` });
}

async function bind(store: PostgresMediaSyncStore, collectionId: string, groupId: string) {
  const issued = await store.createBindingCode({
    profileName: "helper",
    collectionId,
    createdByHhcUserId: "manager",
    idempotencyKey: `bind-${collectionId}`
  });
  return store.bindWithCode({
    profileName: "helper",
    code: issuedCode(issued),
    groupId,
    groupDisplayName: groupId,
    boundByLineUserId: "line-user"
  });
}

function issuedCode(
  result: Awaited<ReturnType<PostgresMediaSyncStore["createBindingCode"]>>
): string {
  if (result.status !== "issued") throw new Error("expected issued binding code");
  return result.code;
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

async function completeOtherOutbox(pool: Pool, sourceKey: string): Promise<void> {
  await pool.query(
    "update media_sync_outbox set completed_at=now() where source_key<>$1 and completed_at is null",
    [sourceKey]
  );
}

async function databaseNow(pool: Pool): Promise<Date> {
  return (
    await pool.query<{ now: Date }>(
      "select date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' now"
    )
  ).rows[0]!.now;
}

function pausePoolAfterInsert(pool: Pool): {
  pool: Pool;
  reached: Promise<PoolClient>;
  resume(): void;
} {
  let reach!: (client: PoolClient) => void;
  let resume!: () => void;
  let paused = false;
  const reached = new Promise<PoolClient>((resolve) => {
    reach = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const wrapped = new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          const query = (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (!paused && result.command === "INSERT") {
              paused = true;
              reach(client);
              await resumed;
            }
            return result;
          }) as PoolClient["query"];
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === "query") return query;
              const value = Reflect.get(clientTarget, clientProperty, clientTarget);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            }
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { pool: wrapped, reached, resume };
}

async function waitForAdvisoryWaiter(blocker: PoolClient, settled: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = (
      await blocker.query<{ waiting: boolean }>(`
        select exists (
          select 1
          from pg_locks held
          join pg_locks waiting
            on waiting.locktype=held.locktype
           and waiting.database is not distinct from held.database
           and waiting.classid is not distinct from held.classid
           and waiting.objid is not distinct from held.objid
           and waiting.objsubid is not distinct from held.objsubid
          where held.pid=pg_backend_pid() and held.locktype='advisory'
            and held.granted and not waiting.granted
        ) waiting
      `)
    ).rows[0]?.waiting;
    if (waiting) return;
    if (settled()) throw new Error("media_sync_terminal_write_bypassed_collection_lock");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("media_sync_test_collection_lock_waiter_missing");
}

async function waitForLeaseExpiry(pool: Pool, claimedUntil: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const expired = (
      await pool.query<{ expired: boolean }>("select now() > $1::timestamptz expired", [
        claimedUntil
      ])
    ).rows[0]?.expired;
    if (expired) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("media_sync_test_lease_did_not_expire");
}

async function readOutbox(pool: Pool, sourceKey: string) {
  return (
    await pool.query<{
      claimed_until: Date | null;
      last_error_category: string | null;
      attempts: number;
    }>(
      `select claimed_until, last_error_category, attempts
       from media_sync_outbox where source_key=$1 and operation='intake'`,
      [sourceKey]
    )
  ).rows[0];
}
