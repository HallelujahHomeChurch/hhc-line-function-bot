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
  alter table media_sync_binding_codes
  add column if not exists request_key_hash text
  check (request_key_hash is null or request_key_hash ~ '^[0-9a-f]{64}$')
  `,
  `
  create unique index if not exists media_sync_binding_codes_request_fence_idx
  on media_sync_binding_codes (
    created_by_hhc_user_id,
    profile_name,
    collection_id,
    request_key_hash
  )
  where request_key_hash is not null
  `,
  `
  create index if not exists media_sync_binding_codes_collection_idx
  on media_sync_binding_codes (profile_name, collection_id, expires_at)
  where consumed_at is null
  `,
  `
  create table if not exists media_sync_collection_deletions (
    collection_id text primary key,
    profile_name text not null,
    started_at timestamptz not null,
    completed_at timestamptz
  )
  `,
  `
  create table if not exists media_sync_source_tombstones (
    source_key text primary key,
    tombstoned_at timestamptz not null
  )
  `,
  `
  create table if not exists media_sync_ingests (
    source_key text primary key,
    work_id uuid not null default gen_random_uuid() unique,
    profile_name text not null,
    message_id text not null,
    group_id text not null,
    collection_id text not null,
    asset_id text,
    asset_etag text,
    state text not null check (
      state in ('pending', 'processing', 'awaiting_scan', 'ready', 'failed', 'tombstoned')
    ),
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
  `alter table media_sync_ingests add column if not exists work_id uuid default gen_random_uuid()`,
  `alter table media_sync_ingests alter column work_id set not null`,
  `create unique index if not exists media_sync_ingests_work_id_idx on media_sync_ingests(work_id)`,
  `alter table media_sync_ingests add column if not exists asset_etag text`,
  `alter table media_sync_ingests drop constraint if exists media_sync_ingests_state_check`,
  `
  alter table media_sync_ingests add constraint media_sync_ingests_state_check
  check (state in ('pending', 'processing', 'awaiting_scan', 'ready', 'failed', 'tombstoned'))
  `,
  `
  create table if not exists media_sync_publications (
    source_key text not null references media_sync_ingests(source_key) on delete cascade,
    publication_type text not null check (publication_type in ('collection', 'manual')),
    destination_id text not null,
    target_id text,
    state text not null check (state in ('pending', 'published', 'failed', 'revoked')),
    failure_category text,
    requester_user_id text,
    job_id text,
    manual_source_key text,
    manual_item_kind text,
    manual_domain text,
    manual_title text,
    updated_at timestamptz not null default now(),
    primary key (source_key, publication_type)
  )
  `,
  `alter table media_sync_publications add column if not exists destination_id text`,
  `
  update media_sync_publications publication
  set destination_id=case
    when publication.publication_type='collection' then ingest.collection_id
    else publication.target_id
  end
  from media_sync_ingests ingest
  where publication.source_key=ingest.source_key and publication.destination_id is null
  `,
  `alter table media_sync_publications alter column destination_id set not null`,
  `alter table media_sync_publications alter column target_id drop not null`,
  `alter table media_sync_publications add column if not exists failure_category text`,
  `alter table media_sync_publications add column if not exists requester_user_id text`,
  `alter table media_sync_publications add column if not exists job_id text`,
  `alter table media_sync_publications add column if not exists manual_source_key text`,
  `alter table media_sync_publications add column if not exists manual_item_kind text`,
  `alter table media_sync_publications add column if not exists manual_domain text`,
  `alter table media_sync_publications add column if not exists manual_title text`,
  `alter table media_sync_publications drop constraint if exists media_sync_publications_state_check`,
  `
  alter table media_sync_publications add constraint media_sync_publications_state_check
  check (state in ('pending', 'published', 'failed', 'revoked'))
  `,
  `alter table media_sync_publications drop constraint if exists media_sync_publications_pkey`,
  `
  alter table media_sync_publications
  add constraint media_sync_publications_pkey primary key (source_key, publication_type)
  `,
  `
  create table if not exists media_sync_outbox (
    source_key text not null references media_sync_ingests(source_key) on delete cascade,
    operation text not null check (operation in ('intake', 'delete')),
    attempts integer not null default 0 check (attempts >= 0),
    available_at timestamptz not null default now(),
    claimed_until timestamptz,
    dispatched_at timestamptz,
    completed_at timestamptz,
    last_error_category text,
    primary key (source_key, operation)
  )
  `,
  `alter table media_sync_outbox add column if not exists dispatched_at timestamptz`,
  `
  create index if not exists media_sync_outbox_claim_idx
  on media_sync_outbox (available_at, claimed_until)
  where completed_at is null
  `
];

export async function runMediaSyncMigrations(db: MediaSyncMigrationTarget): Promise<void> {
  for (const migration of migrations) await db.query(migration);
}
