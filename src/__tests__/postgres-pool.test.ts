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
  });
});
