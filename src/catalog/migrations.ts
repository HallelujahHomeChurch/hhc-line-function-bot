export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

const migrations = [
  `
  create table if not exists catalog_sources (
    id uuid primary key,
    profile_name text not null,
    source_key text not null,
    adapter_type text not null,
    domain text not null,
    default_item_kind text not null,
    root_location jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    sync_policy jsonb not null default '{}'::jsonb,
    capabilities jsonb not null default '{"read":[],"write":[]}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (profile_name, source_key)
  )
  `,
  `
  create table if not exists catalog_items (
    id uuid primary key,
    source_id uuid not null references catalog_sources(id) on delete cascade,
    item_kind text not null,
    domain text not null,
    title text not null,
    normalized_title text not null,
    path text,
    mime_type text,
    extension text,
    size_bytes bigint,
    sha256 text,
    storage_ref jsonb not null,
    storage_identity text not null,
    external_updated_at timestamptz,
    expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    unique (source_id, storage_identity)
  )
  `,
  `
  alter table catalog_items
  add column if not exists expires_at timestamptz
  `,
  `
  create index if not exists catalog_items_lookup_idx
  on catalog_items (source_id, item_kind, domain, normalized_title)
  where deleted_at is null
  `,
  `
  create index if not exists catalog_sources_profile_idx
  on catalog_sources (profile_name, source_key)
  where enabled = true
  `
];

export async function runCatalogMigrations(db: Queryable): Promise<void> {
  for (const migration of migrations) {
    await db.query(migration);
  }
}
