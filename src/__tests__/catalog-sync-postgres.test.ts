import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connectTimeouts: [] as unknown[],
  clients: [] as Array<{
    options: Record<string, unknown>;
    end: ReturnType<typeof vi.fn>;
    emit: (event: string) => boolean;
  }>,
  pool: undefined as unknown as { end: ReturnType<typeof vi.fn>; makeClient: () => void }
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    end = vi.fn(async () => {
      this.emit("end");
    });
    constructor(public options: Record<string, unknown>) {
      super();
      state.clients.push(this);
    }
  }
  class Pool extends EventEmitter {
    end = vi.fn().mockResolvedValue(undefined);
    constructor(public options: { Client?: typeof Client; connectionTimeoutMillis?: number }) {
      super();
      state.pool = this;
    }
    connect() {
      state.connectTimeouts.push(this.options.connectionTimeoutMillis);
      return Promise.resolve(undefined);
    }
    makeClient() {
      new (this.options.Client ?? Client)(this.options);
    }
  }
  return { default: { Client, Pool } };
});
import { createCatalogSyncPostgres } from "../tools/catalog-sync-postgres.js";

const config = { url: "postgres://fixture.invalid/test", ssl: false };
describe("catalog-owned PG lifecycle", () => {
  beforeEach(() => {
    state.clients = [];
    state.connectTimeouts = [];
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());
  it("computes a positive remaining native connect timeout at every client birth", async () => {
    const owner = createCatalogSyncPostgres(config, {
      signal: new AbortController().signal,
      deadline: 540_000
    });
    state.pool.makeClient();
    await vi.advanceTimersByTimeAsync(120_000);
    state.pool.makeClient();
    const first = state.clients[0]!.options.connectionTimeoutMillis;
    const second = state.clients[1]!.options.connectionTimeoutMillis;
    await vi.advanceTimersByTimeAsync(500_000);
    state.pool.makeClient();
    const expired = state.clients[2]!.options.connectionTimeoutMillis;
    await owner.close();
    expect(first).toBe(540_000);
    expect(second).toBe(420_000);
    expect(expired).toBe(1);
  });
  it("anchors each queued pool acquisition timeout to the same remaining work budget", async () => {
    const owner = createCatalogSyncPostgres(config, {
      signal: new AbortController().signal,
      deadline: 540_000
    });
    await owner.pool.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    await owner.pool.connect();
    await owner.close();
    expect(state.connectTimeouts).toEqual([540_000, 420_000]);
  });
  it("keeps the job statement budget authoritative over DSN and startup options", async () => {
    const dsn = new URL(config.url);
    dsn.searchParams.set("statement_timeout", "0");
    dsn.searchParams.set("options", "-c application_name=catalog-test -c statement_timeout=0");
    const owner = createCatalogSyncPostgres(
      { ...config, url: dsn.toString() },
      {
        signal: new AbortController().signal,
        deadline: 540_000
      }
    );
    state.pool.makeClient();
    await vi.advanceTimersByTimeAsync(120_000);
    state.pool.makeClient();
    await vi.advanceTimersByTimeAsync(500_000);
    state.pool.makeClient();
    await owner.close();
    const settings = state.clients.map(({ options }) => {
      const parsed = new URL(String(options.connectionString));
      return {
        constructor: options.statement_timeout,
        dsn: parsed.searchParams.get("statement_timeout"),
        startup: parsed.searchParams.get("options")
      };
    });
    expect(settings).toEqual(
      [540_000, 420_000, 1].map((budget) => ({
        constructor: budget,
        dsn: String(budget),
        startup: `-c application_name=catalog-test -c statement_timeout=0 -c statement_timeout=${budget}`
      }))
    );
  });
  it("starts terminal close on abort and joins actual physical client end as well as pool end once", async () => {
    const controller = new AbortController();
    const owner = createCatalogSyncPostgres(config, {
      signal: controller.signal,
      deadline: 540_000
    });
    state.pool.makeClient();
    const client = state.clients[0]!;
    const end = Promise.withResolvers<void>();
    const poolEnd = Promise.withResolvers<void>();
    client.end.mockReturnValue(end.promise);
    state.pool.end.mockReturnValue(poolEnd.promise);
    controller.abort(new Error("stopped"));
    await vi.advanceTimersByTimeAsync(0);
    const terminalStarted = client.end.mock.calls.length;
    let settled = false;
    const close = owner.close();
    const again = owner.close();
    const observed = close.then(() => {
      settled = true;
    });
    end.resolve();
    poolEnd.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforePhysicalEnd = settled;
    client.emit("end");
    await observed;
    expect(terminalStarted).toBe(1);
    expect(close).toBe(again);
    expect(state.pool.end).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
    expect(settledBeforePhysicalEnd).toBe(false);
  });
});
