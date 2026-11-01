import { describe, expect, it } from "vitest";
import { createEvalProbe, instrumentedFakeModel } from "../evals/synthetic-runtime-fixture.js";
import { createSyntheticRuntimeFixture } from "../evals/synthetic-runtime-fixture.js";
import type { ConversationSession } from "../state/session-store.js";

function fixture() {
  const probe = createEvalProbe();
  return createSyntheticRuntimeFixture({
    model: instrumentedFakeModel([[]], probe),
    probe,
    enabledFunctions: ["find_sheet_music", "save_resource"]
  });
}

function legacy(
  app: ReturnType<typeof fixture>,
  kind: "consent" | "selecting" | "awaiting_target" | "awaiting_confirmation"
): ConversationSession {
  const common = {
    id: "old-session",
    profileName: "helper",
    requesterUserId: app.source.userId,
    source: app.source,
    query: "synthetic song",
    expiresAt: "2026-09-04T00:10:00Z"
  };
  return kind === "consent"
    ? { ...common, type: "external_search_consent", action: "sheet_music_external_search" }
    : {
        ...common,
        type: "external_sheet_music_import",
        stage: kind,
        items: [{ title: "synthetic", url: "https://example.invalid/score.pdf" }]
      };
}

describe("retired public sheet music", () => {
  it.each([
    ["consent", "上網找"],
    ["consent", "不用"],
    ["selecting", "1"],
    ["awaiting_target", "詩歌歌譜"],
    ["awaiting_confirmation", "保存"]
  ] as const)(
    "terminates scoped legacy %s on %s without model or work execution",
    async (kind, text) => {
      const app = fixture();
      await app.sessions.set(legacy(app, kind));
      const result = await app.runtime.handleRetiredSheetMusic!(app.turn(text));
      expect(result).toMatchObject({ ok: true, replyText: expect.stringContaining("已停用") });
      expect(result?.writePhase).toBeUndefined();
      expect(app.probe.values().modelCalls).toBe(0);
      expect(app.calls.size).toBe(0);
      expect(await app.sessions.get("old-session")).toBeUndefined();
      expect(
        await app.jobs.latest?.({
          profileName: "helper",
          sourceKey: "user:U1",
          requesterUserId: "U1"
        })
      ).toBeUndefined();
      expect(await app.runtime.handleRetiredSheetMusic!(app.turn(text))).toBeUndefined();
    }
  );

  it.each(["requester", "source", "profile", "missing-requester", "expired"] as const)(
    "does not consume legacy state for %s",
    async (difference) => {
      const app = fixture();
      const old = legacy(app, "consent");
      if (difference === "expired") old.expiresAt = "2026-09-03T00:00:00Z";
      await app.sessions.set(old);
      const turn = app.turn("上網找");
      if (difference === "requester") turn.event.source = { type: "user", userId: "other" };
      if (difference === "source")
        turn.event.source = { type: "group", groupId: "other", userId: app.source.userId };
      if (difference === "profile") turn.profile = { ...turn.profile, name: "main" };
      if (difference === "missing-requester")
        turn.event.source = { type: "group", groupId: "synthetic" };
      expect(await app.runtime.handleRetiredSheetMusic!(turn)).toBeUndefined();
      expect(app.probe.values().modelCalls).toBe(0);
      if (difference !== "expired") expect(await app.sessions.get(old.id)).toEqual(old);
    }
  );

  it.each(["1", "保存", "上網找"])(
    "does not interpret %s without a legacy session",
    async (text) => {
      const app = fixture();
      expect(await app.runtime.handleRetiredSheetMusic!(app.turn(text))).toBeUndefined();
    }
  );

  it("does not intercept ordinary messages or current internal selections", async () => {
    const app = fixture();
    await app.sessions.set(legacy(app, "selecting"));
    expect(await app.runtime.handleRetiredSheetMusic!(app.turn("請查明天排班"))).toBeUndefined();
    expect(await app.sessions.get("old-session")).toBeDefined();
    await app.sessions.set({
      id: "current-selection",
      type: "selection",
      action: "select_sheet_music",
      profileName: "helper",
      source: app.source,
      requesterUserId: app.source.userId,
      items: [],
      expiresAt: "2026-09-04T00:10:00Z"
    });
    expect(await app.runtime.handleRetiredSheetMusic!(app.turn("1"))).toBeUndefined();
    expect(await app.sessions.get("current-selection")).toBeDefined();
    expect(await app.sessions.get("old-session")).toBeUndefined();
  });

  it("never binds public search or page tools on an ordinary turn", async () => {
    const app = fixture();
    await app.runtime.handleTextTurn(app.turn("請上網找歌譜"));
    expect(app.probe.boundToolSets.flat()).not.toContain("search_sheet_music_web");
    expect(app.probe.boundToolSets.flat()).not.toContain("read_sheet_music_page");
  });
});
