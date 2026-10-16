import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMediaSyncStatusQuery, statusCursor } from "../media-sync/status.js";
import { PostgresMediaSyncStore } from "../media-sync/store.js";
import { runMediaSyncMigrations } from "../media-sync/migrations.js";

const window = { from: "2026-10-16T00:00:00.000Z", until: "2026-10-17T00:00:00.000Z" };
const now = Date.parse(window.until);
const item = {
  workId: "018f0c1f-18d0-7e81-9f6f-69c456db7003",
  mediaKind: "image" as const,
  status: "received" as const,
  receivedAt: "2026-10-16T12:00:00.123456Z",
  updatedAt: "2026-10-16T12:00:00.123456Z",
  failure: null
};
it("binds cursors to collection and exact bounded window while preserving microseconds", () => {
  const query = { ...window, limit: 25 };
  const cursor = statusCursor("one", query, item);
  expect(parseMediaSyncStatusQuery({ ...window, cursor }, "one", now)?.after).toEqual({
    createdAt: item.receivedAt,
    workId: item.workId
  });
  expect(parseMediaSyncStatusQuery({ ...window, cursor }, "two", now)).toBeUndefined();
  expect(
    parseMediaSyncStatusQuery({ ...window, from: "2026-10-15T00:00:00.000Z", cursor }, "one", now)
  ).toBeUndefined();
});
it.each([
  { from: "2026-02-30T00:00:00.000Z", until: "2026-03-03T00:00:00.000Z" },
  { limit: "51" },
  { limit: "0" },
  { limit: ["1", "2"] },
  { cursor: "invalid" },
  { unknown: "value" },
  { from: "2026-10-01T00:00:00.000Z" },
  { until: "2027-10-17T00:00:00.000Z" },
  { until: window.from }
])("rejects malformed or unbounded status queries %j", (change) => {
  expect(parseMediaSyncStatusQuery({ ...window, ...change }, "one", now)).toBeUndefined();
});
const databaseUrl = process.env.KERNEL_POSTGRES_URL;
describe.runIf(Boolean(databaseUrl))("media status PostgreSQL projection", () => {
  let owner: Pool, pool: Pool, store: PostgresMediaSyncStore;
  const schema = `media_status_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    owner = new Pool({ connectionString: databaseUrl });
    await owner.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await runMediaSyncMigrations(pool);
    store = new PostgresMediaSyncStore(pool);
    await pool.query(`insert into media_sync_ingests
      (source_key, profile_name, message_id, group_id, collection_id, state, display_name, media_kind, expected_mime, created_at, updated_at)
      select 'source-'||n, 'helper', 'message-'||n, 'group', 'one',
        case when n<=40 then 'ready' when n<=50 then 'awaiting_scan' else 'failed' end,
        'private filename', 'image', 'image/jpeg', '2026-10-16T12:00:00.123456Z', '2026-10-16T12:01:00Z'
      from generate_series(1,60) n`);
    await pool.query(`insert into media_sync_publications(source_key, publication_type, destination_id, state, failure_category)
      select source_key, 'collection', collection_id, case when state='ready' then 'published' when state='failed' then 'failed' else 'pending' end,
        case when state='failed' then 'private-error-payload' end from media_sync_ingests`);
    await pool.query(`insert into media_sync_publications(source_key, publication_type, destination_id, state)
      select source_key, 'manual', 'manual-destination', 'published' from media_sync_ingests`);
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) {
      await owner.query(`drop schema "${schema}" cascade`);
      await owner.end();
    }
  });
  it("counts 60 unique sources without manual publication duplication and paginates equal timestamps", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = parseMediaSyncStatusQuery(
        { ...window, limit: "25", ...(cursor ? { cursor } : {}) },
        "one",
        now
      )!;
      const page = await store.listCollectionStatus("one", query);
      expect(page.totalReceived).toBe(60);
      expect(page.counts).toMatchObject({ published: 40, awaiting_scan: 10, failed: 10 });
      expect(JSON.stringify(page)).not.toMatch(/private|message-|source-|manual-destination/);
      for (const result of page.items) {
        expect(seen.has(result.workId)).toBe(false);
        seen.add(result.workId);
      }
      cursor = page.cursor;
    } while (cursor);
    expect(seen.size).toBe(60);
    expect(
      (await store.listCollectionStatus("foreign", { ...window, limit: 25 })).totalReceived
    ).toBe(0);
  });
  it("reflects tombstones and revocations without treating stale published rows as success", async () => {
    await pool.query(
      "update media_sync_ingests set state='tombstoned', tombstoned_at=now() where source_key='source-1'"
    );
    await pool.query(
      "update media_sync_publications set state='revoked' where source_key='source-2' and publication_type='collection'"
    );
    const page = await store.listCollectionStatus("one", { ...window, limit: 50 });
    expect(page.counts).toMatchObject({ published: 38, tombstoned: 1, cancelled: 1 });
    expect(page.totalReceived).toBe(60);
  });
});
