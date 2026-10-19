import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  config: {
    database: { url: "postgres://catalog.invalid/test", ssl: false },
    profiles: [] as { name: string }[]
  },
  query: vi.fn(),
  end: vi.fn()
}));

vi.mock("../config.js", () => ({
  loadCatalogSyncConfigFromEnv: () => fixtures.config
}));
vi.mock("pg", () => ({
  default: {
    Pool: class Pool {
      query(sql: string, values?: unknown[]) {
        return fixtures.query(sql, values);
      }
      end() {
        return fixtures.end();
      }
    }
  }
}));

describe("catalog sync job PostgreSQL lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    fixtures.config.profiles = [];
    fixtures.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("from pg_extension") ? [{ extversion: "0.8.0" }] : [],
      rowCount: 0
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ["catalog initialization", "create table if not exists catalog_sources"],
    ["catalog seeding", "insert into catalog_sources"],
    ["schedule initialization", "create table if not exists schedule_items"],
    ["knowledge extension verification", "from pg_extension"],
    ["knowledge initialization", "create table if not exists knowledge_sources"],
    ["catalog sync", "from catalog_sources"],
    ["knowledge purge", "delete from knowledge_sources"],
    ["successful sync", undefined]
  ])(
    "awaits pool closure after %s",
    async (stage, failingSql) => {
      const error = new Error(`${stage} failed`);
      if (stage === "catalog seeding") {
        fixtures.config.profiles = [{ name: "helper" }];
        vi.stubEnv("GRAPH_DRIVE_ID", "fixture-drive");
        vi.stubEnv("GRAPH_PPT_FOLDER_ITEM_ID", "fixture-folder");
      }
      if (failingSql) {
        const query = fixtures.query.getMockImplementation()!;
        fixtures.query.mockImplementation(async (sql: string) => {
          if (sql.includes(failingSql)) throw error;
          return query(sql);
        });
      }

      const close = Promise.withResolvers<void>();
      const progress = Promise.withResolvers<"closing" | "settled">();
      fixtures.end.mockImplementation(() => {
        progress.resolve("closing");
        return close.promise;
      });
      let settled = false;
      const running = import("../tools/sync-catalog.js").then(
        () => {
          settled = true;
          progress.resolve("settled");
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          progress.resolve("settled");
          return error;
        }
      );

      try {
        expect(await progress.promise).toBe("closing");
        expect(fixtures.end).toHaveBeenCalledTimes(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
      } finally {
        close.resolve();
        await running;
      }

      expect(await running).toBe(failingSql ? error : undefined);
      expect(fixtures.end).toHaveBeenCalledTimes(1);
    },
    15_000
  );
});
