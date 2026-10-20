import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createCatalogSyncPostgres } from "../tools/catalog-sync-postgres.js";

const url = process.env.KERNEL_POSTGRES_URL;
describe.skipIf(!url)("catalog PG cancellation on owned CI PostgreSQL", () => {
  it("joins local shutdown then observes server exit without releasing the blocking lock", async () => {
    const name = `catalog-c2-${randomUUID()}`;
    const dsn = new URL(url!);
    dsn.searchParams.set("application_name", name);
    dsn.searchParams.set("statement_timeout", "0");
    dsn.searchParams.set("options", "-c statement_timeout=0");
    const observer = new pg.Pool({ connectionString: url!, max: 2 });
    const controller = new AbortController();
    const owner = createCatalogSyncPostgres(
      { url: dsn.toString(), ssl: false },
      { signal: controller.signal, deadline: Date.now() + 2_000 }
    );
    const lock = await observer.connect();
    let client: pg.PoolClient | undefined;
    let released = false;
    try {
      const key = 123_450 + Math.floor(Math.random() * 1_000_000);
      await lock.query("begin");
      await lock.query("select pg_advisory_xact_lock($1)", [key]);
      client = await owner.pool.connect();
      const effective = await client.query(
        "select setting from pg_settings where name='statement_timeout'"
      );
      const statementTimeoutMs = Number(effective.rows[0]?.setting);
      expect(statementTimeoutMs).toBeGreaterThan(0);
      expect(statementTimeoutMs).toBeLessThanOrEqual(2_000);
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
      const blockedAfterClose = await observer.query(
        "select count(*)::int count from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
        [name]
      );
      expect(blockedAfterClose.rows[0]?.count).toBe(1);
      console.info("catalog_pg_local_shutdown", {
        queryReturned: settled,
        clientAndPoolJoined: true,
        localPoolCount: owner.pool.totalCount,
        statementTimeoutMs,
        blockedBackendsWithFixtureLockHeld: blockedAfterClose.rows[0]?.count
      });
      // The server timeout must reap the blocked backend while the fixture lock remains held.
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
      const fixture = await lock.query(
        "select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) held"
      );
      expect(fixture.rows[0]?.held).toBe(true);
      console.info("catalog_pg_backend_exit_with_fixture_lock_held", {
        namedBackends: 0,
        fixtureLockHeld: true,
        localRollbackAcknowledged: false
      });
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

  it("receives a server statement timeout and rolls back before local client and pool shutdown", async () => {
    const name = `catalog-statement-${randomUUID()}`;
    const dsn = new URL(url!);
    dsn.searchParams.set("application_name", name);
    const observer = new pg.Pool({ connectionString: url!, max: 2 });
    const controller = new AbortController();
    const owner = createCatalogSyncPostgres(
      { url: dsn.toString(), ssl: false },
      { signal: controller.signal, deadline: Date.now() + 1_500 }
    );
    const lock = await observer.connect();
    let client: pg.PoolClient | undefined;
    try {
      const key = 2_000_000 + Math.floor(Math.random() * 1_000_000);
      await lock.query("begin");
      await lock.query("select pg_advisory_xact_lock($1)", [key]);
      client = await owner.pool.connect();
      await client.query("begin");
      await expect(client.query("select pg_advisory_xact_lock($1)", [key])).rejects.toMatchObject({
        code: "57014",
        message: expect.stringContaining("statement timeout")
      });
      await expect(client.query("select 1")).rejects.toMatchObject({ code: "25P02" });
      await client.query("rollback");
      await client.query("select 1");
      client.release();
      client = undefined;
      await owner.close();
      expect(owner.pool.totalCount).toBe(0);
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
      const fixture = await lock.query(
        "select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) held"
      );
      expect(fixture.rows[0]?.held).toBe(true);
      console.info("catalog_pg_server_timeout_and_rollback", {
        sqlState: "57014",
        transactionFailedState: "25P02",
        rollbackAcknowledged: true,
        clientAndPoolJoined: true,
        namedBackends: 0,
        fixtureLockHeld: true
      });
    } finally {
      controller.abort();
      if (client) {
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
