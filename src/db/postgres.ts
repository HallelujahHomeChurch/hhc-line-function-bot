import pg from "pg";

import { runMediaSyncMigrations } from "../media-sync/migrations.js";
import { PostgresMediaSyncStore } from "../media-sync/store.js";
import type { DatabaseConfig } from "../types.js";

export interface PostgresRuntime {
  pool: pg.Pool;
  mediaSyncStore: PostgresMediaSyncStore;
}

export function createPostgresPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: 2
  });
}

export async function createPostgresRuntime(
  config: DatabaseConfig | undefined
): Promise<PostgresRuntime | undefined> {
  if (!config) {
    return undefined;
  }

  const pool = createPostgresPool(config);

  try {
    await pool.query("select 1");
    await runMediaSyncMigrations(pool);
    return { pool, mediaSyncStore: new PostgresMediaSyncStore(pool) };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
