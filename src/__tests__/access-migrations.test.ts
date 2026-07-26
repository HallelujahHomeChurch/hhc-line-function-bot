import { describe, expect, it, vi } from "vitest";

import { runAccessMigrations } from "../access/migrations.js";

describe("access migrations", () => {
  it("adds privacy-safe last-success columns to existing principals", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runAccessMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("last_success_function_name text");
    expect(sql).toContain("last_success_at timestamptz");
    expect(sql).toContain("alter table access_principals");
    expect(sql).toContain("add column if not exists last_success_function_name");
    expect(sql).toContain("add column if not exists last_success_at");
  });

  it("migrates every retired capability grant to its canonical name", async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await runAccessMigrations({ query });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    for (const table of [
      "access_group_function_grants",
      "access_user_function_grants",
      "access_role_capability_bindings"
    ]) {
      expect(sql).toContain(table);
    }
    expect(sql).toContain("('query_service_schedule', 'query_schedule')");
    expect(sql).toContain("('find_pop_sheet_music', 'find_sheet_music')");
    expect(sql).toContain("('save_schedule_memory', 'save_schedule')");
    expect(sql).toContain("('query_schedule_memory', 'query_schedule')");
  });
});
