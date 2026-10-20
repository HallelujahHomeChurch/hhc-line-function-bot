import pg from "pg";
import type { DatabaseConfig } from "../types.js";
import { createPostgresPool } from "../db/postgres.js";

// This owner is terminal: abort cannot leave a checked-out query holding the job pool.
export function createCatalogSyncPostgres(
  config: DatabaseConfig,
  owner: { signal: AbortSignal; deadline: number }
) {
  const remaining = () => Math.max(1, owner.deadline - Date.now());
  const clients = new Map<pg.Client, Promise<void>>();
  class CatalogClient extends pg.Client {
    constructor(options?: pg.ClientConfig) {
      super({ ...options, connectionTimeoutMillis: remaining() });
      const ended = new Promise<void>((resolve) => this.once("end", resolve));
      clients.set(this, ended);
      this.once("end", () => clients.delete(this));
    }
  }
  const pool = createPostgresPool(config, {
    Client: CatalogClient,
    connectionTimeoutMillis: remaining()
  });
  const connect = pool.connect.bind(pool);
  // Native acquisition timers must also expire at this job's deadline, including late waiters.
  pool.connect = ((callback?: Parameters<pg.Pool["connect"]>[0]) => {
    pool.options.connectionTimeoutMillis = remaining();
    return callback ? connect(callback) : connect();
  }) as pg.Pool["connect"];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    owner.signal.removeEventListener("abort", stop);
    const owned = [...clients];
    let poolEnd: Promise<void>;
    try {
      poolEnd = pool.end();
    } catch (error) {
      poolEnd = Promise.reject(error);
    }
    closing = Promise.allSettled([
      poolEnd,
      ...owned.map(([client]) => Promise.resolve().then(() => client.end())),
      ...owned.map(([, ended]) => ended)
    ]).then((results) => {
      const errors: unknown[] = [];
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "catalog_pg_close_failed", { cause: errors[0] });
    });
    // Stop can run while a non-cancellable auth call is still pending; finalizer joins this same promise.
    void closing.catch(() => undefined);
    return closing;
  };
  const stop = () => {
    void close();
  };
  owner.signal.addEventListener("abort", stop, { once: true });
  if (owner.signal.aborted) stop();
  return { pool, close, signal: owner.signal };
}
