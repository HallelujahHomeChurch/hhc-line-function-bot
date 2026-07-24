import { knowledgeSectionKey } from "./section-key.js";

export interface KnowledgeQueryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

const migrations = [
  `
  create table if not exists knowledge_sources (
    id uuid primary key,
    profile_name text not null,
    source_key text not null,
    display_name text not null,
    adapter_type text not null,
    external_root_id text not null,
    root_url text not null,
    staged_display_name text not null,
    staged_adapter_type text not null,
    staged_external_root_id text not null,
    staged_root_url text not null,
    staged_enabled boolean not null,
    staged_expires_at timestamptz,
    staging_revision uuid not null,
    staging_initialized boolean not null default true,
    admin_aliases text[] not null default '{}',
    admin_topics text[] not null default '{}',
    admin_sample_queries text[] not null default '{}',
    routing_display_name text,
    aliases text[] not null default '{}',
    topics text[] not null default '{}',
    sample_queries text[] not null default '{}',
    enabled boolean not null default false,
    expires_at timestamptz,
    disabled_at timestamptz,
    purge_after timestamptz,
    last_synced_at timestamptz,
    sync_status text not null default 'pending',
    sync_error_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (profile_name, source_key)
  )
  `,
  `alter table knowledge_sources add column if not exists aliases text[] not null default '{}'`,
  `alter table knowledge_sources add column if not exists topics text[] not null default '{}'`,
  `alter table knowledge_sources add column if not exists sample_queries text[] not null default '{}'`,
  `alter table knowledge_sources add column if not exists admin_aliases text[] not null default '{}'`,
  `alter table knowledge_sources add column if not exists admin_topics text[] not null default '{}'`,
  `alter table knowledge_sources add column if not exists admin_sample_queries text[] not null default '{}'`,
  `alter table knowledge_sources add column if not exists routing_display_name text`,
  `alter table knowledge_sources add column if not exists staged_display_name text`,
  `alter table knowledge_sources add column if not exists staged_adapter_type text`,
  `alter table knowledge_sources add column if not exists staged_external_root_id text`,
  `alter table knowledge_sources add column if not exists staged_root_url text`,
  `alter table knowledge_sources add column if not exists staged_enabled boolean`,
  `alter table knowledge_sources add column if not exists staged_expires_at timestamptz`,
  `alter table knowledge_sources add column if not exists staging_revision uuid`,
  `alter table knowledge_sources add column if not exists staging_initialized boolean not null default false`,
  `update knowledge_sources set
     staged_display_name=display_name,
     staged_adapter_type=adapter_type,
     staged_external_root_id=external_root_id,
     staged_root_url=root_url,
     staged_enabled=enabled,
     staged_expires_at=expires_at,
     staging_revision=coalesce(staging_revision,gen_random_uuid()),
     staging_initialized=true
     where staging_initialized=false`,
  `alter table knowledge_sources alter column staging_initialized set default true`,
  `alter table knowledge_sources alter column staged_display_name set not null`,
  `alter table knowledge_sources alter column staged_adapter_type set not null`,
  `alter table knowledge_sources alter column staged_external_root_id set not null`,
  `alter table knowledge_sources alter column staged_root_url set not null`,
  `alter table knowledge_sources alter column staged_enabled set not null`,
  `alter table knowledge_sources alter column staging_revision set not null`,
  `update knowledge_sources set routing_display_name=display_name where last_synced_at is not null and routing_display_name is null`,
  `
  create table if not exists knowledge_documents (
    id uuid primary key,
    source_id uuid not null references knowledge_sources(id) on delete cascade,
    external_id text not null,
    title text not null,
    url text not null,
    properties jsonb not null default '{}'::jsonb,
    external_updated_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (source_id, external_id)
  )
  `,
  `
  create table if not exists knowledge_nodes (
    id uuid primary key,
    document_id uuid not null references knowledge_documents(id) on delete cascade,
    external_id text not null,
    parent_external_id text,
    node_type text not null,
    ordinal integer not null,
    text_content text not null,
    metadata jsonb not null default '{}'::jsonb,
    unique (document_id, external_id)
  )
  `,
  `
  create table if not exists knowledge_chunks (
    id uuid primary key,
    document_id uuid not null references knowledge_documents(id) on delete cascade,
    heading_path text[] not null default '{}',
    section_key text not null,
    ordinal integer not null,
    content text not null,
    content_hash text not null,
    metadata jsonb not null default '{}'::jsonb,
    search_vector tsvector generated always as (to_tsvector('simple', content)) stored,
    active boolean not null default true,
    unique (document_id, content_hash)
  )
  `,
  `alter table knowledge_chunks add column if not exists section_key text`,
  `
  create table if not exists knowledge_embeddings (
    chunk_id uuid not null references knowledge_chunks(id) on delete cascade,
    provider text not null,
    model text not null,
    dimensions integer not null check (dimensions = 1536),
    embedding vector(1536) not null,
    content_hash text not null,
    embedded_at timestamptz not null default now(),
    primary key (chunk_id, provider, model)
  )
  `,
  `create index if not exists knowledge_sources_active_idx on knowledge_sources (profile_name, source_key) where enabled = true`,
  `create index if not exists knowledge_chunks_search_idx on knowledge_chunks using gin (search_vector) where active = true`,
  `create index if not exists knowledge_embeddings_cosine_idx on knowledge_embeddings using hnsw (embedding vector_cosine_ops)`,
  `
  do $$
  begin
    if exists (
      select 1 from pg_attribute a
      join pg_class c on c.oid=a.attrelid
      where c.relname='knowledge_embeddings' and a.attname='embedding'
        and format_type(a.atttypid,a.atttypmod)='vector(1024)'
    ) then
      delete from knowledge_embeddings;
      delete from knowledge_chunks;
      delete from knowledge_documents;
      drop index if exists knowledge_embeddings_cosine_idx;
      alter table knowledge_embeddings drop constraint if exists knowledge_embeddings_dimensions_check;
      alter table knowledge_embeddings alter column embedding type vector(1536);
      alter table knowledge_embeddings add constraint knowledge_embeddings_dimensions_check
        check (dimensions = 1536);
      create index knowledge_embeddings_cosine_idx
        on knowledge_embeddings using hnsw (embedding vector_cosine_ops);
      update knowledge_sources set last_synced_at=null, sync_status='pending',
        sync_error_code=null, routing_display_name=null;
    end if;
  end $$
  `
];

export async function runKnowledgeMigrations(db: KnowledgeQueryable): Promise<void> {
  for (const migration of migrations) {
    await db.query(migration);
  }
  const rows = (await db.query(
    "select id, heading_path from knowledge_chunks where section_key is null"
  )) as { rows?: Array<{ id?: unknown; heading_path?: unknown }> };
  for (const row of rows.rows ?? []) {
    if (typeof row.id !== "string" || !Array.isArray(row.heading_path)) continue;
    const headingPath = row.heading_path.filter(
      (heading): heading is string => typeof heading === "string"
    );
    await db.query("update knowledge_chunks set section_key=$2 where id=$1", [
      row.id,
      knowledgeSectionKey(headingPath)
    ]);
  }
  await db.query("alter table knowledge_chunks alter column section_key set not null");
}

export async function verifyPgvector(db: KnowledgeQueryable): Promise<void> {
  const result = (await db.query(
    "select extversion from pg_extension where extname = 'vector'"
  )) as { rows?: unknown[] };
  if (!result.rows?.length) {
    throw new Error("pgvector_extension_missing");
  }
}
