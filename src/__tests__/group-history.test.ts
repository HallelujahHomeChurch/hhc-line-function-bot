import { describe, expect, it, vi } from "vitest";
import { historyTimeRange } from "../history/time.js";
import { historyConfigSchema, loadHistoryConfig } from "../history/config.js";
import { createHistoryTurn } from "../helper-agent/history-tools.js";
import { deliveredContextText, replyProjection } from "../quotes/reply-projection.js";
import type { GroupHistory } from "../history/types.js";
const scope = {
  profileName: "helper",
  source: { type: "group", groupId: "synthetic", userId: "synthetic" }
};
const now = new Date("2026-10-30T16:01:00Z");
describe("group history boundary", () => {
  it("resolves relative dates at fixed turn time and group timezone", () => {
    expect(historyTimeRange("yesterday", now, "Asia/Taipei")).toEqual({
      start: "2026-10-29T16:00:00.000Z",
      end: "2026-10-30T16:00:00.000Z"
    });
    expect(historyTimeRange("recent", now, "Asia/Taipei").start).toBe("2026-10-30T15:31:00.000Z");
    expect(historyTimeRange("last_week", now, "Asia/Taipei")).toEqual({
      start: "2026-10-18T16:00:00.000Z",
      end: "2026-10-25T16:00:00.000Z"
    });
  });
  it("defaults off and refuses unlimited or unordered capacities", () => {
    expect(loadHistoryConfig(undefined)).toBeUndefined();
    expect(historyConfigSchema.safeParse({ enabled: true }).success).toBe(false);
  });
  it("bounds unique evidence across two calls and rejects model-owned scope", async () => {
    const history: GroupHistory = {
      enabledFor: () => true,
      ingest: vi.fn(),
      purge: vi.fn(),
      validate: vi.fn(async () => true),
      search: vi.fn(async () => ({
        status: "success",
        start: now.toISOString(),
        end: now.toISOString(),
        incomplete: true,
        records: Array.from({ length: 10 }, (_, i) => ({
          key: String(i),
          speaker: "speaker-1",
          at: now.toISOString(),
          text: "合成證據".repeat(20)
        })),
        dependency: { scope: "opaque", revision: "v1", epoch: "v1", keys: ["1"] }
      }))
    };
    const turn = createHistoryTurn(history, scope, now, async () => {});
    const tool = turn.tools[0]!;
    const first = await tool.invoke({ period: "recent" });
    const second = await tool.invoke({ period: "recent" });
    expect(first).toEqual(second);
    expect(turn.evidenceBytes).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(first)).not.toContain('"key":');
    expect(turn.lookupCount).toBe(2);
    await tool.invoke({ period: "recent" });
    expect(history.search).toHaveBeenCalledTimes(2);
    await expect(tool.invoke({ period: "recent", groupId: "other" })).rejects.toThrow();
  });
  it("never retains a history-derived answer as later checkpoint or quote text", () => {
    expect(
      deliveredContextText(
        "SENSITIVE_DERIVED",
        replyProjection({ ok: true, replyText: "SENSITIVE_DERIVED", historyDependencies: [] })
      )
    ).toBeNull();
  });
});
