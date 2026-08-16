import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { generateInviteCode } from "../access/registration-invite-code-store.js";
import type {
  BindMediaSyncCodeInput,
  BindMediaSyncCodeResult,
  CreateMediaSyncBindingCodeInput,
  CreateMediaSyncIngestInput,
  MediaSyncBinding,
  MediaSyncBindingCode,
  MediaSyncIngest,
  MediaSyncOutboxItem,
  MediaSyncOutboxOperation,
  MediaSyncPublicationState,
  MediaSyncPublicationType
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
  profile_name: string;
  message_id: string;
  group_id: string;
  collection_id: string;
  asset_id: string | null;
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
  source_key: string;
  operation: MediaSyncOutboxOperation;
  attempts: number;
  available_at: Date | string;
  claimed_until: Date | string | null;
  completed_at: Date | string | null;
  last_error_category: string | null;
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

  async createBindingCode(input: CreateMediaSyncBindingCodeInput): Promise<MediaSyncBindingCode> {
    const client = await this.pool.connect();
    const now = input.now ?? this.now();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const code = this.codeFactory();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify([input.profileName, input.collectionId])
      ]);
      const active = await client.query(
        `select 1 from media_sync_binding_codes
         where profile_name=$1 and collection_id=$2
           and consumed_at is null and expires_at > $3
         limit 1`,
        [input.profileName, input.collectionId, now]
      );
      if (active.rowCount) throw new Error("media_sync_binding_code_active");
      await client.query(
        `insert into media_sync_binding_codes
          (id, profile_name, collection_id, code_hash, created_by_hhc_user_id, expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          input.profileName,
          input.collectionId,
          hashCode(code),
          input.createdByHhcUserId,
          expiresAt
        ]
      );
      await client.query("commit");
      return { code, expiresAt: expiresAt.toISOString() };
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
      const code = await client.query<BindingCodeRow>(
        `select id, collection_id, created_by_hhc_user_id
         from media_sync_binding_codes
         where profile_name=$1 and code_hash=$2
           and consumed_at is null and expires_at > $3
         for update`,
        [input.profileName, hashCode(input.code), now]
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
       where profile_name=$1 and group_id=$2 and disabled_at is null`,
      [input.profileName, input.groupId]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }

  async findActiveBindingByCollection(collectionId: string): Promise<MediaSyncBinding | undefined> {
    const result = await this.pool.query<BindingRow>(
      `select * from media_sync_bindings
       where collection_id=$1 and disabled_at is null`,
      [collectionId]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
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

  async createIngest(input: CreateMediaSyncIngestInput): Promise<{
    ingest: MediaSyncIngest;
    created: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
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
      if (ingest.state !== "tombstoned") {
        await client.query(
          `insert into media_sync_outbox (source_key, operation)
           values ($1, 'intake')
           on conflict (source_key, operation) do nothing`,
          [input.sourceKey]
        );
      }
      await client.query("commit");
      return { ingest: mapIngest(ingest), created };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimOutbox(input: {
    limit: number;
    now?: Date;
    leaseMs: number;
  }): Promise<MediaSyncOutboxItem[]> {
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
           and ingest.tombstoned_at is null
         order by outbox.available_at, outbox.source_key, outbox.operation
         for update of outbox skip locked
         limit $2
       )
       update media_sync_outbox outbox
       set attempts=outbox.attempts + 1, claimed_until=$3, last_error_category=null
       from claimable
       where outbox.source_key=claimable.source_key and outbox.operation=claimable.operation
       returning outbox.*`,
      [now, Math.max(0, Math.trunc(input.limit)), claimedUntil]
    );
    return result.rows.map(mapOutbox);
  }

  async retryOutbox(input: {
    sourceKey: string;
    operation: MediaSyncOutboxOperation;
    availableAt: Date;
    lastErrorCategory: string;
  }): Promise<boolean> {
    return this.withLockedIngest(input.sourceKey, async (client, ingest) => {
      if (!ingest || ingest.state === "tombstoned") return false;
      const result = await client.query(
        `update media_sync_outbox
         set available_at=$3, claimed_until=null, last_error_category=$4
         where source_key=$1 and operation=$2 and completed_at is null`,
        [input.sourceKey, input.operation, input.availableAt, input.lastErrorCategory]
      );
      return Boolean(result.rowCount);
    });
  }

  async recordPublication(input: {
    sourceKey: string;
    publicationType: MediaSyncPublicationType;
    targetId: string;
    state: MediaSyncPublicationState;
  }): Promise<boolean> {
    return this.withLockedIngest(input.sourceKey, async (client, ingest) => {
      if (!ingest || ingest.state === "tombstoned") return false;
      await client.query(
        `insert into media_sync_publications
          (source_key, publication_type, target_id, state, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (source_key, publication_type, target_id) do update
         set state=excluded.state, updated_at=excluded.updated_at`,
        [input.sourceKey, input.publicationType, input.targetId, input.state]
      );
      return true;
    });
  }

  async tombstoneSource(sourceKey: string, tombstonedAt: Date = this.now()): Promise<boolean> {
    return this.withLockedIngest(sourceKey, async (client, ingest) => {
      if (!ingest) return false;
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
         where source_key=$1`,
        [sourceKey, tombstonedAt]
      );
      return true;
    });
  }

  private async withLockedIngest<T>(
    sourceKey: string,
    operation: (client: PoolClient, ingest: IngestRow | undefined) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
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
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex");
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
    profileName: row.profile_name,
    messageId: row.message_id,
    groupId: row.group_id,
    collectionId: row.collection_id,
    ...(row.asset_id ? { assetId: row.asset_id } : {}),
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
    sourceKey: row.source_key,
    operation: row.operation,
    attempts: row.attempts,
    availableAt: timestamp(row.available_at),
    ...(row.claimed_until ? { claimedUntil: timestamp(row.claimed_until) } : {}),
    ...(row.completed_at ? { completedAt: timestamp(row.completed_at) } : {}),
    ...(row.last_error_category ? { lastErrorCategory: row.last_error_category } : {})
  };
}
