import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createPostgresPool } from "../db/postgres.js";

describe("PostgreSQL pool budget", () => {
  const pools: ReturnType<typeof createPostgresPool>[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it("caps each runtime pool at two connections", () => {
    const pool = createPostgresPool({ url: "postgres://localhost/example", ssl: false });
    pools.push(pool);

    expect(pool.options.max).toBe(2);
    expect(pool.options.connectionTimeoutMillis).toBe(2_000);
    expect(pool.options.statement_timeout).toBeUndefined();
  });
});

describe.skipIf(!process.env.KERNEL_POSTGRES_URL)("real PostgreSQL checkout budget", () => {
  it("rejects a saturated checkout and recovers without increasing max2", async () => {
    const url = process.env.KERNEL_POSTGRES_URL!;
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const pool = createPostgresPool({ url, ssl: false });
    const clients: PoolClient[] = [];
    try {
      clients.push(await pool.connect(), await pool.connect());
      expect(pool.totalCount).toBe(2);
      await expect(pool.connect()).rejects.toThrow("timeout exceeded when trying to connect");
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBe(2);
      clients.splice(0).forEach((client) => client.release());
      await expect(pool.query("select 1 as ok")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    } finally {
      clients.splice(0).forEach((client) => client.release());
      await pool.end();
    }
  }, 10_000);
});
