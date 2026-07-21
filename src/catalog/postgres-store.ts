import { randomUUID } from "node:crypto";

import type { AgentResourceStorage } from "../types.js";
import {
  catalogStorageIdentity,
  normalizeCatalogText,
  type CatalogItemInput,
  type CatalogItemRecord,
  type CatalogSearchInput,
  type CatalogSourceListInput,
  type CatalogSourceInput,
  type CatalogSourceRecord,
  type CatalogStore
} from "./store.js";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

type CatalogSourceRow = {
  id: string;
  profile_name: string;
  source_key: string;
  adapter_type: string;
  domain: string;
  default_item_kind: string;
  root_location: Record<string, string>;
  enabled: boolean;
  sync_policy: CatalogSourceRecord["syncPolicy"];
  capabilities: CatalogSourceRecord["capabilities"];
  sync_cursor: string | null;
  revision: string;
  health_status: CatalogSourceRecord["healthStatus"];
  last_attempt_at: Date | string | null;
  last_success_at: Date | string | null;
  last_failure_at: Date | string | null;
  last_error_code: string | null;
  published_item_count: string | number;
};

type CatalogItemRow = {
  id: string;
  source_id: string;
  item_kind: string;
  domain: string;
  title: string;
  normalized_title: string;
  path: string | null;
  mime_type: string | null;
  extension: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  storage_ref: AgentResourceStorage;
  external_updated_at: Date | string | null;
  expires_at: Date | string | null;
  deleted_at: Date | string | null;
  source_id_join: string;
  profile_name: string;
  source_key: string;
  adapter_type: string;
  source_domain: string;
  default_item_kind: string;
  root_location: Record<string, string>;
  enabled: boolean;
  sync_policy: CatalogSourceRecord["syncPolicy"];
  capabilities: CatalogSourceRecord["capabilities"];
  sync_cursor: string | null;
  revision: string;
  health_status: CatalogSourceRecord["healthStatus"];
  last_attempt_at: Date | string | null;
  last_success_at: Date | string | null;
  last_failure_at: Date | string | null;
  last_error_code: string | null;
  published_item_count: string | number;
};

export class PostgresCatalogStore implements CatalogStore {
  constructor(private readonly db: PgQueryable) {}

  async upsertSource(input: CatalogSourceInput): Promise<CatalogSourceRecord> {
    const result = await this.db.query<CatalogSourceRow>(
      `
      insert into catalog_sources
        (id, profile_name, source_key, adapter_type, domain, default_item_kind,
         root_location, enabled, sync_policy, capabilities, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, now())
      on conflict (profile_name, source_key) do update
      set adapter_type = excluded.adapter_type,
          domain = excluded.domain,
          default_item_kind = excluded.default_item_kind,
          root_location = excluded.root_location,
          enabled = excluded.enabled,
          sync_policy = excluded.sync_policy,
          capabilities = excluded.capabilities,
          updated_at = now()
      returning *
      `,
      [
        randomUUID(),
        input.profileName,
        input.sourceKey,
        input.adapterType,
        input.domain,
        input.defaultItemKind,
        JSON.stringify(input.rootLocation),
        input.enabled,
        JSON.stringify(input.syncPolicy),
        JSON.stringify(input.capabilities)
      ]
    );
    return mapSource(result.rows[0]);
  }

  async createSourceIfMissing(input: CatalogSourceInput): Promise<{
    source: CatalogSourceRecord;
    created: boolean;
  }> {
    const result = await this.db.query<CatalogSourceRow>(
      `
      insert into catalog_sources
        (id, profile_name, source_key, adapter_type, domain, default_item_kind,
         root_location, enabled, sync_policy, capabilities, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, now())
      on conflict (profile_name, source_key) do nothing
      returning *
      `,
      [
        randomUUID(),
        input.profileName,
        input.sourceKey,
        input.adapterType,
        input.domain,
        input.defaultItemKind,
        JSON.stringify(input.rootLocation),
        input.enabled,
        JSON.stringify(input.syncPolicy),
        JSON.stringify(input.capabilities)
      ]
    );
    if (result.rows[0]) {
      return { source: mapSource(result.rows[0]), created: true };
    }
    const existing = await this.db.query<CatalogSourceRow>(
      `
      select *
      from catalog_sources
      where profile_name = $1
        and source_key = $2
      `,
      [input.profileName, input.sourceKey]
    );
    if (!existing.rows[0]) {
      throw new Error(`catalog_source_seed_not_found:${input.profileName}:${input.sourceKey}`);
    }
    return { source: mapSource(existing.rows[0]), created: false };
  }

  async listSources(input: CatalogSourceListInput = {}): Promise<CatalogSourceRecord[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (input.profileName) {
      values.push(input.profileName);
      conditions.push(`profile_name = $${values.length}`);
    }
    if (input.enabled !== undefined) {
      values.push(input.enabled);
      conditions.push(`enabled = $${values.length}`);
    }
    if (input.sourceKeys?.length) {
      values.push(input.sourceKeys);
      conditions.push(`source_key = any($${values.length}::text[])`);
    }
    const result = await this.db.query<CatalogSourceRow>(
      `
      select *
      from catalog_sources
      ${conditions.length ? `where ${conditions.join("\n        and ")}` : ""}
      order by profile_name asc, source_key asc
      `,
      values
    );
    return result.rows.map(mapSource);
  }

  async updateSourceEnabled(input: {
    profileName: string;
    sourceKey: string;
    enabled: boolean;
  }): Promise<CatalogSourceRecord | undefined> {
    const result = await this.db.query<CatalogSourceRow>(
      `
      update catalog_sources
      set enabled = $3,
          updated_at = now()
      where profile_name = $1
        and source_key = $2
      returning *
      `,
      [input.profileName, input.sourceKey, input.enabled]
    );
    return result.rows[0] ? mapSource(result.rows[0]) : undefined;
  }

  async updateSourceSyncCursor(sourceId: string, syncCursor: string | undefined): Promise<void> {
    await this.db.query(
      `
      update catalog_sources
      set sync_cursor = $2,
          updated_at = now()
      where id = $1
      `,
      [sourceId, syncCursor ?? null]
    );
  }

  async publishSourceSnapshot(input: {
    sourceId: string;
    expectedRevision: string;
    items: CatalogItemInput[];
    syncCursor?: string;
    publishedAt: string;
  }): Promise<CatalogSourceRecord | undefined> {
    assertPublicationScope(input.sourceId, input.items);
    const payload = input.items.map(publicationItem);
    const result = await this.db.query<CatalogSourceRow>(
      `
      with eligible as (
        select id from catalog_sources where id = $1 and revision = $2 for update
      ), incoming as (
        select * from jsonb_to_recordset($3::jsonb) as row(
          id uuid, "itemKind" text, domain text, title text, "normalizedTitle" text,
          path text, "mimeType" text, extension text, "sizeBytes" bigint, sha256 text,
          "storageRef" jsonb, "storageIdentity" text, "externalUpdatedAt" timestamptz,
          "expiresAt" timestamptz
        )
      ), upserted as (
        insert into catalog_items
          (id, source_id, item_kind, domain, title, normalized_title, path, mime_type,
           extension, size_bytes, sha256, storage_ref, storage_identity,
           external_updated_at, expires_at, deleted_at, updated_at)
        select incoming.id, eligible.id, "itemKind", domain, title, "normalizedTitle", path,
               "mimeType", extension, "sizeBytes", sha256, "storageRef", "storageIdentity",
               "externalUpdatedAt", "expiresAt", null, $5::timestamptz
        from incoming cross join eligible
        on conflict (source_id, storage_identity) do update
        set item_kind = excluded.item_kind, domain = excluded.domain, title = excluded.title,
            normalized_title = excluded.normalized_title, path = excluded.path,
            mime_type = excluded.mime_type, extension = excluded.extension,
            size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
            storage_ref = excluded.storage_ref, external_updated_at = excluded.external_updated_at,
            expires_at = excluded.expires_at, deleted_at = null, updated_at = $5::timestamptz
        returning id
      ), tombstoned as (
        update catalog_items
        set deleted_at = $5::timestamptz, updated_at = $5::timestamptz
        where source_id in (select id from eligible)
          and deleted_at is null
          and storage_identity not in (select "storageIdentity" from incoming)
        returning id
      )
      update catalog_sources
      set revision = (revision::bigint + 1)::text,
          sync_cursor = $4,
          health_status = 'ready',
          last_attempt_at = $5::timestamptz,
          last_success_at = $5::timestamptz,
          last_error_code = null,
          published_item_count = (select count(*) from incoming),
          updated_at = $5::timestamptz
      where id in (select id from eligible)
      returning *
      `,
      [
        input.sourceId,
        input.expectedRevision,
        JSON.stringify(payload),
        input.syncCursor ?? null,
        input.publishedAt
      ]
    );
    return result.rows[0] ? mapSource(result.rows[0]) : undefined;
  }

  async publishSourceDelta(input: {
    sourceId: string;
    expectedRevision: string;
    upserts: CatalogItemInput[];
    deletedStorageIdentities: string[];
    syncCursor: string;
    publishedAt: string;
  }): Promise<CatalogSourceRecord | undefined> {
    assertPublicationScope(input.sourceId, input.upserts);
    const payload = input.upserts.map(publicationItem);
    const result = await this.db.query<CatalogSourceRow>(
      `
      with eligible as (
        select id from catalog_sources where id = $1 and revision = $2 for update
      ), tombstoned as (
        update catalog_items
        set deleted_at = $6::timestamptz, updated_at = $6::timestamptz
        where source_id in (select id from eligible)
          and storage_identity = any($4::text[])
        returning id
      ), incoming as (
        select * from jsonb_to_recordset($3::jsonb) as row(
          id uuid, "itemKind" text, domain text, title text, "normalizedTitle" text,
          path text, "mimeType" text, extension text, "sizeBytes" bigint, sha256 text,
          "storageRef" jsonb, "storageIdentity" text, "externalUpdatedAt" timestamptz,
          "expiresAt" timestamptz
        )
      ), inserted as (
        insert into catalog_items
          (id, source_id, item_kind, domain, title, normalized_title, path, mime_type,
           extension, size_bytes, sha256, storage_ref, storage_identity,
           external_updated_at, expires_at, deleted_at, updated_at)
        select incoming.id, eligible.id, "itemKind", domain, title, "normalizedTitle", path,
               "mimeType", extension, "sizeBytes", sha256, "storageRef", "storageIdentity",
               "externalUpdatedAt", "expiresAt", null, $6::timestamptz
        from incoming cross join eligible
        on conflict (source_id, storage_identity) do update
        set item_kind = excluded.item_kind, domain = excluded.domain, title = excluded.title,
            normalized_title = excluded.normalized_title, path = excluded.path,
            mime_type = excluded.mime_type, extension = excluded.extension,
            size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
            storage_ref = excluded.storage_ref, external_updated_at = excluded.external_updated_at,
            expires_at = excluded.expires_at, deleted_at = null, updated_at = $6::timestamptz
        returning id
      )
      update catalog_sources
      set revision = (revision::bigint + 1)::text,
          sync_cursor = $5,
          health_status = 'ready',
          last_attempt_at = $6::timestamptz,
          last_success_at = $6::timestamptz,
          last_error_code = null,
          published_item_count = (
            select count(*) from (
              select storage_identity
              from catalog_items
              where source_id in (select id from eligible)
                and deleted_at is null
                and not (storage_identity = any($4::text[]))
              union
              select "storageIdentity" from incoming
            ) active_items
          ),
          updated_at = $6::timestamptz
      where id in (select id from eligible)
      returning *
      `,
      [
        input.sourceId,
        input.expectedRevision,
        JSON.stringify(payload),
        input.deletedStorageIdentities,
        input.syncCursor,
        input.publishedAt
      ]
    );
    return result.rows[0] ? mapSource(result.rows[0]) : undefined;
  }

  async markSourceSyncFailure(input: {
    sourceId: string;
    expectedRevision: string;
    failedAt: string;
    errorCode: string;
  }): Promise<CatalogSourceRecord | undefined> {
    const result = await this.db.query<CatalogSourceRow>(
      `
      update catalog_sources
      set health_status = 'unavailable', last_attempt_at = $3::timestamptz,
          last_failure_at = $3::timestamptz, last_error_code = $4, updated_at = $3::timestamptz
      where id = $1 and revision = $2
      returning *
      `,
      [input.sourceId, input.expectedRevision, input.failedAt, input.errorCode]
    );
    return result.rows[0] ? mapSource(result.rows[0]) : undefined;
  }

  async upsertItem(input: CatalogItemInput): Promise<CatalogItemRecord> {
    const normalizedTitle = input.normalizedTitle ?? normalizeCatalogText(input.title);
    const result = await this.db.query<{ id: string }>(
      `
      with upserted as (
      insert into catalog_items
        (id, source_id, item_kind, domain, title, normalized_title, path, mime_type,
         extension, size_bytes, sha256, storage_ref, storage_identity,
         external_updated_at, expires_at, deleted_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, now())
      on conflict (source_id, storage_identity) do update
      set item_kind = excluded.item_kind,
          domain = excluded.domain,
          title = excluded.title,
          normalized_title = excluded.normalized_title,
          path = excluded.path,
          mime_type = excluded.mime_type,
          extension = excluded.extension,
          size_bytes = excluded.size_bytes,
          sha256 = excluded.sha256,
          storage_ref = excluded.storage_ref,
          external_updated_at = excluded.external_updated_at,
          expires_at = excluded.expires_at,
          deleted_at = excluded.deleted_at,
          updated_at = now()
      returning id
      ), promoted as (
        update catalog_sources
        set revision = (revision::bigint + 1)::text,
            health_status = 'ready',
            last_attempt_at = now(),
            last_success_at = now(),
            last_error_code = null,
            published_item_count = (
              select count(*)
              from catalog_items
              where source_id = $2 and deleted_at is null and storage_identity <> $13
            ) + 1,
            updated_at = now()
        where id = $2
        returning id
      )
      select id from upserted
      `,
      [
        randomUUID(),
        input.sourceId,
        input.itemKind,
        input.domain,
        input.title,
        normalizedTitle,
        input.path ?? null,
        input.mimeType ?? null,
        input.extension ?? null,
        input.sizeBytes ?? null,
        input.sha256 ?? null,
        JSON.stringify(input.storageRef),
        catalogStorageIdentity(input.storageRef),
        input.externalUpdatedAt ?? null,
        input.expiresAt ?? null,
        input.deletedAt ?? null
      ]
    );
    return this.getItemById(result.rows[0].id);
  }

  async tombstoneMissingItems(input: {
    sourceId: string;
    liveStorageIdentities: string[];
    deletedAt: string;
  }): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `
      update catalog_items
      set deleted_at = $3,
          updated_at = now()
      where source_id = $1
        and deleted_at is null
        and not (storage_identity = any($2::text[]))
      returning id
      `,
      [input.sourceId, input.liveStorageIdentities, input.deletedAt]
    );
    return result.rows.length;
  }

  async tombstoneItemsByStorageIdentities(input: {
    sourceId: string;
    storageIdentities: string[];
    deletedAt: string;
  }): Promise<number> {
    if (input.storageIdentities.length === 0) {
      return 0;
    }
    const result = await this.db.query<{ id: string }>(
      `
      update catalog_items
      set deleted_at = $3,
          updated_at = now()
      where source_id = $1
        and deleted_at is null
        and storage_identity = any($2::text[])
      returning id
      `,
      [input.sourceId, input.storageIdentities, input.deletedAt]
    );
    return result.rows.length;
  }

  async searchItems(input: CatalogSearchInput): Promise<CatalogItemRecord[]> {
    const values: unknown[] = [input.profileName];
    const conditions = [
      "catalog_sources.profile_name = $1",
      "catalog_sources.enabled = true",
      "catalog_items.deleted_at is null",
      "(catalog_items.expires_at is null or catalog_items.expires_at > now())"
    ];

    if (input.itemIds?.length) {
      values.push(input.itemIds);
      conditions.push(`catalog_items.id = any($${values.length}::uuid[])`);
    }

    if (input.itemKinds?.length) {
      values.push(input.itemKinds);
      conditions.push(`catalog_items.item_kind = any($${values.length}::text[])`);
    }
    if (input.domains?.length) {
      values.push(input.domains);
      conditions.push(`catalog_items.domain = any($${values.length}::text[])`);
    }
    if (input.allowedSourceKeys?.length) {
      values.push(input.allowedSourceKeys);
      conditions.push(`catalog_sources.source_key = any($${values.length}::text[])`);
    }
    const query = normalizeCatalogText(input.query ?? "");
    if (query) {
      values.push(`%${query}%`);
      values.push(`%${(input.query ?? "").normalize("NFKC").toLowerCase()}%`);
      conditions.push(
        `(catalog_items.normalized_title like $${values.length - 1}
          or lower(coalesce(catalog_items.path, '')) like $${values.length}
          or lower(catalog_items.item_kind) like $${values.length})`
      );
    }
    values.push(input.limit ?? 5);

    const result = await this.db.query<CatalogItemRow>(
      `
      select catalog_items.*,
        catalog_sources.id as source_id_join,
        catalog_sources.profile_name,
        catalog_sources.source_key,
        catalog_sources.adapter_type,
        catalog_sources.domain as source_domain,
        catalog_sources.default_item_kind,
        catalog_sources.root_location,
        catalog_sources.enabled,
        catalog_sources.sync_policy,
        catalog_sources.capabilities,
        catalog_sources.sync_cursor,
        catalog_sources.revision,
        catalog_sources.health_status,
        catalog_sources.last_attempt_at,
        catalog_sources.last_success_at,
        catalog_sources.last_failure_at,
        catalog_sources.last_error_code,
        catalog_sources.published_item_count
      from catalog_items
      join catalog_sources on catalog_sources.id = catalog_items.source_id
      where ${conditions.join("\n        and ")}
      order by catalog_items.title asc
      limit $${values.length}
      `,
      values
    );
    return result.rows.map(mapItem);
  }

  private async getItemById(id: string): Promise<CatalogItemRecord> {
    const result = await this.db.query<CatalogItemRow>(
      `
      select catalog_items.*,
        catalog_sources.id as source_id_join,
        catalog_sources.profile_name,
        catalog_sources.source_key,
        catalog_sources.adapter_type,
        catalog_sources.domain as source_domain,
        catalog_sources.default_item_kind,
        catalog_sources.root_location,
        catalog_sources.enabled,
        catalog_sources.sync_policy,
        catalog_sources.capabilities,
        catalog_sources.sync_cursor,
        catalog_sources.revision,
        catalog_sources.health_status,
        catalog_sources.last_attempt_at,
        catalog_sources.last_success_at,
        catalog_sources.last_failure_at,
        catalog_sources.last_error_code,
        catalog_sources.published_item_count
      from catalog_items
      join catalog_sources on catalog_sources.id = catalog_items.source_id
      where catalog_items.id = $1
      `,
      [id]
    );
    if (!result.rows[0]) {
      throw new Error(`catalog_item_not_found:${id}`);
    }
    return mapItem(result.rows[0]);
  }
}

function mapSource(row: CatalogSourceRow): CatalogSourceRecord {
  return {
    id: row.id,
    profileName: row.profile_name,
    sourceKey: row.source_key,
    adapterType: row.adapter_type as CatalogSourceRecord["adapterType"],
    domain: row.domain,
    defaultItemKind: row.default_item_kind,
    rootLocation: row.root_location,
    enabled: row.enabled,
    syncPolicy: row.sync_policy,
    capabilities: row.capabilities,
    syncCursor: row.sync_cursor ?? undefined,
    revision: row.revision,
    healthStatus: row.health_status,
    lastAttemptAt: optionalIso(row.last_attempt_at),
    lastSuccessAt: optionalIso(row.last_success_at),
    lastFailureAt: optionalIso(row.last_failure_at),
    lastErrorCode: row.last_error_code ?? undefined,
    publishedItemCount: Number(row.published_item_count)
  };
}

function mapItem(row: CatalogItemRow): CatalogItemRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    itemKind: row.item_kind,
    domain: row.domain,
    title: row.title,
    normalizedTitle: row.normalized_title,
    path: row.path ?? undefined,
    mimeType: row.mime_type ?? undefined,
    extension: row.extension ?? undefined,
    sizeBytes: row.size_bytes === null ? undefined : Number(row.size_bytes),
    sha256: row.sha256 ?? undefined,
    storageRef: row.storage_ref,
    externalUpdatedAt: row.external_updated_at
      ? new Date(row.external_updated_at).toISOString()
      : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : undefined,
    source: {
      id: row.source_id_join,
      profileName: row.profile_name,
      sourceKey: row.source_key,
      adapterType: row.adapter_type as CatalogSourceRecord["adapterType"],
      domain: row.source_domain,
      defaultItemKind: row.default_item_kind,
      rootLocation: row.root_location,
      enabled: row.enabled,
      syncPolicy: row.sync_policy,
      capabilities: row.capabilities,
      syncCursor: row.sync_cursor ?? undefined,
      revision: row.revision,
      healthStatus: row.health_status,
      lastAttemptAt: optionalIso(row.last_attempt_at),
      lastSuccessAt: optionalIso(row.last_success_at),
      lastFailureAt: optionalIso(row.last_failure_at),
      lastErrorCode: row.last_error_code ?? undefined,
      publishedItemCount: Number(row.published_item_count)
    }
  };
}

function publicationItem(input: CatalogItemInput) {
  return {
    id: randomUUID(),
    itemKind: input.itemKind,
    domain: input.domain,
    title: input.title,
    normalizedTitle: input.normalizedTitle ?? normalizeCatalogText(input.title),
    path: input.path ?? null,
    mimeType: input.mimeType ?? null,
    extension: input.extension ?? null,
    sizeBytes: input.sizeBytes ?? null,
    sha256: input.sha256 ?? null,
    storageRef: input.storageRef,
    storageIdentity: catalogStorageIdentity(input.storageRef),
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    expiresAt: input.expiresAt ?? null
  };
}

function assertPublicationScope(sourceId: string, items: CatalogItemInput[]): void {
  if (items.some((item) => item.sourceId !== sourceId)) {
    throw new Error("Catalog publication item scope does not match source");
  }
}

function optionalIso(value: Date | string | null): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}
