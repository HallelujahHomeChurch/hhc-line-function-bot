import { describe, expect, it } from "vitest";

import {
  createEvalProbe,
  createSyntheticRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";

describe("synthetic helper runtime fixture", () => {
  it("grounds the canonical schedule domain used by follow-up evals", () => {
    const probe = createEvalProbe();
    const fixture = createSyntheticRuntimeFixture({
      model: instrumentedFakeModel([[]], probe),
      probe,
      enabledFunctions: ["query_schedule"],
      handlers: {
        query_schedule: async () => ({ ok: true, replyText: "synthetic schedule" })
      }
    });

    expect(fixture.profile.schedulePolicy?.domains).toEqual([
      expect.objectContaining({
        key: "official_service",
        aliases: expect.arrayContaining(["服事表"]),
        binding: {
          kind: "canonical",
          sourceKeys: ["official-service"],
          allowLiveFallback: false
        }
      })
    ]);
  });
});
