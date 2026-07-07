export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

const migrations = [
  `
  create table if not exists agent_resources (
    id uuid primary key,
    profile_name text not null,
    scope_type text not null check (scope_type in ('user', 'group', 'room')),
    scope_id text not null,
    resource_type text not null check (resource_type in ('ppt_slide', 'sheet_music')),
    title text not null,
    query_text text,
    storage_provider text not null check (storage_provider in ('graph', 'external_link')),
    drive_id text,
    item_id text,
    external_url text,
    source_label text,
    description text,
    created_by text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    deleted_at timestamptz
  )
  `,
  `
  alter table agent_resources
    alter column drive_id drop not null,
    alter column item_id drop not null
  `,
  `
  alter table agent_resources
    add column if not exists external_url text,
    add column if not exists source_label text,
    add column if not exists description text
  `,
  `
  alter table agent_resources
    drop constraint if exists agent_resources_storage_provider_check
  `,
  `
  alter table agent_resources
    add constraint agent_resources_storage_provider_check
    check (storage_provider in ('graph', 'external_link'))
  `,
  `
  alter table agent_resources
    drop constraint if exists agent_resources_storage_shape_check
  `,
  `
  alter table agent_resources
    add constraint agent_resources_storage_shape_check
    check (
      (storage_provider = 'graph' and drive_id is not null and item_id is not null)
      or
      (storage_provider = 'external_link' and external_url is not null)
    )
  `,
  `
  create index if not exists agent_resources_lookup_idx
  on agent_resources (profile_name, scope_type, scope_id, resource_type, created_at desc)
  where deleted_at is null
  `,
  `
  create table if not exists agent_resource_aliases (
    id uuid primary key,
    profile_name text not null,
    scope_type text not null check (scope_type in ('user', 'group', 'room')),
    scope_id text not null,
    alias text not null,
    normalized_alias text not null,
    resource_id uuid not null references agent_resources(id) on delete cascade,
    created_by text,
    created_at timestamptz not null default now()
  )
  `,
  `
  create index if not exists agent_resource_aliases_lookup_idx
  on agent_resource_aliases (profile_name, scope_type, scope_id, normalized_alias, created_at desc)
  `,
  `
  create table if not exists agent_text_memories (
    id uuid primary key,
    profile_name text not null,
    scope_type text not null check (scope_type in ('user', 'group', 'room')),
    scope_id text not null,
    title text,
    content text not null,
    query_text text,
    created_by text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    deleted_at timestamptz
  )
  `,
  `
  create index if not exists agent_text_memories_lookup_idx
  on agent_text_memories (profile_name, scope_type, scope_id, created_at desc)
  where deleted_at is null
  `
];

export async function runAgentMemoryMigrations(db: Queryable): Promise<void> {
  for (const migration of migrations) {
    await db.query(migration);
  }
}
