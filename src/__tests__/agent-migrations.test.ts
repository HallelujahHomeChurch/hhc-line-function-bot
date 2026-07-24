import { describe, expect, it, vi } from "vitest";

import { runAgentMemoryMigrations } from "../agent/migrations.js";

describe("agent memory migrations", () => {
  it("never applies the retired schedule visibility constraint before profile visibility", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runAgentMemoryMigrations({ query });

    const statements = query.mock.calls.map(([statement]) => String(statement));
    const scheduleVisibilityConstraints = statements.filter((statement) =>
      statement.includes("add constraint agent_schedule_memories_visibility_check")
    );

    expect(scheduleVisibilityConstraints).toHaveLength(1);
    expect(scheduleVisibilityConstraints[0]).toContain("'private', 'group', 'profile'");
  });

  it("preserves explicit text memory while clearing only vectors for the 1536 rebuild", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runAgentMemoryMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("embedding vector(1536)");
    expect(sql).toContain("update agent_text_memories set embedding=null");
    expect(sql).toContain("alter column embedding type vector(1536)");
    expect(sql).toContain("agent_text_memories_search_idx");
    expect(sql).toContain("agent_text_memories_embedding_idx");
    expect(sql).toContain("if not exists");
    expect(sql).not.toMatch(/delete\s+from\s+agent_text_memories/iu);
  });

  it("adds resource lifecycle metadata and retires legacy aliases without deleting resources", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runAgentMemoryMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("identity_key");
    expect(sql).toContain("verified_at");
    expect(sql).toContain("source_revision");
    expect(sql).toContain("tombstoned_at");
    expect(sql).toContain("delete from agent_resource_aliases");
    expect(sql).not.toContain("delete from agent_resources\n");
  });

  it("replaces every evolving constraint in one table lock", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runAgentMemoryMigrations({ query });

    const statements = query.mock.calls.map(([statement]) => String(statement));
    for (const constraintName of [
      "agent_resources_resource_type_check",
      "agent_resources_storage_provider_check",
      "agent_resources_storage_shape_check",
      "agent_resources_visibility_check",
      "agent_text_memories_visibility_check",
      "agent_schedule_memories_scope_type_check",
      "agent_schedule_memories_visibility_check"
    ]) {
      const constraintStatements = statements.filter((statement) =>
        statement.includes(constraintName)
      );
      expect(constraintStatements, constraintName).toHaveLength(1);
      expect(constraintStatements[0]).toContain(`drop constraint if exists ${constraintName}`);
      expect(constraintStatements[0]).toContain(`add constraint ${constraintName}`);
    }
    const retiredScheduleType = statements.filter((statement) =>
      statement.includes("agent_schedule_memories_schedule_type_check")
    );
    expect(retiredScheduleType).toHaveLength(1);
    expect(retiredScheduleType[0]).not.toContain("add constraint");
  });

  it("serializes the complete migration on one dedicated transaction client", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn();

    await runAgentMemoryMigrations({
      query: vi.fn(),
      connect: async () => ({ query, release })
    });

    expect(query.mock.calls[0]?.[0]).toBe("begin");
    expect(query.mock.calls[1]?.[0]).toBe("select pg_advisory_xact_lock(144757, 1)");
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the dedicated migration client after failure", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("create table if not exists agent_resources")) {
        throw new Error("synthetic_migration_failure");
      }
    });
    const release = vi.fn();

    await expect(
      runAgentMemoryMigrations({
        query: vi.fn(),
        connect: async () => ({ query, release })
      })
    ).rejects.toThrow("synthetic_migration_failure");

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});
