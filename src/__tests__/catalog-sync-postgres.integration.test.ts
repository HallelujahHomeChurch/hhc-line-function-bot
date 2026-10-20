import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createCatalogSyncPostgres } from "../tools/catalog-sync-postgres.js";

const url = process.env.KERNEL_POSTGRES_URL;
describe.skipIf(!url)("catalog PG cancellation on owned CI PostgreSQL", () => {
  it("joins local shutdown while blocked, then observes backend exit after the server wait resolves", async () => {
    const name = `catalog-c2-${randomUUID()}`;
    const dsn = new URL(url!);
    dsn.searchParams.set("application_name", name);
    const observer = new pg.Pool({ connectionString: url!, max: 2 });
    const controller = new AbortController();
    const owner = createCatalogSyncPostgres(
      { url: dsn.toString(), ssl: false },
      { signal: controller.signal, deadline: Date.now() + 10_000 }
    );
    const lock = await observer.connect();
    let client: pg.PoolClient | undefined;
    let released = false;
    try {
      const key = 123_450 + Math.floor(Math.random() * 1_000_000);
      await lock.query("begin");
      await lock.query("select pg_advisory_xact_lock($1)", [key]);
      client = await owner.pool.connect();
      await client.query("begin");
      let settled = false;
      let failure: unknown;
      const work = client.query("select pg_advisory_xact_lock($1)", [key]).then(
        () => {
          settled = true;
        },
        (error) => {
          failure = error;
          settled = true;
        }
      );
      await expect
        .poll(
          async () => {
            const result = await observer.query(
              "select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock') blocked",
              [name]
            );
            return result.rows[0]?.blocked;
          },
          { timeout: 5000 }
        )
        .toBe(true);
      controller.abort(new Error("catalog_job_stopped"));
      await expect.poll(() => settled, { timeout: 5000 }).toBe(true);
      await work;
      expect(failure).toBeInstanceOf(Error);
      // Do not release the observer lock until actual query return has been observed.
      client.release();
      released = true;
      await owner.close();
      expect(owner.pool.totalCount).toBe(0);
      // Socket shutdown is not server-side query cancellation; unblock PostgreSQL before observing exit.
      await lock.query("rollback");
      await expect
        .poll(
          async () => {
            const result = await observer.query(
              "select count(*)::int count from pg_stat_activity where application_name=$1",
              [name]
            );
            return result.rows[0]?.count;
          },
          { timeout: 5000 }
        )
        .toBe(0);
    } finally {
      controller.abort();
      if (client && !released) {
        await client.end().catch(() => undefined);
        client.release();
      }
      await lock.query("rollback").catch(() => undefined);
      lock.release();
      await owner.close().catch(() => undefined);
      await observer.end();
    }
  }, 15_000);
});
