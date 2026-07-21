import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { runAccessMigrations } from "../access/migrations.js";
import { runAgentMemoryMigrations } from "../agent/migrations.js";
import { PostgresAgentMemoryStore } from "../agent/postgres-memory-store.js";
import { runCatalogMigrations } from "../catalog/migrations.js";
import { PostgresCatalogStore } from "../catalog/postgres-store.js";
import {
  createKernelPostgresEnvironment,
  type KernelPostgresEnvironment
} from "../evals/kernel/integration/environment.js";
import { runPostgresIntegrationMatrix } from "../evals/kernel/integration/postgres-matrix.js";
import { runKnowledgeMigrations } from "../knowledge/migrations.js";
import { runScheduleMigrations } from "../schedules/migrations.js";
import { PostgresScheduleStore } from "../schedules/postgres-store.js";

describe("Kernel v1 PostgreSQL integration environment", () => {
  let environment: KernelPostgresEnvironment | undefined;

  afterAll(async () => {
    await environment?.cleanup();
  });

  it("requires an explicit PostgreSQL URL", async () => {
    const previous = process.env.KERNEL_POSTGRES_URL;
    delete process.env.KERNEL_POSTGRES_URL;
    try {
      await expect(createKernelPostgresEnvironment()).rejects.toThrow(
        "kernel_integration_postgres_url_required"
      );
    } finally {
      if (previous === undefined) delete process.env.KERNEL_POSTGRES_URL;
      else process.env.KERNEL_POSTGRES_URL = previous;
    }
  });

  it("owns two pools in one isolated pgvector-ready schema", async () => {
    environment = await createKernelPostgresEnvironment();
    const [left, right] = environment.pools;
    const [leftSchema, rightSchema, vector] = await Promise.all([
      left.query<{ schema: string }>("select current_schema() schema"),
      right.query<{ schema: string }>("select current_schema() schema"),
      left.query<{ extversion: string }>(
        "select extversion from pg_extension where extname='vector'"
      )
    ]);

    expect(environment.schemaName).toMatch(/^kernel_v1_[a-f0-9]{32}$/);
    expect(leftSchema.rows[0]?.schema).toBe(environment.schemaName);
    expect(rightSchema.rows[0]?.schema).toBe(environment.schemaName);
    expect(vector.rows).toHaveLength(1);
  });

  it("drops only its isolated schema during cleanup", async () => {
    const disposable = await createKernelPostgresEnvironment();
    const schemaName = disposable.schemaName;
    await disposable.cleanup();
    const observer = new Pool({ connectionString: process.env.KERNEL_POSTGRES_URL });
    try {
      const result = await observer.query<{ schema_name: string | null }>(
        "select to_regnamespace($1)::text schema_name",
        [schemaName]
      );
      expect(result.rows[0]?.schema_name).toBeNull();
      expect(
        (await observer.query<{ schema_name: string }>("select current_schema() schema_name"))
          .rows[0]?.schema_name
      ).toBe("public");
    } finally {
      await observer.end();
    }
  });

  it("migrates supported previous schemas twice without data loss", async () => {
    const [pool, concurrentPool] = requiredEnvironment(environment).pools;
    const scheduleId = randomUUID();
    const sourceId = randomUUID();
    const itemId = randomUUID();
    const resourceId = randomUUID();

    await pool.query(`
      create table schedule_items (
        id uuid primary key, profile_name text not null, source_key text not null,
        origin text not null check (origin in ('notion','line')), external_id text,
        service_date date not null, meeting text not null default '', role text not null default '',
        assignee text not null default '', notes text, normalized_search_text text not null,
        schedule_identity text not null, external_updated_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, unique(profile_name,source_key,schedule_identity)
      );
      insert into schedule_items
        (id,profile_name,source_key,origin,external_id,service_date,meeting,role,assignee,
         normalized_search_text,schedule_identity)
      values ('${scheduleId}','helper','legacy-schedule','notion','legacy-event','2026-07-22',
              'Legacy meeting','audio','member','legacy meeting audio member','legacy-identity');

      create table catalog_sources (
        id uuid primary key, profile_name text not null, source_key text not null,
        adapter_type text not null, domain text not null, default_item_kind text not null,
        root_location jsonb not null default '{}'::jsonb, enabled boolean not null default true,
        sync_policy jsonb not null default '{}'::jsonb,
        capabilities jsonb not null default '{"read":[],"write":[]}'::jsonb,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        unique(profile_name,source_key)
      );
      create table catalog_items (
        id uuid primary key, source_id uuid not null references catalog_sources(id) on delete cascade,
        item_kind text not null, domain text not null, title text not null,
        normalized_title text not null, path text, mime_type text, extension text,
        size_bytes bigint, sha256 text, storage_ref jsonb not null,
        storage_identity text not null, external_updated_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, unique(source_id,storage_identity)
      );
      insert into catalog_sources
        (id,profile_name,source_key,adapter_type,domain,default_item_kind)
      values ('${sourceId}','helper','legacy-catalog','manual','general','document');
      insert into catalog_items
        (id,source_id,item_kind,domain,title,normalized_title,storage_ref,storage_identity)
      values ('${itemId}','${sourceId}','document','general','Legacy resource','legacyresource',
              '{"provider":"external_link","url":"https://example.invalid/legacy"}',
              'external:https://example.invalid/legacy');

      create table agent_resources (
        id uuid primary key, profile_name text not null,
        scope_type text not null check (scope_type in ('user','group','room')), scope_id text not null,
        resource_type text not null check (resource_type in ('ppt_slide','sheet_music')),
        title text not null, query_text text,
        storage_provider text not null check (storage_provider in ('graph','external_link')),
        drive_id text, item_id text, external_url text, source_label text, description text,
        created_by text, created_at timestamptz not null default now(),
        expires_at timestamptz not null, deleted_at timestamptz
      );
      insert into agent_resources
        (id,profile_name,scope_type,scope_id,resource_type,title,storage_provider,drive_id,item_id,expires_at)
      values ('${resourceId}','helper','user','legacy-user','ppt_slide','Legacy slides',
              'graph','legacy-drive','legacy-item',now()+interval '1 day');
    `);

    await Promise.all([runAgentMemoryMigrations(pool), runAgentMemoryMigrations(concurrentPool)]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runScheduleMigrations(pool);
      await runCatalogMigrations(pool);
      await runAccessMigrations(pool);
      await runKnowledgeMigrations(pool);
    }

    const schedule = await new PostgresScheduleStore(pool).searchItems({
      profileName: "helper",
      sourceKeys: ["legacy-schedule"],
      serviceDate: "2026-07-22"
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.externalKey).toBe("legacy-event");

    const migratedSource = (
      await new PostgresCatalogStore(pool).listSources({
        profileName: "helper",
        sourceKeys: ["legacy-catalog"]
      })
    )[0];
    expect(migratedSource).toMatchObject({
      revision: "1",
      healthStatus: "ready",
      publishedItemCount: 1
    });
    expect(
      await new PostgresCatalogStore(pool).searchItems({
        profileName: "helper",
        query: "Legacy resource"
      })
    ).toHaveLength(1);

    const memoryStore = new PostgresAgentMemoryStore(pool);
    expect(
      await memoryStore.searchResources({
        profileName: "helper",
        source: { type: "user", userId: "legacy-user" },
        query: "Legacy slides"
      })
    ).toHaveLength(1);

    await expect(
      memoryStore.recordResource({
        profileName: "helper",
        source: { type: "user", userId: "new-user" },
        resourceType: "general_resource",
        title: "General resource",
        storage: {
          provider: "external_link",
          url: "https://example.invalid/general"
        }
      })
    ).resolves.toMatchObject({ resourceType: "general_resource" });

    const indexes = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname=current_schema()`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "schedule_items_external_key_idx",
        "catalog_items_lookup_idx",
        "agent_resources_lookup_idx",
        "knowledge_embeddings_cosine_idx"
      ])
    );
  });

  it("passes the catalog and knowledge atomic publication matrix", async () => {
    const matrixEnvironment = await createKernelPostgresEnvironment();
    try {
      const results = await runPostgresIntegrationMatrix(matrixEnvironment);
      expect(results.map(({ caseId }) => caseId)).toEqual([
        "postgres/migrations/fresh-idempotent",
        "postgres/catalog/concurrent-publication",
        "postgres/catalog/rollback-and-visibility",
        "postgres/knowledge/rollback-and-stale-failure"
      ]);
      expect(results.filter((result) => !result.passed || result.failureCode)).toEqual([]);
    } finally {
      await matrixEnvironment.cleanup();
    }
  });
});

function requiredEnvironment(
  environment: KernelPostgresEnvironment | undefined
): KernelPostgresEnvironment {
  if (!environment) throw new Error("kernel_postgres_test_environment_missing");
  return environment;
}
