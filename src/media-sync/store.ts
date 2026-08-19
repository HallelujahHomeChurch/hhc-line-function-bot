import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { generateInviteCode } from "../access/registration-invite-code-store.js";
import type {
  BeginCollectionDeletionResult,
  BindMediaSyncCodeInput,
  BindMediaSyncCodeResult,
  CreateMediaSyncBindingCodeInput,
  CreateMediaSyncBindingCodeResult,
  CreateMediaSyncIngestInput,
  MediaSyncBinding,
  MediaSyncIngest,
  MediaSyncOutboxItem,
  MediaSyncOutboxOperation,
  MediaSyncPublication,
  MediaSyncPublicationState,
  MediaSyncPublicationType,
  MediaSyncWork,
  MediaSyncWorkClaim
} from "./types.js";

type StoreOptions = {
  codeFactory?: () => string;
  now?: () => Date;
};

type BindingRow = {
  id: string;
  profile_name: string;
  group_id: string;
  collection_id: string;
  group_display_name: string;
  bound_by_line_user_id: string | null;
  binding_code_created_by_hhc_user_id: string;
  bound_at: Date | string;
  disabled_at: Date | string | null;
};

type BindingCodeRow = {
  id: string;
  collection_id: string;
  created_by_hhc_user_id: string;
};

type IngestRow = {
  source_key: string;
  work_id: string;
  profile_name: string;
  message_id: string;
  group_id: string;
  collection_id: string;
  asset_id: string | null;
  asset_etag: string | null;
  state: MediaSyncIngest["state"];
  display_name: string;
  media_kind: MediaSyncIngest["mediaKind"];
  expected_mime: string;
  size_bytes: string | number | null;
  checksum_sha256: string | null;
  tombstoned_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type OutboxRow = {
  work_id: string;
  source_key: string;
  operation: MediaSyncOutboxOperation;
  attempts: number;
  available_at: Date | string;
  claimed_until: Date | string | null;
  dispatched_at: Date | string | null;
  completed_at: Date | string | null;
  last_error_category: string | null;
};

type PublicationRow = {
  source_key: string;
  publication_type: MediaSyncPublication["publicationType"];
  destination_id: string;
  target_id: string | null;
  state: MediaSyncPublication["state"];
  failure_category: string | null;
  requester_user_id: string | null;
  job_id: string | null;
  manual_source_key: string | null;
  manual_item_kind: string | null;
  manual_domain: string | null;
  manual_title: string | null;
};

export class PostgresMediaSyncStore {
  private readonly codeFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: StoreOptions = {}
  ) {
    this.codeFactory = options.codeFactory ?? generateInviteCode;
    this.now = options.now ?? (() => new Date());
  }

  async createBindingCode(
    input: CreateMediaSyncBindingCodeInput
  ): Promise<CreateMediaSyncBindingCodeResult> {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error("media_sync_binding_code_idempotency_invalid");
    const requestKeyHash = hashRequestIdentity(input, idempotencyKey);
    const client = await this.pool.connect();
    const now = input.now ?? this.now();
    try {
      await client.query("begin");
      await lockBindingCollection(client, input.profileName, input.collectionId);
      if (await collectionDeletionExists(client, input.collectionId)) {
        throw new Error("media_sync_collection_deleted");
      }
      const prior = await client.query<{ expires_at: Date | string }>(
        `select expires_at from media_sync_binding_codes
         where created_by_hhc_user_id=$1 and profile_name=$2 and collection_id=$3
           and request_key_hash=$4
         limit 1`,
        [input.createdByHhcUserId, input.profileName, input.collectionId, requestKeyHash]
      );
      if (prior.rowCount) {
        await client.query("commit");
        return { status: "already_issued", expiresAt: timestamp(prior.rows[0]!.expires_at) };
      }
      const binding = await client.query(
        `select 1 from media_sync_bindings
         where collection_id=$1 and disabled_at is null
         limit 1`,
        [input.collectionId]
      );
      if (binding.rowCount) {
        await client.query("commit");
        return { status: "collection_bound" };
      }
      await client.query(
        `update media_sync_binding_codes
         set expires_at=$3
         where profile_name=$1 and collection_id=$2
           and consumed_at is null and expires_at > $3`,
        [input.profileName, input.collectionId, now]
      );
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      const code = this.codeFactory();
      await client.query(
        `insert into media_sync_binding_codes
          (id, profile_name, collection_id, code_hash, created_by_hhc_user_id, expires_at,
           request_key_hash)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          input.profileName,
          input.collectionId,
          hashCode(code),
          input.createdByHhcUserId,
          expiresAt,
          requestKeyHash
        ]
      );
      await client.query("commit");
      return { status: "issued", code, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async bindWithCode(input: BindMediaSyncCodeInput): Promise<BindMediaSyncCodeResult> {
    const client = await this.pool.connect();
    const now = input.now ?? this.now();
    try {
      await client.query("begin");
      const candidate = await client.query<BindingCodeRow>(
        `select id, collection_id, created_by_hhc_user_id
         from media_sync_binding_codes
         where profile_name=$1 and code_hash=$2
           and consumed_at is null and expires_at > $3
           and not exists (
             select 1 from media_sync_collection_deletions deletion
             where deletion.collection_id=media_sync_binding_codes.collection_id
           )
         limit 1`,
        [input.profileName, hashCode(input.code), now]
      );
      const candidateRow = candidate.rows[0];
      if (!candidateRow) {
        await client.query("rollback");
        return { status: "invalid_code" };
      }
      await lockBindingCollection(client, input.profileName, candidateRow.collection_id);
      const code = await client.query<BindingCodeRow>(
        `select id, collection_id, created_by_hhc_user_id
         from media_sync_binding_codes
         where id=$1 and profile_name=$2 and code_hash=$3
           and consumed_at is null and expires_at > $4
           and not exists (
             select 1 from media_sync_collection_deletions deletion
             where deletion.collection_id=media_sync_binding_codes.collection_id
           )
         for update`,
        [candidateRow.id, input.profileName, hashCode(input.code), now]
      );
      const codeRow = code.rows[0];
      if (!codeRow) {
        await client.query("rollback");
        return { status: "invalid_code" };
      }
      const groupBinding = await client.query(
        `select 1 from media_sync_bindings
         where profile_name=$1 and group_id=$2 and disabled_at is null
         limit 1`,
        [input.profileName, input.groupId]
      );
      if (groupBinding.rowCount) {
        await client.query("rollback");
        return { status: "group_already_bound" };
      }
      const collectionBinding = await client.query(
        `select 1 from media_sync_bindings
         where collection_id=$1 and disabled_at is null
         limit 1`,
        [codeRow.collection_id]
      );
      if (collectionBinding.rowCount) {
        await client.query("rollback");
        return { status: "collection_already_bound" };
      }
      const binding = await client.query<BindingRow>(
        `insert into media_sync_bindings
          (id, profile_name, group_id, collection_id, group_display_name,
           bound_by_line_user_id, binding_code_created_by_hhc_user_id, bound_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning *`,
        [
          randomUUID(),
          input.profileName,
          input.groupId,
          codeRow.collection_id,
          input.groupDisplayName,
          input.boundByLineUserId ?? null,
          codeRow.created_by_hhc_user_id,
          now
        ]
      );
      await client.query(
        `update media_sync_binding_codes
         set consumed_at=$2, consumed_group_id=$3
         where id=$1`,
        [codeRow.id, now, input.groupId]
      );
      await client.query("commit");
      return { status: "bound", binding: mapBinding(binding.rows[0]!) };
    } catch (error) {
      await rollback(client);
      const constraint = postgresConstraint(error);
      if (constraint === "media_sync_bindings_active_group_idx") {
        return { status: "group_already_bound" };
      }
      if (constraint === "media_sync_bindings_active_collection_idx") {
        return { status: "collection_already_bound" };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findActiveBinding(input: {
    profileName: string;
    groupId: string;
  }): Promise<MediaSyncBinding | undefined> {
    const result = await this.pool.query<BindingRow>(
      `select * from media_sync_bindings
       where profile_name=$1 and group_id=$2 and disabled_at is null
         and not exists (
           select 1 from media_sync_collection_deletions deletion
           where deletion.collection_id=media_sync_bindings.collection_id
         )`,
      [input.profileName, input.groupId]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }

  async findActiveBindingByCollection(collectionId: string): Promise<MediaSyncBinding | undefined> {
    const result = await this.pool.query<BindingRow>(
      `select * from media_sync_bindings
       where collection_id=$1 and disabled_at is null
         and not exists (
           select 1 from media_sync_collection_deletions deletion
           where deletion.collection_id=media_sync_bindings.collection_id
         )`,
      [collectionId]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }

  async findPendingBindingCodeByCollection(input: {
    profileName: string;
    collectionId: string;
  }): Promise<{ expiresAt: string } | undefined> {
    const result = await this.pool.query<{ expires_at: Date | string }>(
      `select expires_at from media_sync_binding_codes
       where profile_name=$1 and collection_id=$2
         and consumed_at is null and expires_at > $3
         and not exists (
           select 1 from media_sync_collection_deletions deletion
           where deletion.collection_id=media_sync_binding_codes.collection_id
         )
       order by expires_at desc
       limit 1`,
      [input.profileName, input.collectionId, this.now()]
    );
    return result.rows[0] ? { expiresAt: timestamp(result.rows[0].expires_at) } : undefined;
  }

  async disableBindingByCollection(
    collectionId: string,
    disabledAt: Date = this.now()
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update media_sync_bindings set disabled_at=$2
       where collection_id=$1 and disabled_at is null`,
      [collectionId, disabledAt]
    );
    return Boolean(result.rowCount);
  }

  async disableBinding(
    input: { profileName: string; groupId: string },
    disabledAt: Date = this.now()
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update media_sync_bindings set disabled_at=$3
       where profile_name=$1 and group_id=$2 and disabled_at is null`,
      [input.profileName, input.groupId, disabledAt]
    );
    return Boolean(result.rowCount);
  }

  async beginCollectionDeletion(input: {
    profileName: string;
    collectionId: string;
    now?: Date;
  }): Promise<BeginCollectionDeletionResult> {
    const client = await this.pool.connect();
    const now = input.now ?? this.now();
    try {
      await client.query("begin");
      await lockBindingCollection(client, input.profileName, input.collectionId);
      const inserted = await client.query(
        `insert into media_sync_collection_deletions
          (collection_id, profile_name, started_at)
         values ($1, $2, $3)
         on conflict (collection_id) do nothing
         returning collection_id`,
        [input.collectionId, input.profileName, now]
      );
      const existing = inserted.rowCount
        ? undefined
        : (
            await client.query<{ completed_at: Date | string | null }>(
              `select completed_at from media_sync_collection_deletions
               where collection_id=$1`,
              [input.collectionId]
            )
          ).rows[0];
      await client.query(
        `update media_sync_binding_codes set expires_at=$2
         where collection_id=$1 and consumed_at is null and expires_at > $2`,
        [input.collectionId, now]
      );
      await client.query("commit");
      return {
        status: inserted.rowCount ? "started" : existing?.completed_at ? "completed" : "replay"
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeCollectionDeletion(input: {
    profileName: string;
    collectionId: string;
    now?: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    const now = input.now ?? this.now();
    try {
      await client.query("begin");
      await lockBindingCollection(client, input.profileName, input.collectionId);
      const completed = await client.query(
        `update media_sync_collection_deletions set completed_at=$2
         where collection_id=$1 and completed_at is null`,
        [input.collectionId, now]
      );
      if (!completed.rowCount) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `update media_sync_bindings set disabled_at=$2
         where collection_id=$1 and disabled_at is null`,
        [input.collectionId, now]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createIngest(
    input: CreateMediaSyncIngestInput,
    options: {
      manualIntent?: { destinationId: string; requesterUserId: string };
    } = {}
  ): Promise<
    | { ingest: MediaSyncIngest; created: boolean; tombstoned?: false }
    | { created: false; tombstoned: true }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockSource(client, input.sourceKey);
      await lockBindingCollection(client, input.profileName, input.collectionId);
      if (await collectionDeletionExists(client, input.collectionId)) {
        throw new Error("media_sync_collection_deleted");
      }
      const tombstone = await client.query(
        "select 1 from media_sync_source_tombstones where source_key=$1",
        [input.sourceKey]
      );
      if (tombstone.rowCount) {
        await client.query("commit");
        return { created: false, tombstoned: true };
      }
      const inserted = await client.query<IngestRow>(
        `insert into media_sync_ingests
          (source_key, profile_name, message_id, group_id, collection_id, state,
           display_name, media_kind, expected_mime, size_bytes, checksum_sha256)
         values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
         on conflict (source_key) do nothing
         returning *`,
        [
          input.sourceKey,
          input.profileName,
          input.messageId,
          input.groupId,
          input.collectionId,
          input.displayName,
          input.mediaKind,
          input.expectedMime,
          input.sizeBytes ?? null,
          input.checksumSha256 ?? null
        ]
      );
      const created = Boolean(inserted.rows[0]);
      const ingest =
        inserted.rows[0] ??
        (
          await client.query<IngestRow>(
            "select * from media_sync_ingests where source_key=$1 for update",
            [input.sourceKey]
          )
        ).rows[0];
      if (!ingest) throw new Error("media_sync_ingest_missing");
      if (ingest.state === "tombstoned") {
        await client.query("commit");
        return { created: false, tombstoned: true };
      }
      assertSameIngest(ingest, input);
      await client.query(
        `insert into media_sync_publications
          (source_key, publication_type, destination_id, target_id, state)
         values ($1, 'collection', $2, null, 'pending')
         on conflict (source_key, publication_type) do nothing`,
        [input.sourceKey, input.collectionId]
      );
      if (options.manualIntent) {
        await client.query(
          `insert into media_sync_publications
            (source_key, publication_type, destination_id, target_id, state,
             requester_user_id)
           values ($1, 'manual', $2, null, 'pending', $3)
           on conflict (source_key, publication_type) do nothing`,
          [
            input.sourceKey,
            options.manualIntent.destinationId,
            options.manualIntent.requesterUserId
          ]
        );
      }
      await client.query(
        `insert into media_sync_outbox (source_key, operation)
         values ($1, 'intake')
         on conflict (source_key, operation) do nothing`,
        [input.sourceKey]
      );
      await client.query("commit");
      return { ingest: mapIngest(ingest), created };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async attachManualIntent(input: {
    sourceKey: string;
    destinationId: string;
    requesterUserId: string;
  }): Promise<boolean> {
    return this.withLockedIngest(input.sourceKey, async (client, ingest) => {
      if (!ingest || ingest.state === "tombstoned") return false;
      if (
        (
          await client.query("select 1 from media_sync_source_tombstones where source_key=$1", [
            input.sourceKey
          ])
        ).rowCount
      ) {
        return false;
      }
      await client.query(
        `insert into media_sync_publications
          (source_key, publication_type, destination_id, target_id, state, requester_user_id)
         values ($1, 'manual', $2, null, 'pending', $3)
         on conflict (source_key, publication_type) do nothing`,
        [input.sourceKey, input.destinationId, input.requesterUserId]
      );
      return true;
    });
  }

  async claimOutbox(input: {
    limit: number;
    now?: Date;
    leaseMs: number;
  }): Promise<MediaSyncOutboxItem[]> {
    assertLease(input.leaseMs);
    const now = input.now ?? this.now();
    const claimedUntil = new Date(now.getTime() + input.leaseMs);
    const result = await this.pool.query<OutboxRow>(
      `with claimable as (
         select outbox.source_key, outbox.operation
         from media_sync_outbox outbox
         join media_sync_ingests ingest on ingest.source_key=outbox.source_key
         where outbox.completed_at is null
           and outbox.available_at <= $1
           and (outbox.claimed_until is null or outbox.claimed_until <= $1)
           and (
             (outbox.operation='intake' and ingest.state<>'tombstoned')
             or (outbox.operation='delete' and exists (
               select 1 from media_sync_source_tombstones tombstone
               where tombstone.source_key=outbox.source_key
             ))
           )
         order by outbox.available_at, outbox.source_key, outbox.operation
         for update of outbox skip locked
         limit $2
       )
       update media_sync_outbox outbox
       set attempts=outbox.attempts + 1, claimed_until=$3, last_error_category=null
       from claimable
       where outbox.source_key=claimable.source_key and outbox.operation=claimable.operation
       returning outbox.*,
         (select work_id from media_sync_ingests where source_key=outbox.source_key) work_id`,
      [now, Math.max(0, Math.trunc(input.limit)), claimedUntil]
    );
    return result.rows.map(mapOutbox);
  }

  async claimOutboxForDispatch(input: {
    limit: number;
    operation?: MediaSyncOutboxOperation;
    now?: Date;
    leaseMs: number;
  }): Promise<MediaSyncOutboxItem[]> {
    assertLease(input.leaseMs);
    const now = input.now ?? this.now();
    const claimedUntil = new Date(now.getTime() + input.leaseMs);
    const result = await this.pool.query<OutboxRow>(
      `with claimable as (
         select outbox.source_key, outbox.operation
         from media_sync_outbox outbox
         join media_sync_ingests ingest on ingest.source_key=outbox.source_key
         where outbox.completed_at is null and outbox.dispatched_at is null
           and ($3::text is null or outbox.operation=$3)
           and outbox.available_at <= $1
           and (outbox.claimed_until is null or outbox.claimed_until <= $1)
           and (
             (outbox.operation='intake' and ingest.state<>'tombstoned')
             or (outbox.operation='delete' and exists (
               select 1 from media_sync_source_tombstones tombstone
               where tombstone.source_key=outbox.source_key
             ))
           )
         order by outbox.available_at, outbox.source_key, outbox.operation
         for update of outbox skip locked
         limit $2
       )
       update media_sync_outbox outbox set claimed_until=$4
       from claimable
       where outbox.source_key=claimable.source_key and outbox.operation=claimable.operation
       returning outbox.*,
         (select work_id from media_sync_ingests where source_key=outbox.source_key) work_id`,
      [now, Math.max(0, Math.trunc(input.limit)), input.operation ?? null, claimedUntil]
    );
    return result.rows.map(mapOutbox);
  }

  async markOutboxDispatched(input: {
    workId: string;
    operation: MediaSyncOutboxOperation;
    expectedClaimedUntil: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `update media_sync_outbox outbox
       set dispatched_at=clock_timestamp(), claimed_until=null
       from media_sync_ingests ingest
       where ingest.source_key=outbox.source_key and ingest.work_id=$1
         and outbox.operation=$2 and outbox.completed_at is null
         and outbox.claimed_until=$3::timestamptz
         and outbox.claimed_until > clock_timestamp()
         and ($2<>'delete' or exists (
           select 1 from media_sync_source_tombstones tombstone
           where tombstone.source_key=outbox.source_key
         ))`,
      [input.workId, input.operation, input.expectedClaimedUntil]
    );
    return Boolean(result.rowCount);
  }

  async claimWork(input: {
    workId: string;
    operation: MediaSyncOutboxOperation;
    now?: Date;
    leaseMs: number;
  }): Promise<MediaSyncWorkClaim> {
    assertLease(input.leaseMs);
    const now = input.now ?? this.now();
    const claimedUntil = new Date(now.getTime() + input.leaseMs);
    const result = await this.pool.query<OutboxRow>(
      `update media_sync_outbox outbox
       set attempts=attempts+1, claimed_until=$4, last_error_category=null
       from media_sync_ingests ingest
       where ingest.source_key=outbox.source_key and ingest.work_id=$1
         and outbox.operation=$2 and outbox.completed_at is null
         and outbox.dispatched_at is not null
         and (outbox.claimed_until is null or outbox.claimed_until <= $3)
         and (
           (outbox.operation='intake' and ingest.state<>'tombstoned')
           or (outbox.operation='delete' and exists (
             select 1 from media_sync_source_tombstones tombstone
             where tombstone.source_key=outbox.source_key
           ))
         )
       returning outbox.*, ingest.work_id`,
      [input.workId, input.operation, now, claimedUntil]
    );
    if (result.rows[0]) return mapOutbox(result.rows[0]);
    const disposition = await this.pool.query<{
      state: MediaSyncIngest["state"];
      operation: MediaSyncOutboxOperation | null;
      completed_at: Date | string | null;
      tombstoned: boolean;
    }>(
      `select ingest.state, outbox.operation, outbox.completed_at,
              exists (
                select 1 from media_sync_source_tombstones tombstone
                where tombstone.source_key=ingest.source_key
              ) tombstoned
       from media_sync_ingests ingest
       left join media_sync_outbox outbox
         on outbox.source_key=ingest.source_key and outbox.operation=$2
       where ingest.work_id=$1`,
      [input.workId, input.operation]
    );
    const existing = disposition.rows[0];
    if (!existing || !existing.operation) return "missing";
    if (
      existing.completed_at ||
      (input.operation === "intake" &&
        (existing.state === "ready" ||
          existing.state === "failed" ||
          existing.state === "tombstoned")) ||
      (input.operation === "delete" && !existing.tombstoned)
    ) {
      return "terminal";
    }
    return "busy";
  }

  async loadClaimedWork(input: {
    workId: string;
    operation: MediaSyncOutboxOperation;
    expectedClaimedUntil: string;
  }): Promise<MediaSyncWork | undefined> {
    const ingest = await this.pool.query<IngestRow>(
      `select ingest.*
       from media_sync_ingests ingest
       join media_sync_outbox outbox on outbox.source_key=ingest.source_key
       where ingest.work_id=$1 and outbox.operation=$2
         and outbox.completed_at is null
         and outbox.claimed_until=$3::timestamptz
         and outbox.claimed_until > clock_timestamp()
         and (
           (outbox.operation='intake' and ingest.state<>'tombstoned')
           or (outbox.operation='delete' and exists (
             select 1 from media_sync_source_tombstones tombstone
             where tombstone.source_key=outbox.source_key
           ))
         )`,
      [input.workId, input.operation, input.expectedClaimedUntil]
    );
    if (!ingest.rows[0]) return undefined;
    const publications = await this.pool.query<PublicationRow>(
      `select * from media_sync_publications where source_key=$1 order by publication_type`,
      [ingest.rows[0].source_key]
    );
    return {
      ingest: mapIngest(ingest.rows[0]),
      publications: publications.rows.map(mapPublication)
    };
  }

  async failClaimedWork(input: {
    workId: string;
    expectedClaimedUntil: string;
    failureCategory: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const owned = await client.query<{ source_key: string }>(
        `select ingest.source_key
         from media_sync_ingests ingest
         join media_sync_outbox outbox on outbox.source_key=ingest.source_key
         where ingest.work_id=$1 and outbox.operation='intake'
           and ingest.state<>'tombstoned' and outbox.completed_at is null
           and outbox.claimed_until=$2::timestamptz
           and outbox.claimed_until > clock_timestamp()
         for update of ingest, outbox`,
        [input.workId, input.expectedClaimedUntil]
      );
      const sourceKey = owned.rows[0]?.source_key;
      if (!sourceKey) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `update media_sync_ingests set state='failed', updated_at=clock_timestamp()
         where source_key=$1`,
        [sourceKey]
      );
      await client.query(
        `update media_sync_publications
         set state='failed', failure_category=$2, updated_at=clock_timestamp()
         where source_key=$1 and state='pending'`,
        [sourceKey, input.failureCategory]
      );
      await client.query(
        `update media_sync_outbox
         set completed_at=clock_timestamp(), claimed_until=null,
             last_error_category=$2
         where source_key=$1 and operation='intake'`,
        [sourceKey, input.failureCategory]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async tombstoneClaimedWorkForCleanup(input: {
    workId: string;
    expectedClaimedUntil: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identity = await client.query<{ source_key: string }>(
        "select source_key from media_sync_ingests where work_id=$1",
        [input.workId]
      );
      const sourceKey = identity.rows[0]?.source_key;
      if (!sourceKey) {
        await client.query("rollback");
        return false;
      }
      await lockSource(client, sourceKey);
      const owned = await client.query(
        `select 1
         from media_sync_ingests ingest
         join media_sync_outbox outbox on outbox.source_key=ingest.source_key
         where ingest.work_id=$1 and ingest.state<>'tombstoned'
           and outbox.operation='intake' and outbox.completed_at is null
           and outbox.claimed_until=$2::timestamptz
           and outbox.claimed_until > clock_timestamp()
         for update of ingest, outbox`,
        [input.workId, input.expectedClaimedUntil]
      );
      if (!owned.rowCount) {
        await client.query("rollback");
        return false;
      }
      const tombstonedAt = this.now();
      await client.query(
        `insert into media_sync_source_tombstones (source_key, tombstoned_at)
         values ($1, $2) on conflict (source_key) do nothing`,
        [sourceKey, tombstonedAt]
      );
      await client.query(
        `update media_sync_ingests
         set state='tombstoned', tombstoned_at=$2, updated_at=$2
         where source_key=$1`,
        [sourceKey, tombstonedAt]
      );
      await client.query(
        `update media_sync_publications set state='revoked', updated_at=$2 where source_key=$1`,
        [sourceKey, tombstonedAt]
      );
      await client.query(
        `update media_sync_outbox
         set completed_at=$2, claimed_until=null
         where source_key=$1 and operation='intake'`,
        [sourceKey, tombstonedAt]
      );
      await reopenDeleteOutbox(client, sourceKey);
      await client.query("commit");
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistCompletedAsset(input: {
    workId: string;
    expectedClaimedUntil: string;
    assetId: string;
    assetEtag: string;
    sizeBytes: number;
    checksumSha256: string;
  }): Promise<boolean> {
    return this.withCollectionDeletionFence(input.workId, async (client) => {
      const result = await client.query(
        `update media_sync_ingests ingest
         set asset_id=$3, asset_etag=$4, size_bytes=$5, checksum_sha256=$6,
             state='awaiting_scan', updated_at=clock_timestamp()
         from media_sync_outbox outbox
         where outbox.source_key=ingest.source_key and ingest.work_id=$1
           and ingest.state<>'tombstoned' and outbox.operation='intake'
           and outbox.completed_at is null
           and outbox.claimed_until=$2::timestamptz
           and outbox.claimed_until > clock_timestamp()
           and exists (
             select 1 from media_sync_bindings binding
             where binding.profile_name=ingest.profile_name
               and binding.group_id=ingest.group_id
               and binding.collection_id=ingest.collection_id
               and binding.disabled_at is null
           )
           and not exists (
             select 1 from media_sync_collection_deletions deletion
             where deletion.collection_id=ingest.collection_id
           )`,
        [
          input.workId,
          input.expectedClaimedUntil,
          input.assetId,
          input.assetEtag,
          input.sizeBytes,
          input.checksumSha256
        ]
      );
      return Boolean(result.rowCount);
    });
  }

  async confirmManualPublication(input: {
    sourceKey: string;
    destinationId: string;
    requesterUserId: string;
    jobId: string;
    manualSourceKey: string;
    manualItemKind: string;
    manualDomain: string;
    manualTitle: string;
  }): Promise<boolean> {
    return this.withLockedIngest(input.sourceKey, async (client, ingest) => {
      if (!ingest || ingest.state === "tombstoned") return false;
      const publication = await client.query(
        `update media_sync_publications
         set job_id=$4, manual_source_key=$5, manual_item_kind=$6,
             manual_domain=$7, manual_title=$8, updated_at=clock_timestamp()
         where source_key=$1 and publication_type='manual'
           and destination_id=$2 and requester_user_id=$3
           and state='pending' and manual_source_key is null`,
        [
          input.sourceKey,
          input.destinationId,
          input.requesterUserId,
          input.jobId,
          input.manualSourceKey,
          input.manualItemKind,
          input.manualDomain,
          input.manualTitle
        ]
      );
      if (!publication.rowCount) return false;
      await client.query(
        `insert into media_sync_outbox
          (source_key, operation, available_at, claimed_until, dispatched_at, completed_at)
         values ($1, 'intake', clock_timestamp(), null, null, null)
         on conflict (source_key, operation) do update
         set available_at=excluded.available_at, claimed_until=null,
             dispatched_at=null, completed_at=null, last_error_category=null`,
        [input.sourceKey]
      );
      return true;
    });
  }

  async finalizeCollectionPublication(input: {
    workId: string;
    expectedClaimedUntil: string;
    collectionId: string;
    occurrenceId: string;
  }): Promise<boolean> {
    return this.withCollectionDeletionFence(input.workId, async (client) => {
      const result = await client.query(
        `update media_sync_publications publication
         set target_id=$4, state='published', failure_category=null,
             updated_at=clock_timestamp()
         from media_sync_ingests ingest, media_sync_outbox outbox
         where publication.source_key=ingest.source_key
           and outbox.source_key=ingest.source_key
           and ingest.work_id=$1 and ingest.state<>'tombstoned'
           and publication.publication_type='collection'
           and publication.destination_id=$3
           and outbox.operation='intake' and outbox.completed_at is null
           and outbox.claimed_until=$2::timestamptz
           and outbox.claimed_until > clock_timestamp()
           and exists (
             select 1 from media_sync_bindings binding
             where binding.profile_name=ingest.profile_name
               and binding.group_id=ingest.group_id
               and binding.collection_id=ingest.collection_id
               and binding.disabled_at is null
           )
           and not exists (
             select 1 from media_sync_collection_deletions deletion
             where deletion.collection_id=ingest.collection_id
           )`,
        [input.workId, input.expectedClaimedUntil, input.collectionId, input.occurrenceId]
      );
      return Boolean(result.rowCount);
    });
  }

  async finalizeManualPublication(input: {
    workId: string;
    expectedClaimedUntil: string;
    destinationId: string;
    resourceId: string;
  }): Promise<boolean> {
    return this.withCollectionDeletionFence(input.workId, async (client) => {
      const result = await client.query(
        `update media_sync_publications publication
         set target_id=$4, state='published', failure_category=null,
             updated_at=clock_timestamp()
         from media_sync_ingests ingest, media_sync_outbox outbox
         where publication.source_key=ingest.source_key
           and outbox.source_key=ingest.source_key
           and ingest.work_id=$1 and ingest.state<>'tombstoned'
           and publication.publication_type='manual'
           and publication.destination_id=$3 and publication.state='pending'
           and publication.manual_source_key is not null
           and outbox.operation='intake' and outbox.completed_at is null
           and outbox.claimed_until=$2::timestamptz
           and outbox.claimed_until > clock_timestamp()
           and exists (
             select 1 from media_sync_bindings binding
             where binding.profile_name=ingest.profile_name
               and binding.group_id=ingest.group_id
               and binding.collection_id=ingest.collection_id
               and binding.disabled_at is null
           )
           and not exists (
             select 1 from media_sync_collection_deletions deletion
             where deletion.collection_id=ingest.collection_id
           )`,
        [input.workId, input.expectedClaimedUntil, input.destinationId, input.resourceId]
      );
      return Boolean(result.rowCount);
    });
  }

  async failManualPublication(input: {
    workId: string;
    expectedClaimedUntil: string;
    destinationId: string;
    failureCategory: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `update media_sync_publications publication
       set state='failed', failure_category=$4, updated_at=clock_timestamp()
       from media_sync_ingests ingest, media_sync_outbox outbox
       where publication.source_key=ingest.source_key
         and outbox.source_key=ingest.source_key
         and ingest.work_id=$1 and ingest.state<>'tombstoned'
         and publication.publication_type='manual'
         and publication.destination_id=$3 and publication.state='pending'
         and publication.manual_source_key is not null
         and outbox.operation='intake' and outbox.completed_at is null
         and outbox.claimed_until=$2::timestamptz
         and outbox.claimed_until > clock_timestamp()`,
      [input.workId, input.expectedClaimedUntil, input.destinationId, input.failureCategory]
    );
    return Boolean(result.rowCount);
  }

  async completeClaimedWork(input: {
    workId: string;
    expectedClaimedUntil: string;
  }): Promise<boolean> {
    return this.withCollectionDeletionFence(input.workId, async (client) => {
      const owned = await client.query<{ source_key: string }>(
        `select ingest.source_key
         from media_sync_ingests ingest
         join media_sync_outbox outbox on outbox.source_key=ingest.source_key
         where ingest.work_id=$1 and ingest.state<>'tombstoned'
           and outbox.operation='intake' and outbox.completed_at is null
           and outbox.claimed_until=$2::timestamptz
           and outbox.claimed_until > clock_timestamp()
           and exists (
             select 1 from media_sync_bindings binding
             where binding.profile_name=ingest.profile_name
               and binding.group_id=ingest.group_id
               and binding.collection_id=ingest.collection_id
               and binding.disabled_at is null
           )
           and not exists (
             select 1 from media_sync_collection_deletions deletion
             where deletion.collection_id=ingest.collection_id
           )
           and not exists (
             select 1 from media_sync_publications publication
             where publication.source_key=ingest.source_key and publication.state='pending'
               and (
                 publication.publication_type<>'manual'
                 or publication.manual_source_key is not null
               )
           )
         for update of ingest, outbox`,
        [input.workId, input.expectedClaimedUntil]
      );
      const sourceKey = owned.rows[0]?.source_key;
      if (!sourceKey) return false;
      await client.query(
        `update media_sync_ingests set state='ready', updated_at=clock_timestamp()
         where source_key=$1`,
        [sourceKey]
      );
      await client.query(
        `update media_sync_outbox
         set completed_at=clock_timestamp(), claimed_until=null, last_error_category=null
         where source_key=$1 and operation='intake'`,
        [sourceKey]
      );
      return true;
    });
  }

  async completeDeleteWork(input: {
    workId: string;
    expectedClaimedUntil: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `update media_sync_outbox outbox
       set completed_at=clock_timestamp(), claimed_until=null, last_error_category=null
       from media_sync_ingests ingest
       where ingest.source_key=outbox.source_key and ingest.work_id=$1
         and outbox.operation='delete' and outbox.completed_at is null
         and outbox.claimed_until=$2::timestamptz
         and outbox.claimed_until > clock_timestamp()
         and exists (
           select 1 from media_sync_source_tombstones tombstone
           where tombstone.source_key=outbox.source_key
         )`,
      [input.workId, input.expectedClaimedUntil]
    );
    return Boolean(result.rowCount);
  }

  async rememberExternalHandle(input: {
    workId: string;
    publicationType: MediaSyncPublicationType;
    destinationId: string;
    targetId: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identity = await client.query<{ source_key: string }>(
        "select source_key from media_sync_ingests where work_id=$1",
        [input.workId]
      );
      const sourceKey = identity.rows[0]?.source_key;
      if (!sourceKey) {
        await client.query("rollback");
        return false;
      }
      await lockSource(client, sourceKey);
      const ingest = (
        await client.query<IngestRow>(
          "select * from media_sync_ingests where source_key=$1 for update",
          [sourceKey]
        )
      ).rows[0];
      if (!ingest) {
        await client.query("rollback");
        return false;
      }
      const tombstoned = Boolean(
        (
          await client.query("select 1 from media_sync_source_tombstones where source_key=$1", [
            sourceKey
          ])
        ).rowCount
      );
      const result = await client.query(
        `update media_sync_publications
         set destination_id=$3, target_id=$4,
             state=case when $5 then 'revoked' else state end,
             updated_at=clock_timestamp()
         where source_key=$1 and publication_type=$2`,
        [sourceKey, input.publicationType, input.destinationId, input.targetId, tombstoned]
      );
      if (tombstoned) await reopenDeleteOutbox(client, sourceKey);
      await client.query("commit");
      return Boolean(result.rowCount);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rememberOwnedAsset(input: {
    workId: string;
    assetId: string;
    assetEtag?: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identity = await client.query<{ source_key: string }>(
        "select source_key from media_sync_ingests where work_id=$1",
        [input.workId]
      );
      const sourceKey = identity.rows[0]?.source_key;
      if (!sourceKey) {
        await client.query("rollback");
        return false;
      }
      await lockSource(client, sourceKey);
      const tombstoned = Boolean(
        (
          await client.query("select 1 from media_sync_source_tombstones where source_key=$1", [
            sourceKey
          ])
        ).rowCount
      );
      const result = await client.query(
        `update media_sync_ingests
         set asset_id=$2, asset_etag=$3, updated_at=clock_timestamp()
         where source_key=$1`,
        [sourceKey, input.assetId, input.assetEtag ?? null]
      );
      if (result.rowCount && tombstoned) await reopenDeleteOutbox(client, sourceKey);
      await client.query("commit");
      return Boolean(result.rowCount);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async retryOutbox(input: {
    sourceKey: string;
    operation: MediaSyncOutboxOperation;
    expectedClaimedUntil: string;
    availableAt: Date;
    lastErrorCategory: string;
  }): Promise<boolean> {
    return this.withLockedIngest(input.sourceKey, async (client, ingest) => {
      if (!ingest || (input.operation === "intake" && ingest.state === "tombstoned")) return false;
      if (
        input.operation === "delete" &&
        !(
          await client.query("select 1 from media_sync_source_tombstones where source_key=$1", [
            input.sourceKey
          ])
        ).rowCount
      ) {
        return false;
      }
      const result = await client.query(
        `update media_sync_outbox
         set available_at=$3, claimed_until=null, last_error_category=$4
             , dispatched_at=null
         where source_key=$1 and operation=$2 and completed_at is null
           and claimed_until=$5::timestamptz
           and claimed_until > clock_timestamp()`,
        [
          input.sourceKey,
          input.operation,
          input.availableAt,
          input.lastErrorCategory,
          input.expectedClaimedUntil
        ]
      );
      return Boolean(result.rowCount);
    });
  }

  async recordPublication(input: {
    sourceKey: string;
    publicationType: MediaSyncPublicationType;
    targetId: string;
    state: MediaSyncPublicationState;
    destinationId?: string;
    failureCategory?: string;
  }): Promise<boolean> {
    return this.withLockedIngest(input.sourceKey, async (client, ingest) => {
      if (!ingest || ingest.state === "tombstoned") return false;
      const result = await client.query(
        `insert into media_sync_publications
          (source_key, publication_type, destination_id, target_id, state,
           failure_category, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (source_key, publication_type) do update
         set target_id=excluded.target_id, state=excluded.state,
             failure_category=excluded.failure_category, updated_at=excluded.updated_at`,
        [
          input.sourceKey,
          input.publicationType,
          input.destinationId ??
            (input.publicationType === "collection" ? ingest.collection_id : input.targetId),
          input.targetId,
          input.state,
          input.failureCategory ?? null
        ]
      );
      return Boolean(result.rowCount);
    });
  }

  async tombstoneSource(sourceKey: string, tombstonedAt: Date = this.now()): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockSource(client, sourceKey);
      await client.query(
        `insert into media_sync_source_tombstones (source_key, tombstoned_at)
         values ($1, $2) on conflict (source_key) do nothing`,
        [sourceKey, tombstonedAt]
      );
      const ingest = (
        await client.query<IngestRow>(
          "select * from media_sync_ingests where source_key=$1 for update",
          [sourceKey]
        )
      ).rows[0];
      if (!ingest) {
        await client.query("commit");
        return true;
      }
      if (ingest.state !== "tombstoned") {
        await client.query(
          `update media_sync_ingests
           set state='tombstoned', tombstoned_at=$2, updated_at=$2
           where source_key=$1`,
          [sourceKey, tombstonedAt]
        );
      }
      await client.query(
        `update media_sync_publications set state='revoked', updated_at=$2 where source_key=$1`,
        [sourceKey, tombstonedAt]
      );
      await client.query(
        `update media_sync_outbox
         set completed_at=coalesce(completed_at, $2), claimed_until=null
         where source_key=$1 and operation='intake'`,
        [sourceKey, tombstonedAt]
      );
      await client.query(
        `insert into media_sync_outbox
          (source_key, operation, available_at, claimed_until, dispatched_at, completed_at)
         values ($1, 'delete', $2, null, null, null)
         on conflict (source_key, operation) do update
         set available_at=excluded.available_at, claimed_until=null, dispatched_at=null,
             completed_at=null`,
        [sourceKey, tombstonedAt]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async withLockedIngest<T>(
    sourceKey: string,
    operation: (client: PoolClient, ingest: IngestRow | undefined) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockSource(client, sourceKey);
      const ingest = (
        await client.query<IngestRow>(
          "select * from media_sync_ingests where source_key=$1 for update",
          [sourceKey]
        )
      ).rows[0];
      const result = await operation(client, ingest);
      await client.query("commit");
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async withCollectionDeletionFence(
    workId: string,
    operation: (client: PoolClient) => Promise<boolean>
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identity = (
        await client.query<{ profile_name: string; collection_id: string }>(
          "select profile_name, collection_id from media_sync_ingests where work_id=$1",
          [workId]
        )
      ).rows[0];
      if (!identity) {
        await client.query("rollback");
        return false;
      }
      await lockBindingCollection(client, identity.profile_name, identity.collection_id);
      if (await collectionDeletionExists(client, identity.collection_id)) {
        await client.query("rollback");
        return false;
      }
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex");
}

function assertLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error("media_sync_outbox_lease_invalid");
  }
}

async function lockSource(client: PoolClient, sourceKey: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [sourceKey]);
}

async function lockBindingCollection(
  client: PoolClient,
  profileName: string,
  collectionId: string
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify([profileName, collectionId])
  ]);
}

async function collectionDeletionExists(
  client: PoolClient,
  collectionId: string
): Promise<boolean> {
  const result = await client.query(
    "select 1 from media_sync_collection_deletions where collection_id=$1",
    [collectionId]
  );
  return Boolean(result.rowCount);
}

async function reopenDeleteOutbox(client: PoolClient, sourceKey: string): Promise<void> {
  await client.query(
    `insert into media_sync_outbox
      (source_key, operation, available_at, claimed_until, dispatched_at, completed_at)
     values ($1, 'delete', clock_timestamp(), null, null, null)
     on conflict (source_key, operation) do update
     set available_at=excluded.available_at, claimed_until=null, dispatched_at=null,
         completed_at=null`,
    [sourceKey]
  );
}

function assertSameIngest(row: IngestRow, input: CreateMediaSyncIngestInput): void {
  if (
    row.profile_name !== input.profileName ||
    row.message_id !== input.messageId ||
    row.group_id !== input.groupId ||
    row.media_kind !== input.mediaKind
  ) {
    throw new Error("media_sync_ingest_identity_conflict");
  }
}

function hashRequestIdentity(
  input: CreateMediaSyncBindingCodeInput,
  idempotencyKey: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "create_binding_code",
        input.createdByHhcUserId,
        input.profileName,
        input.collectionId,
        idempotencyKey
      ]),
      "utf8"
    )
    .digest("hex");
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("rollback").catch(() => undefined);
}

function postgresConstraint(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "constraint" in error
    ? String(error.constraint)
    : undefined;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapBinding(row: BindingRow): MediaSyncBinding {
  return {
    id: row.id,
    profileName: row.profile_name,
    groupId: row.group_id,
    collectionId: row.collection_id,
    groupDisplayName: row.group_display_name,
    ...(row.bound_by_line_user_id ? { boundByLineUserId: row.bound_by_line_user_id } : {}),
    bindingCodeCreatedByHhcUserId: row.binding_code_created_by_hhc_user_id,
    boundAt: timestamp(row.bound_at),
    ...(row.disabled_at ? { disabledAt: timestamp(row.disabled_at) } : {})
  };
}

function mapIngest(row: IngestRow): MediaSyncIngest {
  return {
    sourceKey: row.source_key,
    workId: row.work_id,
    profileName: row.profile_name,
    messageId: row.message_id,
    groupId: row.group_id,
    collectionId: row.collection_id,
    ...(row.asset_id ? { assetId: row.asset_id } : {}),
    ...(row.asset_etag ? { assetEtag: row.asset_etag } : {}),
    state: row.state,
    displayName: row.display_name,
    mediaKind: row.media_kind,
    expectedMime: row.expected_mime,
    ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
    ...(row.checksum_sha256 ? { checksumSha256: row.checksum_sha256 } : {}),
    ...(row.tombstoned_at ? { tombstonedAt: timestamp(row.tombstoned_at) } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at)
  };
}

function mapOutbox(row: OutboxRow): MediaSyncOutboxItem {
  return {
    workId: row.work_id,
    sourceKey: row.source_key,
    operation: row.operation,
    attempts: row.attempts,
    availableAt: timestamp(row.available_at),
    ...(row.claimed_until ? { claimedUntil: timestamp(row.claimed_until) } : {}),
    ...(row.dispatched_at ? { dispatchedAt: timestamp(row.dispatched_at) } : {}),
    ...(row.completed_at ? { completedAt: timestamp(row.completed_at) } : {}),
    ...(row.last_error_category ? { lastErrorCategory: row.last_error_category } : {})
  };
}

function mapPublication(row: PublicationRow): MediaSyncPublication {
  return {
    sourceKey: row.source_key,
    publicationType: row.publication_type,
    destinationId: row.destination_id,
    ...(row.target_id ? { targetId: row.target_id } : {}),
    state: row.state,
    ...(row.failure_category ? { failureCategory: row.failure_category } : {}),
    ...(row.requester_user_id ? { requesterUserId: row.requester_user_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.manual_source_key ? { manualSourceKey: row.manual_source_key } : {}),
    ...(row.manual_item_kind ? { manualItemKind: row.manual_item_kind } : {}),
    ...(row.manual_domain ? { manualDomain: row.manual_domain } : {}),
    ...(row.manual_title ? { manualTitle: row.manual_title } : {})
  };
}
