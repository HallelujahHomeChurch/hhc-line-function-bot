export type MediaSyncMigrationTarget = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

const migrations = [
  `
  create table if not exists media_sync_bindings (
    id uuid primary key,
    profile_name text not null,
    group_id text not null,
    collection_id text not null,
    group_display_name text not null,
    bound_by_line_user_id text,
    binding_code_created_by_hhc_user_id text not null,
    bound_at timestamptz not null,
    disabled_at timestamptz
  )
  `,
  `
  create unique index if not exists media_sync_bindings_active_group_idx
  on media_sync_bindings (profile_name, group_id)
  where disabled_at is null
  `,
  `
  create unique index if not exists media_sync_bindings_active_collection_idx
  on media_sync_bindings (collection_id)
  where disabled_at is null
  `,
  `
  create table if not exists media_sync_binding_codes (
    id uuid primary key,
    profile_name text not null,
    collection_id text not null,
    code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
    created_by_hhc_user_id text not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    consumed_group_id text,
    check ((consumed_at is null) = (consumed_group_id is null))
  )
  `,
  `
  create index if not exists media_sync_binding_codes_collection_idx
  on media_sync_binding_codes (profile_name, collection_id, expires_at)
  where consumed_at is null
  `,
  `
  create table if not exists media_sync_ingests (
    source_key text primary key,
    profile_name text not null,
    message_id text not null,
    group_id text not null,
    collection_id text not null,
    asset_id text,
    state text not null check (state in ('pending', 'processing', 'ready', 'failed', 'tombstoned')),
    display_name text not null,
    media_kind text not null check (media_kind in ('image', 'video', 'audio', 'file')),
    expected_mime text not null,
    size_bytes bigint check (size_bytes is null or size_bytes >= 0),
    checksum_sha256 text check (
      checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
    tombstoned_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((state = 'tombstoned') = (tombstoned_at is not null))
  )
  `,
  `
  create table if not exists media_sync_publications (
    source_key text not null references media_sync_ingests(source_key) on delete cascade,
    publication_type text not null check (publication_type in ('collection', 'manual')),
    target_id text not null,
    state text not null check (state in ('pending', 'published', 'revoked')),
    updated_at timestamptz not null default now(),
    primary key (source_key, publication_type, target_id)
  )
  `,
  `
  create table if not exists media_sync_outbox (
    source_key text not null references media_sync_ingests(source_key) on delete cascade,
    operation text not null check (operation in ('intake', 'delete')),
    attempts integer not null default 0 check (attempts >= 0),
    available_at timestamptz not null default now(),
    claimed_until timestamptz,
    completed_at timestamptz,
    last_error_category text,
    primary key (source_key, operation)
  )
  `,
  `
  create index if not exists media_sync_outbox_claim_idx
  on media_sync_outbox (available_at, claimed_until)
  where completed_at is null
  `
];

export async function runMediaSyncMigrations(db: MediaSyncMigrationTarget): Promise<void> {
  for (const migration of migrations) await db.query(migration);
}
