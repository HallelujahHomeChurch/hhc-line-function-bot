export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

const migrations = [
  `
  create table if not exists access_principals (
    id uuid primary key,
    profile_name text not null,
    principal_type text not null check (principal_type in ('admin', 'user', 'group')),
    principal_id text not null,
    display_name text,
    created_at timestamptz not null default now(),
    created_by text not null,
    disabled_at timestamptz,
    disabled_by text,
    last_success_function_name text,
    last_success_at timestamptz,
    unique (profile_name, principal_type, principal_id)
  )
  `,
  `
  alter table access_principals
    add column if not exists last_success_function_name text,
    add column if not exists last_success_at timestamptz
  `,
  `
  create table if not exists access_audit_events (
    id uuid primary key,
    profile_name text not null,
    actor_user_id text not null,
    action text not null,
    target_type text,
    target_id text,
    metadata jsonb,
    created_at timestamptz not null default now()
  )
  `,
  `
  create table if not exists access_group_function_grants (
    id uuid primary key,
    profile_name text not null,
    group_id text not null,
    function_name text not null,
    created_at timestamptz not null default now(),
    created_by text not null,
    disabled_at timestamptz,
    disabled_by text,
    unique (profile_name, group_id, function_name)
  )
  `,
  `
  create table if not exists access_user_function_grants (
    id uuid primary key,
    profile_name text not null,
    user_id text not null,
    function_name text not null,
    created_at timestamptz not null default now(),
    created_by text not null,
    disabled_at timestamptz,
    disabled_by text,
    unique (profile_name, user_id, function_name)
  )
  `,
  `
  create table if not exists access_roles (
    id uuid primary key,
    profile_name text not null,
    role_key text not null,
    display_name text not null,
    created_at timestamptz not null default now(),
    unique (profile_name, role_key),
    unique (id, profile_name)
  )
  `,
  `
  create table if not exists access_role_capability_bindings (
    role_id uuid not null references access_roles(id) on delete cascade,
    capability text not null,
    created_at timestamptz not null default now(),
    primary key (role_id, capability)
  )
  `,
  `
  create table if not exists access_principal_role_bindings (
    id uuid primary key,
    profile_name text not null,
    principal_type text not null check (principal_type in ('user', 'group')),
    principal_id text not null,
    role_id uuid not null,
    created_at timestamptz not null default now(),
    unique (profile_name, principal_type, principal_id, role_id),
    foreign key (role_id, profile_name) references access_roles(id, profile_name) on delete cascade
  )
  `,
  ...["access_group_function_grants", "access_user_function_grants"].flatMap((table) => [
    `
    with capability_mapping(old_name, new_name) as (
      values
        ('query_service_schedule', 'query_schedule'),
        ('find_pop_sheet_music', 'find_sheet_music'),
        ('save_schedule_memory', 'save_schedule'),
        ('query_schedule_memory', 'query_schedule')
    )
    delete from ${table} legacy
    using capability_mapping mapping, ${table} canonical
    where legacy.function_name = mapping.old_name
      and canonical.function_name = mapping.new_name
      and canonical.profile_name = legacy.profile_name
      and canonical.${table === "access_group_function_grants" ? "group_id" : "user_id"} =
        legacy.${table === "access_group_function_grants" ? "group_id" : "user_id"}
    `,
    `
    with capability_mapping(old_name, new_name) as (
      values
        ('query_service_schedule', 'query_schedule'),
        ('find_pop_sheet_music', 'find_sheet_music'),
        ('save_schedule_memory', 'save_schedule'),
        ('query_schedule_memory', 'query_schedule')
    )
    update ${table} grants
    set function_name = mapping.new_name
    from capability_mapping mapping
    where grants.function_name = mapping.old_name
    `
  ]),
  `
  with capability_mapping(old_name, new_name) as (
    values
      ('query_service_schedule', 'query_schedule'),
      ('find_pop_sheet_music', 'find_sheet_music'),
      ('save_schedule_memory', 'save_schedule'),
      ('query_schedule_memory', 'query_schedule')
  )
  delete from access_role_capability_bindings legacy
  using capability_mapping mapping, access_role_capability_bindings canonical
  where legacy.capability = mapping.old_name
    and canonical.capability = mapping.new_name
    and canonical.role_id = legacy.role_id
  `,
  `
  with capability_mapping(old_name, new_name) as (
    values
      ('query_service_schedule', 'query_schedule'),
      ('find_pop_sheet_music', 'find_sheet_music'),
      ('save_schedule_memory', 'save_schedule'),
      ('query_schedule_memory', 'query_schedule')
  )
  update access_role_capability_bindings bindings
  set capability = mapping.new_name
  from capability_mapping mapping
  where bindings.capability = mapping.old_name
  `
];

export async function runAccessMigrations(db: Queryable): Promise<void> {
  for (const migration of migrations) {
    await db.query(migration);
  }
}
