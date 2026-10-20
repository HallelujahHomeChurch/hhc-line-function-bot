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
    Client: class Client {},
    Pool: class Pool {
      constructor(public options: Record<string, unknown>) {}
      connect() {
        throw new Error("fixture_connect_unexpected");
      }
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
    vi.useRealTimers();
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
      const running = import("../tools/sync-catalog.js")
        .then(({ runCatalogSync }) => runCatalogSync(process.env))
        .then(
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
  it("starts its 540s budget before bootstrap and joins late query/close without more SQL", async () => {
    vi.useFakeTimers();
    const bootstrap = Promise.withResolvers<{ rows: never[] }>();
    const close = Promise.withResolvers<void>();
    fixtures.query.mockReturnValue(bootstrap.promise);
    fixtures.end.mockReturnValue(close.promise);
    const { runCatalogSync } = await import("../tools/sync-catalog.js");
    let settled = false;
    const running = runCatalogSync(process.env).then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    await vi.advanceTimersByTimeAsync(539_999);
    expect(fixtures.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixtures.end).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    bootstrap.resolve({ rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    const early = settled;
    close.resolve();
    const result = await running;
    expect(early).toBe(false);
    expect(result.name).toBe("TimeoutError");
    expect(fixtures.query).toHaveBeenCalledOnce();
    expect(fixtures.end).toHaveBeenCalledOnce();
  });

  it("preserves the work error and closing error rather than masking either", async () => {
    const primary = new Error("bootstrap_failed");
    const cleanup = new Error("close_failed");
    fixtures.query.mockRejectedValue(primary);
    fixtures.end.mockRejectedValue(cleanup);
    const { runCatalogSync } = await import("../tools/sync-catalog.js");
    const result = await runCatalogSync(process.env).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.cause).toBe(primary);
    expect(result.errors).toEqual([primary, cleanup]);
    expect(fixtures.end).toHaveBeenCalledOnce();
  });

  it("does not bootstrap an already stopped job", async () => {
    const reason = new Error("already_stopped");
    const { runCatalogSync } = await import("../tools/sync-catalog.js");
    await expect(runCatalogSync(process.env, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason
    );
    expect(fixtures.query).not.toHaveBeenCalled();
    expect(fixtures.end).not.toHaveBeenCalled();
  });
});
