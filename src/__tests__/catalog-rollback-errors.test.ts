import { describe, expect, it, vi } from "vitest";
import { PostgresKnowledgeStore } from "../knowledge/postgres-store.js";

describe("knowledge snapshot rollback errors", () => {
  it("preserves the original SQL error and rollback error and always releases", async () => {
    const primary = new Error("query_failed");
    const rollback = new Error("rollback_failed");
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin") return { rows: [] };
      if (sql === "rollback") throw rollback;
      throw primary;
    });
    const release = vi.fn();
    const client = { query, release };
    const store = new PostgresKnowledgeStore({ query, connect: async () => client });
    const error = await store
      .publishSourceSnapshot({
        sourceId: "opaque-source",
        expectedStagingRevision: 1,
        syncedAt: new Date().toISOString(),
        syncStatus: "ready",
        routingDisplayName: "fixture",
        aliases: [],
        topics: [],
        sampleQueries: [],
        documents: [],
        embeddings: []
      })
      .catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(primary);
    expect(error.errors[0]).toBe(primary);
    expect(error.errors[1]).toBe(rollback);
    expect(release).toHaveBeenCalledOnce();
  });
});
