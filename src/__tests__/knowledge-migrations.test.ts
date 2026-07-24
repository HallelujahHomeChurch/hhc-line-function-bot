import { describe, expect, it, vi } from "vitest";

import { runKnowledgeMigrations } from "../knowledge/migrations.js";

describe("knowledge migrations", () => {
  it("clears only derived knowledge rows before rebuilding the 1536-dimension cosine HNSW index", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await runKnowledgeMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("embedding vector(1536)");
    expect(sql).toContain("delete from knowledge_embeddings");
    expect(sql).toContain("delete from knowledge_chunks");
    expect(sql).toContain("delete from knowledge_documents");
    expect(sql).toContain("update knowledge_sources set last_synced_at=null");
    expect(sql).toContain("alter column embedding type vector(1536)");
    expect(sql).toContain("vector_cosine_ops");
    expect(sql).toContain("using hnsw");
    expect(sql).not.toMatch(/delete\s+from\s+knowledge_sources/iu);
    expect(sql).toContain("aliases text[] not null default '{}'");
    expect(sql).toContain("topics text[] not null default '{}'");
    expect(sql).toContain("sample_queries text[] not null default '{}'");
    expect(sql).toContain("admin_aliases text[] not null default '{}'");
    expect(sql).toContain("admin_topics text[] not null default '{}'");
    expect(sql).toContain("admin_sample_queries text[] not null default '{}'");
    expect(sql).toContain("routing_display_name text");
    expect(sql).toContain("staged_display_name text");
    expect(sql).toContain("staged_adapter_type text");
    expect(sql).toContain("staged_external_root_id text");
    expect(sql).toContain("staged_root_url text");
    expect(sql).toContain("staged_enabled boolean");
    expect(sql).toContain("staged_expires_at timestamptz");
    expect(sql).toContain("staging_revision uuid");
    expect(sql).toContain("section_key text");
    expect(sql).toMatch(/alter table knowledge_sources add column if not exists aliases/iu);
    expect(sql).toMatch(
      /select id, heading_path from knowledge_chunks where section_key is null/iu
    );
    expect(sql).toMatch(/alter table knowledge_chunks alter column section_key set not null/iu);
    expect(sql).not.toMatch(/create\s+extension/iu);

    const rebuild = sql.match(/do \$\$[\s\S]*?end \$\$/iu)?.[0] ?? "";
    expect(rebuild.indexOf("delete from knowledge_embeddings")).toBeLessThan(
      rebuild.indexOf("delete from knowledge_chunks")
    );
    expect(rebuild.indexOf("delete from knowledge_chunks")).toBeLessThan(
      rebuild.indexOf("delete from knowledge_documents")
    );
    expect(rebuild.indexOf("drop index if exists knowledge_embeddings_cosine_idx")).toBeLessThan(
      rebuild.indexOf("alter table knowledge_embeddings alter column embedding type vector(1536)")
    );
    expect(
      rebuild.indexOf("alter table knowledge_embeddings alter column embedding type vector(1536)")
    ).toBeLessThan(rebuild.indexOf("add constraint knowledge_embeddings_dimensions_check"));
    expect(rebuild.indexOf("add constraint knowledge_embeddings_dimensions_check")).toBeLessThan(
      rebuild.indexOf("create index knowledge_embeddings_cosine_idx")
    );
  });

  it("does not overwrite a staged permanent expiry when migrations rerun", async () => {
    const state: {
      expiresAt: string;
      stagedExpiresAt?: string | null;
      stagingInitialized?: boolean;
    } = {
      expiresAt: "2027-01-01T00:00:00Z"
    };
    const query = vi.fn(async (statement: string) => {
      if (/add column if not exists staging_initialized/iu.test(statement)) {
        state.stagingInitialized ??= false;
      }
      if (/staged_expires_at\s*=\s*coalesce\(staged_expires_at,\s*expires_at\)/iu.test(statement)) {
        state.stagedExpiresAt ??= state.expiresAt;
      }
      if (
        /staged_expires_at\s*=\s*expires_at/iu.test(statement) &&
        /where\s+staging_initialized\s*=\s*false/iu.test(statement) &&
        state.stagingInitialized === false
      ) {
        state.stagedExpiresAt = state.expiresAt;
        state.stagingInitialized = true;
      }
      return { rows: [] };
    });

    await runKnowledgeMigrations({ query });
    state.stagedExpiresAt = null;
    await runKnowledgeMigrations({ query });

    expect(state.stagedExpiresAt).toBeNull();
    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("staging_initialized");
  });
});
