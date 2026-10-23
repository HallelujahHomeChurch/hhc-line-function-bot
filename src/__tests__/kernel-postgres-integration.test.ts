import { RedisAgentJobStore } from "../agent/jobs.js";
import { handleAgentOperationWithLongJob } from "../transport/line/postbacks.js";
import type { BotProfileConfig } from "../types.js";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { runAccessMigrations } from "../access/migrations.js";
import { PostgresAccessStore } from "../access/postgres-access-store.js";
import { runAgentMemoryMigrations } from "../agent/migrations.js";
import { PostgresAgentMemoryStore } from "../agent/postgres-memory-store.js";
import { runCatalogMigrations } from "../catalog/migrations.js";
import { PostgresCatalogStore } from "../catalog/postgres-store.js";
import {
  createKernelPostgresEnvironment,
  createKernelRedisEnvironment,
  type KernelPostgresEnvironment
} from "../evals/kernel/integration/environment.js";
import { runPostgresIntegrationMatrix } from "../evals/kernel/integration/postgres-matrix.js";
import { runKnowledgeMigrations } from "../knowledge/migrations.js";
import { PostgresKnowledgeStore } from "../knowledge/postgres-store.js";
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

  it("does not repeat a PostgreSQL commit when the handler throws before returning its result", async () => {
    const redis = await createKernelRedisEnvironment();
    const [pool] = requiredEnvironment(environment).pools;
    try {
      await pool.query(
        "create table webhook_commit_probe (id bigint generated always as identity primary key)"
      );
      const stores = redis.clients.map(
        (client) => new RedisAgentJobStore({ client, keyPrefix: redis.keyPrefix })
      );
      const profile: BotProfileConfig = {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "synthetic",
        channelAccessToken: "unused",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: false,
        wakeKeywords: [],
        acceptMention: true,
        enabledFunctions: [],
        permissionRequiredFunctions: []
      };
      const event = {
        type: "message",
        webhookEventId: "committed-then-disconnected",
        source: { type: "user", userId: "synthetic-requester" }
      };
      const operation = async () => {
        await pool.query("insert into webhook_commit_probe default values");
        throw new Error("connection lost after commit");
      };
      await expect(
        handleAgentOperationWithLongJob({ jobStore: stores[0]!, profile, event, operation })
      ).rejects.toThrow("connection lost after commit");
      const retry = await handleAgentOperationWithLongJob({
        jobStore: stores[1]!,
        profile,
        event,
        operation
      });
      expect(retry?.replyText).toContain("已有處理紀錄");
      expect(
        (await pool.query("select count(*)::int as count from webhook_commit_probe")).rows[0].count
      ).toBe(1);
    } finally {
      await redis.cleanup();
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

    const accessStore = new PostgresAccessStore(pool);
    await accessStore.addPrincipal({
      profileName: "helper",
      type: "group",
      principalId: "synthetic-branch-group",
      displayName: "Synthetic branch",
      createdBy: "synthetic-admin"
    });
    await accessStore.recordPrincipalSuccess({
      profileName: "helper",
      type: "group",
      principalId: "synthetic-branch-group",
      functionName: "query_schedule",
      occurredAt: "2026-07-26T08:00:00.000Z"
    });
    await expect(
      accessStore.listPrincipals("helper", { includeDisabled: true })
    ).resolves.toContainEqual(
      expect.objectContaining({
        principalId: "synthetic-branch-group",
        lastSuccessCapabilityName: "query_schedule",
        lastSuccessAt: "2026-07-26T08:00:00.000Z"
      })
    );

    const schedule = await new PostgresScheduleStore(pool).searchItems({
      profileName: "helper",
      sourceKeys: ["legacy-schedule"],
      serviceDate: "2026-07-22"
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.externalKey).toBe("legacy-event");

    const catalogStore = new PostgresCatalogStore(pool);
    const migratedSource = (
      await catalogStore.listSources({
        profileName: "helper",
        sourceKeys: ["legacy-catalog"]
      })
    )[0];
    expect(migratedSource).toMatchObject({
      revision: "1",
      healthStatus: "ready",
      publishedItemCount: 1
    });
    await catalogStore.upsertSource({
      profileName: "helper",
      sourceKey: "legacy-catalog",
      adapterType: "manual",
      domain: "general",
      defaultItemKind: "document",
      rootLocation: {},
      enabled: true,
      syncPolicy: { mode: "manual" },
      capabilities: { read: [], write: [] },
      ownerLabel: "資料管理員",
      freshnessResponsibility: "每月確認"
    });
    await catalogStore.upsertSource({
      profileName: "helper",
      sourceKey: "legacy-catalog",
      adapterType: "manual",
      domain: "general",
      defaultItemKind: "document",
      rootLocation: {},
      enabled: true,
      syncPolicy: { mode: "manual" },
      capabilities: { read: [], write: [] }
    });
    await expect(
      catalogStore.listSources({
        profileName: "helper",
        sourceKeys: ["legacy-catalog"]
      })
    ).resolves.toEqual([
      expect.objectContaining({
        ownerLabel: "資料管理員",
        freshnessResponsibility: "每月確認"
      })
    ]);
    expect(
      await catalogStore.searchItems({
        profileName: "helper",
        query: "Legacy resource"
      })
    ).toHaveLength(1);

    const knowledgeStore = new PostgresKnowledgeStore(pool);
    await knowledgeStore.upsertSource({
      profileName: "helper",
      sourceKey: "responsibility",
      displayName: "責任測試",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.invalid/root",
      enabled: true,
      createdBy: "Ucreator"
    });
    await knowledgeStore.upsertSource({
      profileName: "helper",
      sourceKey: "responsibility",
      displayName: "責任測試更新",
      adapterType: "notion",
      externalRootId: "root",
      rootUrl: "https://example.invalid/root",
      enabled: true,
      createdBy: "Uother"
    });
    await expect(
      knowledgeStore.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([expect.objectContaining({ createdBy: "Ucreator" })]);

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

  it("passes the PostgreSQL publication and SDK checkpoint matrix", async () => {
    const matrixEnvironment = await createKernelPostgresEnvironment();
    try {
      const results = await runPostgresIntegrationMatrix(matrixEnvironment);
      expect(results.map(({ caseId }) => caseId)).toEqual([
        "postgres/migrations/fresh-idempotent",
        "postgres/catalog/concurrent-publication",
        "postgres/catalog/rollback-and-visibility",
        "postgres/knowledge/rollback-and-stale-failure",
        "postgres/helper-agent/source-ttl-and-reset"
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

describe("LINE quote context in real PostgreSQL", () => {
  it("defers candidate text and dependencies, then rechecks generation and quote freshness before admission", async () => {
    const { PostgresQuoteStore } = await import("../quotes/postgres-store.js");
    const environment = await createKernelPostgresEnvironment();
    const [pool] = environment.pools;
    let now = new Date("2026-10-23T00:00:00Z");
    const store = new PostgresQuoteStore(pool, "synthetic-admission", () => now);
    const source = { type: "group", groupId: "synthetic-group", userId: "synthetic-a" };
    const scope = { profileName: "helper", source };
    const begin = (messageId: string, extra: Partial<Parameters<typeof store.begin>[0]> = {}) =>
      store.begin({
        ...scope,
        messageId,
        text: "SYNTHETIC_REQUEST",
        timestamp: now.getTime(),
        ...extra
      });
    try {
      await store.setup();
      const original = (await begin("original"))!;
      await begin("member", { source: { ...source, userId: "synthetic-b" } });
      const before = (
        await pool.query("select lineage, expires_at from line_quote_threads where thread_id=$1", [
          original.token.threadId
        ])
      ).rows[0];
      now = new Date(now.getTime() + 30000);
      const candidate = (await begin("candidate", {
        quotedMessageId: "member",
        deferRequest: true,
        text: undefined
      }))!;
      expect(candidate.quoted?.status).toBe("resolved");
      expect(candidate.requestText).toBeNull();
      expect(
        (
          await pool.query(
            "select lineage, expires_at from line_quote_threads where thread_id=$1",
            [original.token.threadId]
          )
        ).rows[0]
      ).toEqual(before);
      expect(
        (
          await pool.query("select safe_text from line_quote_messages where thread_id=$1", [
            original.token.threadId
          ])
        ).rows
      ).toEqual([{ safe_text: "SYNTHETIC_REQUEST" }]);
      expect(
        (
          await begin("probe", {
            quotedMessageId: "candidate",
            source: { ...source, userId: "synthetic-c" },
            deferRequest: true
          })
        )?.quoted
      ).toEqual({ status: "unavailable" });

      const admitted = await begin("candidate", {
        quotedMessageId: "member",
        expectedGeneration: candidate.token.generation,
        expectedQuoted: candidate.quoted
      });
      expect(admitted?.requestText).toBe("SYNTHETIC_REQUEST");
      expect(
        (
          await begin("probe-admitted", {
            quotedMessageId: "candidate",
            source: { ...source, userId: "synthetic-c" },
            deferRequest: true
          })
        )?.quoted?.status
      ).toBe("resolved");

      const stale = (await begin("stale", { quotedMessageId: "member", deferRequest: true }))!;
      await store.reset(scope);
      expect(
        await begin("stale", {
          quotedMessageId: "member",
          expectedGeneration: stale.token.generation,
          expectedQuoted: stale.quoted
        })
      ).toBeUndefined();

      const withdrawn = (await begin("withdrawn", {
        quotedMessageId: "member",
        deferRequest: true
      }))!;
      await store.unsend({ ...scope, source: { ...source, userId: "synthetic-b" } }, "member");
      expect(await store.isCurrent(withdrawn.token)).toBe(false);
      expect(
        await begin("withdrawn", {
          quotedMessageId: "member",
          expectedGeneration: withdrawn.token.generation,
          expectedQuoted: withdrawn.quoted
        })
      ).toBeUndefined();

      await begin("expiring-member", { source: { ...source, userId: "synthetic-b" } });
      now = new Date(now.getTime() + 14 * 60000);
      await begin("keep-requester-live");
      const expiring = (await begin("expiring", {
        quotedMessageId: "expiring-member",
        deferRequest: true
      }))!;
      now = new Date(now.getTime() + 61000);
      expect(await store.isCurrent(expiring.token)).toBe(true);
      expect(
        await begin("expiring", {
          quotedMessageId: "expiring-member",
          expectedGeneration: expiring.token.generation,
          expectedQuoted: expiring.quoted
        })
      ).toBeUndefined();
    } finally {
      await environment.cleanup();
    }
  });

  it("keeps long conversations and exact public replies while isolating withdrawal dependencies", async () => {
    const { PostgresQuoteStore } = await import("../quotes/postgres-store.js");
    const environment = await createKernelPostgresEnvironment();
    let now = new Date("2026-10-17T00:00:00Z");
    const store = new PostgresQuoteStore(environment.pools[0]!, "synthetic-continuity", () => now);
    const source = { type: "group", groupId: "synthetic-group", userId: "synthetic-a" };
    const begin = (messageId: string, userId = "synthetic-a", quotedMessageId?: string) =>
      store.begin({
        profileName: "helper",
        source: { ...source, userId },
        messageId,
        text: "合成查詢",
        quotedMessageId,
        timestamp: now.getTime()
      });
    try {
      await store.setup();
      const first = (await begin("original"))!;
      await store.recordReply(
        first,
        [{ id: "bot-visible", text: "1. 合成甲\n2. 合成乙\nhttps://example.test/synthetic" }],
        {
          kind: "read",
          publicRead: { capability: "query_schedule", arguments: { query: "合成查詢" } }
        }
      );
      await store.recordReply(first, [{ id: "unsafe-bot", text: "token=synthetic" }], {
        kind: "read",
        publicRead: { capability: "query_schedule", arguments: { query: "合成" } }
      });
      expect((await begin("unsafe-quote", "synthetic-b", "unsafe-bot"))?.quoted).toEqual({
        status: "other_requester"
      });
      const own = await begin("own-quote", "synthetic-a", "bot-visible");
      expect(own?.quoted).toMatchObject({
        status: "resolved",
        kind: "message_text",
        text: expect.stringContaining("2. 合成乙")
      });
      expect(JSON.stringify(own?.quoted)).not.toContain("https://");
      const shared = (await begin("shared", "synthetic-b", "bot-visible"))!;
      expect(shared.quoted).toMatchObject({
        status: "resolved",
        kind: "public_lookup",
        lookup: { capability: "query_schedule" }
      });
      expect(shared.quoted).toMatchObject({ text: expect.stringContaining("2. 合成乙") });
      expect(JSON.stringify(shared.quoted)).not.toContain("https://");
      expect((await begin("member-quote", "synthetic-b", "original"))?.quoted).toEqual({
        status: "resolved",
        author: "user",
        otherMember: true,
        kind: "message_text",
        text: "合成查詢"
      });
      await store.begin({
        profileName: "helper",
        source,
        messageId: "secret-member",
        text: "password=synthetic",
        timestamp: now.getTime()
      });
      expect((await begin("denied-secret", "synthetic-b", "secret-member"))?.quoted).toEqual({
        status: "other_requester"
      });
      expect(
        (
          await store.begin({
            profileName: "helper",
            source: { type: "user", userId: "synthetic-b" },
            messageId: "direct-probe",
            quotedMessageId: "original",
            timestamp: now.getTime()
          })
        )?.quoted
      ).toEqual({ status: "unavailable" });
      for (let n = 0; n < 100; n++) {
        const next = (await begin(`long-${n}`))!;
        expect(next.token.generation).toBe(first.token.generation);
        expect(next.clearCheckpoint).toBe(false);
        expect(next.token.sourceKeys.length).toBeLessThanOrEqual(64);
      }
      const afterLong = (await begin("after-long"))!;
      await store.recordReply(afterLong, [{ id: "late-reply", text: "較新的合成結果" }], {
        kind: "read",
        publicRead: { capability: "query_schedule", arguments: { query: "合成" } }
      });
      await begin("late-dependent", "synthetic-d", "late-reply");
      now = new Date(now.getTime() + 14 * 60_000);
      await begin("keep-a");
      await begin("keep-b", "synthetic-b");
      await begin("keep-d", "synthetic-d");
      now = new Date(now.getTime() + 2 * 60_000);
      await store.cleanupExpired();
      const unrelated = { profileName: "helper", source: { ...source, userId: "synthetic-c" } };
      await store.reset(unrelated);
      const affected = await store.unsend({ profileName: "helper", source }, "original");
      expect(affected.map((item) => item.source.userId).sort()).toEqual([
        "synthetic-a",
        "synthetic-b",
        "synthetic-d"
      ]);
      expect(await store.isCurrent(first.token)).toBe(false);
      expect(await store.isCurrent(shared.token)).toBe(false);
      expect(
        (await store.unsend({ profileName: "helper", source }, "original"))
          .map((item) => item.source.userId)
          .sort()
      ).toEqual(["synthetic-a", "synthetic-b", "synthetic-d"]);
    } finally {
      await environment.cleanup();
    }
  });

  it("withdraws dependents without clearing the requester they quoted", async () => {
    const { PostgresQuoteStore } = await import("../quotes/postgres-store.js");
    const environment = await createKernelPostgresEnvironment();
    const store = new PostgresQuoteStore(environment.pools[0]!, "synthetic-directed");
    const scope = {
      profileName: "helper",
      source: { type: "group", groupId: "directed", userId: "a" }
    };
    try {
      await store.setup();
      const a = (await store.begin({
        ...scope,
        messageId: "a-request",
        text: "合成問題",
        timestamp: Date.now()
      }))!;
      await store.recordReply(a, [{ id: "a-reply", text: "合成結果" }], {
        kind: "read",
        publicRead: { capability: "query_schedule", arguments: { query: "合成" } }
      });
      const bScope = { ...scope, source: { ...scope.source, userId: "b" } };
      const b = (await store.begin({
        ...bScope,
        messageId: "b-request",
        quotedMessageId: "a-reply",
        text: "合成追問",
        timestamp: Date.now()
      }))!;
      expect((await store.unsend(bScope, "b-request")).map((item) => item.source.userId)).toEqual([
        "b"
      ]);
      expect(await store.isCurrent(a.token)).toBe(true);
      expect(await store.isCurrent(b.token)).toBe(false);
    } finally {
      await environment.cleanup();
    }
  });

  it("isolates quotes and fences delayed replies, reset, unsend and expired lineage", async () => {
    const { PostgresQuoteStore } = await import("../quotes/postgres-store.js");
    const environment = await createKernelPostgresEnvironment();
    let now = new Date("2026-10-16T00:00:00Z");
    const [left, right] = environment.pools.map(
      (pool) => new PostgresQuoteStore(pool, "synthetic-hmac-key", () => now)
    );
    const scope = {
      profileName: "helper",
      source: { type: "group", groupId: "group-one", userId: "user-one" }
    };
    const begin = (messageId: string, quotedMessageId?: string) =>
      left.begin({
        ...scope,
        messageId,
        quotedMessageId,
        text: "下週服事表",
        timestamp: now.getTime()
      });
    try {
      await left.setup();
      const original = (await begin("original"))!;
      await left.recordReply(original, [
        { id: "bot-one", text: "https://example.test/private?token=synthetic" },
        { id: "bot-two", text: "private tool payload" }
      ]);
      expect((await begin("quote-user", "original"))?.quoted).toMatchObject({
        status: "resolved",
        author: "user",
        kind: "message_text"
      });
      expect((await begin("quote-bot", "bot-two"))?.quoted).toEqual({
        status: "resolved",
        author: "bot",
        kind: "reply_to_request",
        text: "下週服事表"
      });
      const other = await left.begin({
        ...scope,
        source: { ...scope.source, userId: "user-two" },
        messageId: "other",
        quotedMessageId: "bot-one",
        text: "繼續",
        timestamp: now.getTime()
      });
      expect(other?.quoted).toEqual({ status: "other_requester" });
      for (const changed of [
        { ...scope, profileName: "other" },
        { ...scope, source: { ...scope.source, groupId: "group-two" } }
      ])
        expect(await left.inspect(changed, "bot-one")).toEqual({ bot: false });
      const stored = await environment.pools[0].query(
        "select safe_text from line_quote_messages where author='bot'"
      );
      expect(JSON.stringify(stored.rows)).not.toMatch(/private|token|payload/);
      await right.reset(scope);
      expect(await left.isCurrent(original.token)).toBe(false);
      await left.recordReply(original, [{ id: "late-bot", text: "old" }]);
      expect(await left.inspect(scope, "late-bot")).toEqual({ bot: false });
      const afterReset = (await begin("after-reset"))!;
      expect(afterReset.clearCheckpoint).toBe(true);
      // A failed checkpoint clear remains pending across webhook retries/replicas.
      expect((await begin("after-failed-clear"))?.clearCheckpoint).toBe(true);
      await left.acknowledgeClear(afterReset.token);
      expect((await begin("after-clear"))?.clearCheckpoint).toBe(false);
      await right.unsend(scope, "future-original");
      expect(await begin("future-original")).toBeUndefined();
      const active = (await begin("active"))!;
      const affected = await right.unsend(scope, "active");
      expect(affected).toContainEqual(scope);
      expect(await right.unsend(scope, "active")).toContainEqual(scope);
      expect(await left.isCurrent(active.token)).toBe(false);
      await left.recordReply(active, [{ id: "late-unsent", text: "old" }]);
      expect(await left.inspect(scope, "late-unsent")).toEqual({ bot: false });
      expect((await begin("after-unsend"))?.clearCheckpoint).toBe(true);
      now = new Date(now.getTime() + 16 * 60_000);
      expect((await begin("expired", "original"))?.quoted).toEqual({ status: "unavailable" });
      expect(
        await left.begin({
          ...scope,
          messageId: "too-old",
          timestamp: now.getTime() - 7 * 24 * 60 * 60_000
        })
      ).toBeUndefined();
      expect(
        await left.begin({
          ...scope,
          source: { type: "group", groupId: "group-one" },
          timestamp: now.getTime()
        })
      ).toBeUndefined();
    } finally {
      await environment.cleanup();
    }
  });
});

it("fences interrupted quote candidates in PostgreSQL while preserving context after engagement", async () => {
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const { FakeToolCallingModel } = await import("langchain");
  const { createHelperAgent } = await import("../helper-agent/agent.js");
  const { createPostgresHelperAgentState } = await import("../helper-agent/state.js");
  const environment = await createKernelPostgresEnvironment();
  const [pool, lockPool] = environment.pools;
  const saver = new PostgresSaver(pool);
  const state = createPostgresHelperAgentState({
    pool,
    lockPool,
    checkpointer: saver,
    hmacKey: "synthetic-engagement"
  });
  const run = {
    threadId: "synthetic-engagement",
    policyKey: "policy",
    source: { type: "group", groupId: "synthetic-group", userId: "synthetic-user" }
  };
  try {
    await saver.setup();
    await state.setup();
    for (const engaged of [false, true]) {
      await expect(
        state.run({
          ...run,
          task: async (snapshot) => {
            await snapshot.markContextDirty!();
            if (engaged) await snapshot.markContextDirty!(false);
            await createHelperAgent({
              checkpointer: saver,
              model: new FakeToolCallingModel({ toolCalls: [[]] }),
              summaryModel: new FakeToolCallingModel({ toolCalls: [[]] })
            }).invoke(
              { messages: [{ role: "user", content: "SYNTHETIC_CANDIDATE" }] },
              { configurable: { thread_id: run.threadId } }
            );
            throw new Error("synthetic interruption");
          }
        })
      ).rejects.toThrow("synthetic interruption");
      const reset = await state.run({ ...run, task: async (snapshot) => snapshot.contextReset });
      expect(reset).toBe(engaged ? undefined : "policy_changed");
      const checkpoint = await saver.getTuple({ configurable: { thread_id: run.threadId } });
      expect(Boolean(checkpoint)).toBe(engaged);
    }
  } finally {
    await environment.cleanup();
  }
});

it("deletes a real late LangGraph checkpoint after a concurrent quote reset", async () => {
  const { PostgresQuoteStore } = await import("../quotes/postgres-store.js");
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const { FakeToolCallingModel } = await import("langchain");
  const { createHelperAgent } = await import("../helper-agent/agent.js");
  const { createPostgresHelperAgentState } = await import("../helper-agent/state.js");
  const environment = await createKernelPostgresEnvironment();
  const [pool, lockPool] = environment.pools;
  const store = new PostgresQuoteStore(pool, "synthetic-key");
  const second = new PostgresQuoteStore(lockPool, "synthetic-key");
  const saver = new PostgresSaver(pool);
  const state = createPostgresHelperAgentState({
    pool,
    lockPool,
    checkpointer: saver,
    hmacKey: "synthetic-key"
  });
  const scope = { profileName: "helper", source: { type: "user", userId: "synthetic-user" } };
  try {
    await saver.setup();
    await state.setup();
    await store.setup();
    const turn = (await store.begin({
      ...scope,
      messageId: "original",
      text: "synthetic request",
      timestamp: Date.now()
    }))!;
    expect(turn.token.threadId).toBe(state.threadId(scope));
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = state.run({
      threadId: turn.token.threadId,
      source: scope.source,
      policyKey: "synthetic",
      isCurrent: () => store.isCurrent(turn.token),
      task: async () => {
        entered();
        await gate;
        await createHelperAgent({
          checkpointer: saver,
          model: new FakeToolCallingModel({ toolCalls: [[]] }),
          summaryModel: new FakeToolCallingModel({ toolCalls: [[]] })
        }).invoke(
          { messages: [{ role: "user", content: "late synthetic text" }] },
          { configurable: { thread_id: turn.token.threadId } }
        );
      }
    });
    await started;
    await second.reset(scope);
    release();
    await expect(pending).rejects.toThrow("context_invalidated");
    expect(
      (await pool.query("select 1 from checkpoints where thread_id=$1", [turn.token.threadId])).rows
    ).toHaveLength(0);
    await store.recordReply(turn, [{ id: "late-reply", text: "late" }]);
    expect(await second.inspect(scope, "late-reply")).toEqual({ bot: false });
  } finally {
    await environment.cleanup();
  }
});
