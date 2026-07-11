export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

const migrations = [
  `
  create table if not exists schedule_items (
    id uuid primary key,
    profile_name text not null,
    source_key text not null,
    origin text not null check (origin in ('notion', 'line')),
    external_id text,
    service_date date not null,
    meeting text not null default '',
    role text not null default '',
    assignee text not null default '',
    notes text,
    normalized_search_text text not null,
    schedule_identity text not null,
    external_updated_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    unique (profile_name, source_key, schedule_identity)
  )
  `,
  `
  create index if not exists schedule_items_lookup_idx
  on schedule_items (profile_name, source_key, service_date, normalized_search_text)
  where deleted_at is null
  `,
  `
  create index if not exists schedule_items_origin_idx
  on schedule_items (profile_name, source_key, origin)
  where deleted_at is null
  `
];

export async function runScheduleMigrations(db: Queryable): Promise<void> {
  for (const migration of migrations) {
    await db.query(migration);
  }
}
