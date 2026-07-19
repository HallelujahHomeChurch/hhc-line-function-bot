import { describe, expect, it, vi } from "vitest";

import { runCatalogMigrations } from "../catalog/migrations.js";

describe("catalog migrations", () => {
  it("adds publication lifecycle columns before backfilling existing sources", async () => {
    const queries: string[] = [];
    await runCatalogMigrations({
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
      })
    });

    const lifecycleColumns = queries.findIndex((sql) =>
      sql.includes("add column if not exists health_status")
    );
    const lifecycleBackfill = queries.findIndex((sql) =>
      sql.includes("update catalog_sources as catalog_source")
    );
    expect(lifecycleColumns).toBeGreaterThanOrEqual(0);
    expect(lifecycleBackfill).toBeGreaterThan(lifecycleColumns);
  });
});
