import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createKernelPostgresEnvironment } from "../evals/kernel/integration/environment.js";
import { PostgresGroupHistory } from "../history/postgres.js";
import type { HistoryConfig } from "../history/types.js";

const source = { type: "group", groupId: "synthetic-a", userId: "synthetic-member" };
const scope = { profileName: "helper", source };
const config: HistoryConfig = {
  enabled: true,
  generation: 1,
  restoreEpoch: "synthetic-restore-epoch",
  retentionDays: 90,
  maxGroupMessages: 100,
  maxGroupBytes: 100000,
  maxTotalMessages: 200,
  maxTotalBytes: 200000,
  maxMessageBytes: 4000,
  policies: [
    {
      profileName: "helper",
      groupId: "synthetic-a",
      revision: "v1",
      enabledAt: new Date(Date.now() - 40 * 86400000).toISOString(),
      excludedRequesterIds: []
    }
  ]
};

describe("bounded group history in real PostgreSQL", () => {
  it("isolates groups, shares with new members, deduplicates, fences withdrawal, expiry, revision and restore", async () => {
    const env = await createKernelPostgresEnvironment();
    try {
      const pool = env.pools[0];
      const sql = await readFile(
        new URL("../../migrations/20261030-group-history.sql", import.meta.url),
        "utf8"
      );
      await pool.query(sql);
      await pool.query(sql);
      const store = new PostgresGroupHistory(pool, config, "synthetic-key", async () => true);
      await store.synchronize();
      const now = new Date();
      const timestamp = now.getTime() - 10000;
      const event = {
        type: "message",
        timestamp,
        message: { id: "m1", type: "text", text: "聚會改成週五" }
      };
      await store.ingest(scope, event);
      await store.ingest(scope, event);
      const query = {
        start: new Date(timestamp - 1000).toISOString(),
        end: now.toISOString(),
        topic: "聚會"
      };
      const result = await store.search(scope, query, now);
      expect(result.records.map((r) => r.text)).toEqual(["聚會改成週五"]);
      expect(await store.validate(scope, result.dependency!)).toBe(true);
      expect(
        (await store.search({ ...scope, source: { ...source, userId: "new-member" } }, query, now))
          .records
      ).toEqual(result.records);
      expect(
        (
          await store.search(
            { ...scope, source: { ...source, groupId: "synthetic-b" } },
            query,
            now
          )
        ).records
      ).toEqual([]);
      expect(
        await store.validate(
          { ...scope, source: { ...source, groupId: "synthetic-b" } },
          result.dependency!
        )
      ).toBe(false);
      await store.ingest(scope, {
        type: "message",
        timestamp: timestamp - 86400000,
        message: { id: "old-decision", type: "text", text: "舊提議：聚會週五" }
      });
      await store.ingest(scope, {
        type: "message",
        timestamp: timestamp - 43200000,
        message: {
          id: "new-correction",
          type: "text",
          text: "跨日更正：改週六",
          quotedMessageId: "old-decision"
        }
      });
      const month = await store.search(
        scope,
        {
          start: new Date(timestamp - 30 * 86400000).toISOString(),
          end: now.toISOString(),
          topic: "聚會"
        },
        now
      );
      expect(month.records.some((r) => r.text === "舊提議：聚會週五")).toBe(true);
      expect(month.records.some((r) => r.text === "跨日更正：改週六")).toBe(true);
      expect(month.incomplete).toBe(true);
      await store.ingest(scope, { type: "unsend", timestamp, unsend: { messageId: "m1" } });
      await store.ingest(scope, event);
      expect((await store.search(scope, query, now)).records).toEqual([]);
      expect(await store.validate(scope, result.dependency!)).toBe(false);
      await store.ingest(scope, { type: "unsend", timestamp, unsend: { messageId: "m2" } });
      await store.ingest(scope, { ...event, message: { ...event.message, id: "m2" } });
      expect((await store.search(scope, query, now)).records).toEqual([]);
      await store.ingest(scope, { ...event, message: { ...event.message, id: "m3" } });
      await store.recordReply(scope, [{ id: "bot-anchor", text: "聚會週五，合成安全節錄" }]);
      await store.ingest(scope, {
        ...event,
        message: {
          id: "short-correction",
          type: "text",
          text: "改週六",
          quotedMessageId: "bot-anchor"
        }
      });
      const anchored = await store.search(
        scope,
        { ...query, end: new Date(Date.now() + 1).toISOString(), topic: "改週六" },
        new Date()
      );
      expect(anchored.records.some((r) => r.speaker === "bot-reference")).toBe(true);
      const ordinary = await store.search(scope, { ...query, topic: "安全節錄" }, new Date());
      expect(ordinary.records).toEqual([]);
      const live = await store.search(scope, query, now);
      await pool.query("update group_history_message set expires_at=now()-interval '1 second'");
      expect(await store.validate(scope, live.dependency!)).toBe(false);
      expect((await store.search(scope, query, now)).records).toEqual([]);
      const restored = new PostgresGroupHistory(
        pool,
        { ...config, generation: 2, restoreEpoch: "new-restore-epoch" },
        "synthetic-key",
        async () => true
      );
      await restored.synchronize();
      expect(await restored.validate(scope, result.dependency!)).toBe(false);
      const disabled = new PostgresGroupHistory(
        pool,
        { ...config, generation: 3, enabled: false },
        "synthetic-key",
        async () => true
      );
      await disabled.synchronize();
      await disabled.purge();
      expect(
        (await pool.query("select count(*)::int as n from group_history_message")).rows[0].n
      ).toBe(0);

      const capped = new PostgresGroupHistory(
        pool,
        { ...config, generation: 4, maxGroupMessages: 2 },
        "synthetic-key",
        async () => true
      );
      await capped.synchronize();
      for (let i = 0; i < 5; i++)
        await capped.ingest(scope, {
          ...event,
          timestamp: timestamp + i,
          message: { id: `cap-${i}`, type: "text", text: "容量合成資料" }
        });
      expect(
        (await pool.query("select count(*)::int as n from group_history_message")).rows[0].n
      ).toBeLessThanOrEqual(2);
      await store.synchronize(); // an older process cannot promote its stale configuration
      await store.ingest(scope, event);
      expect((await store.search(scope, query, new Date())).status).toBe("unavailable");
      expect(
        (await pool.query("select generation from group_history_control")).rows[0].generation
      ).toBe("4");
    } finally {
      await env.cleanup();
    }
  });
});
