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
  return (kind === "consent"
    ? { ...common, type: "external_search_consent", action: "sheet_music_external_search" }
    : {
        ...common,
        type: "external_sheet_music_import",
        stage: kind,
        items: [{ title: "synthetic", url: "https://example.invalid/score.pdf" }]
      }) as unknown as ConversationSession;
}

describe("retired public sheet music", () => {
  it.each(["consent", "selecting", "awaiting_target", "awaiting_confirmation"] as const)(
    "ignores raw legacy %s state and never binds public research tools",
    async (kind) => {
      const app = fixture();
      await app.sessions.set(legacy(app, kind));
      await app.runtime.handleTextTurn(app.turn("請上網找歌譜"));
      expect(app.probe.boundToolSets.flat()).not.toContain("search_sheet_music_web");
      expect(app.probe.boundToolSets.flat()).not.toContain("read_sheet_music_page");
      expect(app.calls.size).toBe(0);
      expect(
        await app.jobs.latest?.({
          profileName: "helper",
          sourceKey: "user:U1",
          requesterUserId: "U1"
        })
      ).toBeUndefined();
    }
  );
});
