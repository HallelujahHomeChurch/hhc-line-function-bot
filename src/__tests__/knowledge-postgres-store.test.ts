import { describe, expect, it, vi } from "vitest";

import { PostgresKnowledgeStore } from "../knowledge/postgres-store.js";

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    profile_name: "helper",
    source_key: "retreat",
    display_name: "青年出隊",
    routing_display_name: "青年出隊",
    admin_aliases: [],
    admin_topics: [],
    admin_sample_queries: [],
    staged_display_name: "青年出隊",
    staged_adapter_type: "notion",
    staged_external_root_id: "root",
    staged_root_url: "https://example.test/root",
    staged_enabled: true,
    staged_expires_at: null,
    staging_revision: "33333333-3333-4333-8333-333333333333",
    aliases: ["出隊"],
    topics: ["集合時間"],
    sample_queries: ["何時集合"],
    adapter_type: "notion",
    external_root_id: "root",
    root_url: "https://example.test/root",
    enabled: true,
    expires_at: null,
    disabled_at: null,
    purge_after: null,
    last_synced_at: "2026-07-13T00:00:00Z",
    sync_status: "ready",
    sync_error_code: null,
    ...overrides
  };
}

describe("PostgresKnowledgeStore routing parity", () => {
  it("quarantines malformed legacy source rows instead of failing the entire list", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [sourceRow({ id: "not-a-uuid", source_key: "" }), sourceRow()]
    });
    const store = new PostgresKnowledgeStore({ query });

    await expect(
      store.listSources({ profileName: "helper", includeDisabled: true })
    ).resolves.toEqual([expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" })]);
  });

  it("requires last-success eligibility and matches opaque section keys in anchor and search SQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresKnowledgeStore({ query });

    await store.hasAnchor({
      profileName: "helper",
      sourceId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      sectionKey: "a".repeat(64)
    });
    await store.search({
      profileName: "helper",
      query: "集合",
      sourceId: "11111111-1111-4111-8111-111111111111",
      sectionKey: "a".repeat(64),
      embeddingDimensions: 1536,
      embeddingProvider: "azure_openai",
      embeddingModel: "text-embedding-3-small"
    });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql.match(/last_synced_at\s+is\s+not\s+null/giu)).toHaveLength(2);
    expect(sql).toMatch(/section_key\s*=\s*\$\d+/iu);
    expect(sql).toMatch(/e\.dimensions\s*=\s*\$9/iu);
    expect(sql).not.toMatch(/any\s*\(c\.heading_path\)/iu);
  });

  it("stages an existing source without mutating its live core or lifecycle columns", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [sourceRow()] });
    const store = new PostgresKnowledgeStore({ query });

    await store.upsertSource({
      profileName: "helper",
      sourceKey: "retreat",
      displayName: "新名稱",
      adapterType: "notion",
      externalRootId: "new-root",
      rootUrl: "https://example.test/new",
      enabled: true,
      expiresAt: "2027-01-01T00:00:00Z"
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("staged_display_name");
    expect(sql).toContain("staged_external_root_id");
    expect(sql).toContain("staging_revision");
    const conflictUpdate = sql.split(/on conflict/iu)[1] ?? "";
    expect(conflictUpdate).not.toMatch(/\bdisplay_name\s*=\s*excluded\.display_name/iu);
    expect(conflictUpdate).not.toMatch(/\benabled\s*=\s*excluded\.enabled/iu);
    expect(conflictUpdate).not.toMatch(/\bexpires_at\s*=\s*excluded\.expires_at/iu);
  });

  it("publishes the entire source snapshot through one checked PostgreSQL transaction", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (/select \* from knowledge_sources/iu.test(sql)) return { rows: [sourceRow()] };
      if (/update knowledge_sources/iu.test(sql)) return { rows: [sourceRow()] };
      return { rows: [] };
    });
    const release = vi.fn();
    const poolQuery = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query: clientQuery, release });
    const store = new PostgresKnowledgeStore({ query: poolQuery, connect } as never);

    await (
      store as unknown as {
        publishSourceSnapshot(input: Record<string, unknown>): Promise<unknown>;
      }
    ).publishSourceSnapshot({
      sourceId: "11111111-1111-4111-8111-111111111111",
      expectedStagingRevision: "33333333-3333-4333-8333-333333333333",
      syncedAt: "2026-07-13T00:00:00Z",
      syncStatus: "ready",
      routingDisplayName: "青年出隊",
      aliases: [],
      topics: [],
      sampleQueries: [],
      documents: [],
      embeddings: []
    });

    expect(connect).toHaveBeenCalledOnce();
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining(["begin", "commit"])
    );
    expect(clientQuery.mock.calls.map(([sql]) => String(sql)).join("\n")).toMatch(
      /staging_revision/iu
    );
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back the PostgreSQL snapshot when any publication statement fails", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (/select \* from knowledge_sources/iu.test(sql)) return { rows: [sourceRow()] };
      if (/update knowledge_documents/iu.test(sql)) throw new Error("write failed");
      return { rows: [] };
    });
    const release = vi.fn();
    const store = new PostgresKnowledgeStore({
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release })
    });

    await expect(
      store.publishSourceSnapshot({
        sourceId: "11111111-1111-4111-8111-111111111111",
        expectedStagingRevision: "33333333-3333-4333-8333-333333333333",
        syncedAt: "2026-07-13T00:00:00Z",
        syncStatus: "ready",
        routingDisplayName: "青年出隊",
        aliases: [],
        topics: [],
        sampleQueries: [],
        documents: [],
        embeddings: []
      })
    ).rejects.toThrow("write failed");

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining(["begin", "rollback"])
    );
    expect(clientQuery.mock.calls.map(([sql]) => sql)).not.toContain("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("ranks one top result per source in one bounded PostgreSQL query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresKnowledgeStore({ query });
    const sourceIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];

    await store.searchTopPerSource({
      profileName: "helper",
      query: "共同暗號",
      ordinal: 1,
      embeddingDimensions: 1536,
      sourceIds
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0]!;
    expect(String(sql)).toMatch(/row_number\(\)\s+over\s*\(\s*partition\s+by\s+source_id/iu);
    expect(String(sql)).toMatch(/source_rank\s*=\s*1/iu);
    expect(String(sql)).toMatch(/ordinal_score/iu);
    expect(String(sql)).toMatch(/c\.ordinal\s*=\s*\$7/iu);
    expect(String(sql)).toMatch(/e\.dimensions\s*=\s*\$4/iu);
    expect(values).toEqual(["helper", "共同暗號", null, 1536, null, null, 1, sourceIds]);
    await expect(
      store.searchTopPerSource({
        profileName: "helper",
        query: "共同暗號",
        sourceIds: Array.from(
          { length: 21 },
          (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`
        )
      })
    ).rejects.toThrow("knowledge_source_scope_limit");
  });

  it("rotates revision on publish and conditionally rejects stale failure health", async () => {
    const oldRevision = "33333333-3333-4333-8333-333333333333";
    const newRevision = "44444444-4444-4444-8444-444444444444";
    const clientQuery = vi.fn(async (sql: string) => {
      if (/select \* from knowledge_sources/iu.test(sql)) {
        return { rows: [sourceRow({ staging_revision: oldRevision })] };
      }
      if (/update knowledge_sources set/iu.test(sql)) {
        return { rows: [sourceRow({ staging_revision: newRevision })] };
      }
      return { rows: [] };
    });
    const query = vi.fn(async (sql: string) => {
      if (/mark_source_failure/iu.test(sql)) return { rows: [{ outcome: "stale" }] };
      return { rows: [] };
    });
    const store = new PostgresKnowledgeStore({
      query,
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() })
    });

    const published = await store.publishSourceSnapshot({
      sourceId: "11111111-1111-4111-8111-111111111111",
      expectedStagingRevision: oldRevision,
      syncedAt: "2026-07-13T00:00:00Z",
      syncStatus: "ready",
      routingDisplayName: "青年出隊",
      aliases: [],
      topics: [],
      sampleQueries: [],
      documents: [],
      embeddings: []
    });
    const publicationSql = clientQuery.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(publicationSql).toMatch(/staging_revision\s*=\s*gen_random_uuid\(\)/iu);
    expect(published.stagingRevision).toBe(newRevision);

    await expect(
      store.markSourceSyncFailed({
        profileName: "helper",
        sourceKey: "retreat",
        expectedStagingRevision: oldRevision,
        syncErrorCode: "source_unavailable"
      })
    ).resolves.toBe("stale");
    const [failureSql, failureValues] = query.mock.calls.at(-1)!;
    expect(String(failureSql)).toMatch(/mark_source_failure/iu);
    expect(String(failureSql)).toMatch(/staging_revision\s*=\s*\$3::uuid/iu);
    expect(failureValues).toContain(oldRevision);
  });
});
