import pg from "pg";
import { runAccessMigrations } from "../access/migrations.js";

import { runMediaSyncMigrations } from "../media-sync/migrations.js";
import { PostgresMediaSyncStore } from "../media-sync/store.js";
import type { DatabaseConfig } from "../types.js";

export interface PostgresRuntime {
  pool: pg.Pool;
  mediaSyncStore: PostgresMediaSyncStore;
}

export function createPostgresPool(
  config: DatabaseConfig,
  options: Pick<pg.PoolConfig, "Client" | "connectionTimeoutMillis"> = {}
): pg.Pool {
  return new pg.Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: 2,
    connectionTimeoutMillis: 2_000,
    ...options
  });
}

export async function createPostgresRuntime(
  config: DatabaseConfig | undefined,
  owned?: { pool: pg.Pool; signal?: AbortSignal; close(): Promise<void> }
): Promise<PostgresRuntime | undefined> {
  if (!config) {
    return undefined;
  }

  const pool = owned?.pool ?? createPostgresPool(config);

  try {
    owned?.signal?.throwIfAborted();
    await pool.query("select 1");
    owned?.signal?.throwIfAborted();
    await runAccessMigrations(pool);
    owned?.signal?.throwIfAborted();
    await runMediaSyncMigrations(pool);
    owned?.signal?.throwIfAborted();
    return { pool, mediaSyncStore: new PostgresMediaSyncStore(pool) };
  } catch (error) {
    await (owned ? owned.close() : pool.end()).catch(() => undefined);
    throw error;
  }
}
