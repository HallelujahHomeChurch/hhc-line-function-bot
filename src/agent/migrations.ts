interface MigrationExecutor {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

export interface Queryable extends MigrationExecutor {
  connect?(): Promise<MigrationClient>;
}

interface MigrationClient extends MigrationExecutor {
  release(): void;
}

const migrations = [
  `
  create table if not exists agent_resources (
    id uuid primary key,
    profile_name text not null,
    scope_type text not null check (scope_type in ('user', 'group', 'room')),
    scope_id text not null,
    resource_type text not null check (
      resource_type in ('ppt_slide', 'sheet_music', 'general_resource')
    ),
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
    drop constraint if exists agent_resources_resource_type_check,
    add constraint agent_resources_resource_type_check
    check (resource_type in ('ppt_slide', 'sheet_music', 'general_resource'))
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
    drop constraint if exists agent_resources_storage_provider_check,
    add constraint agent_resources_storage_provider_check
    check (storage_provider in ('graph', 'external_link'))
  `,
  `
  alter table agent_resources
    drop constraint if exists agent_resources_storage_shape_check,
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
  `,
  `
  create table if not exists agent_schedule_memories (
    id uuid primary key,
    profile_name text not null,
    scope_type text not null check (scope_type in ('user', 'group', 'room')),
    scope_id text not null,
    schedule_type text not null check (
      schedule_type in ('morning_prayer_family', 'street_sign_service', 'custom_service_schedule')
    ),
    title text not null,
    original_text text not null,
    created_by text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    deleted_at timestamptz
  )
  `,
  `
  alter table agent_schedule_memories
    drop constraint if exists agent_schedule_memories_schedule_type_check
  `,
  `
  create index if not exists agent_schedule_memories_lookup_idx
  on agent_schedule_memories (profile_name, scope_type, scope_id, schedule_type, created_at desc)
  where deleted_at is null
  `,
  `
  create table if not exists agent_schedule_entries (
    id uuid primary key,
    schedule_memory_id uuid not null references agent_schedule_memories(id) on delete cascade,
    service_date date not null,
    weekday text,
    meeting_name text not null,
    role text,
    assignee text not null,
    family_name text,
    notes text,
    created_at timestamptz not null default now()
  )
  `,
  `
  create index if not exists agent_schedule_entries_lookup_idx
  on agent_schedule_entries (service_date, meeting_name)
  `,
  `
  alter table agent_resources
    add column if not exists visibility text not null default 'private'
  `,
  `
  alter table agent_text_memories
    add column if not exists visibility text not null default 'private'
  `,
  `
  alter table agent_schedule_memories
    add column if not exists visibility text not null default 'private'
  `,
  `
  alter table agent_resources
    drop constraint if exists agent_resources_visibility_check,
    add constraint agent_resources_visibility_check check (visibility in ('private', 'group'))
  `,
  `
  alter table agent_text_memories
    drop constraint if exists agent_text_memories_visibility_check,
    add constraint agent_text_memories_visibility_check check (visibility in ('private', 'group'))
  `,
  `
  alter table agent_schedule_memories
    drop constraint if exists agent_schedule_memories_scope_type_check,
    add constraint agent_schedule_memories_scope_type_check
    check (scope_type in ('user', 'group', 'room', 'profile'))
  `,
  `
  alter table agent_schedule_memories
    drop constraint if exists agent_schedule_memories_visibility_check,
    add constraint agent_schedule_memories_visibility_check
    check (visibility in ('private', 'group', 'profile'))
  `,
  `
  alter table agent_schedule_memories
    add column if not exists period_key text
  `,
  `
  create unique index if not exists agent_schedule_memories_active_period_idx
  on agent_schedule_memories (profile_name, schedule_type, period_key)
  where deleted_at is null and period_key is not null
  `,
  `
  alter table agent_schedule_entries
    add column if not exists updated_at timestamptz not null default now(),
    add column if not exists deleted_at timestamptz
  `,
  `
  alter table agent_text_memories
    add column if not exists embedding vector(1536)
  `,
  `
  create index if not exists agent_text_memories_search_idx
  on agent_text_memories using gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || content || ' ' || coalesce(query_text, ''))
  )
  where deleted_at is null
  `,
  `
  create index if not exists agent_text_memories_embedding_idx
  on agent_text_memories using hnsw (embedding vector_cosine_ops)
  where deleted_at is null and embedding is not null
  `,
  `
  do $$
  begin
    if exists (
      select 1 from pg_attribute a
      join pg_class c on c.oid=a.attrelid
      where c.relname='agent_text_memories' and a.attname='embedding'
        and format_type(a.atttypid,a.atttypmod)='vector(1024)'
    ) then
      drop index if exists agent_text_memories_embedding_idx;
      update agent_text_memories set embedding=null where embedding is not null;
      alter table agent_text_memories alter column embedding type vector(1536);
      create index agent_text_memories_embedding_idx
        on agent_text_memories using hnsw (embedding vector_cosine_ops)
        where deleted_at is null and embedding is not null;
    end if;
  end $$
  `,
  `
  alter table agent_resources
    add column if not exists identity_key text,
    add column if not exists verified_at timestamptz,
    add column if not exists source_revision text,
    add column if not exists tombstoned_at timestamptz
  `,
  `
  update agent_resources
  set identity_key = coalesce(
        identity_key,
        encode(convert_to(storage_provider, 'UTF8'), 'base64') || ':' ||
        encode(convert_to(coalesce(drive_id, external_url, ''), 'UTF8'), 'base64') || ':' ||
        encode(convert_to(coalesce(item_id, ''), 'UTF8'), 'base64') || ':' ||
        encode(convert_to(coalesce(created_by, ''), 'UTF8'), 'base64')
      ),
      verified_at = coalesce(verified_at, created_at)
  where identity_key is null or verified_at is null
  `,
  `
  delete from agent_resources older
  using agent_resources newer
  where older.profile_name = newer.profile_name
    and older.scope_type = newer.scope_type
    and older.scope_id = newer.scope_id
    and older.resource_type = newer.resource_type
    and older.identity_key = newer.identity_key
    and (older.verified_at, older.id) < (newer.verified_at, newer.id)
  `,
  `
  alter table agent_resources
    alter column identity_key set not null,
    alter column verified_at set not null
  `,
  `
  create unique index if not exists agent_resources_identity_idx
  on agent_resources (profile_name, scope_type, scope_id, resource_type, identity_key)
  `,
  `
  delete from agent_resource_aliases
  `
];

export async function runAgentMemoryMigrations(db: Queryable): Promise<void> {
  if (!db.connect) {
    for (const migration of migrations) {
      await db.query(migration);
    }
    return;
  }

  const client = await db.connect();
  let began = false;
  try {
    await client.query("begin");
    began = true;
    await client.query("select pg_advisory_xact_lock(144757, 1)");
    for (const migration of migrations) {
      await client.query(migration);
    }
    await client.query("commit");
  } catch (error) {
    if (began) await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
