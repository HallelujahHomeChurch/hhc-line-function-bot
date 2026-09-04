import { describe, expect, it } from "vitest";

import {
  createEvalProbe,
  createSyntheticScheduleRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";

describe("synthetic helper runtime fixture", () => {
  it("grounds an omitted schedule domain through the real handler", async () => {
    const probe = createEvalProbe();
    const fixture = await createSyntheticScheduleRuntimeFixture({
      model: instrumentedFakeModel(
        [
          [
            {
              name: "get_official_schedule",
              args: { query: "" },
              id: "schedule"
            }
          ],
          []
        ],
        probe
      ),
      probe
    });

    await fixture.runtime.handleTextTurn(fixture.turn("下一場服事"));

    const [{ args, result }] = fixture.calls.get("query_schedule") ?? [];
    expect(args.domainKey).toBeUndefined();
    expect(args.dateIntent).toBeUndefined();
    expect(result.agentResult?.anchors?.domainKey).toBe("official_service");
    expect(result.agentResult?.replyData?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-09-06", people: "合成目前同工" })
      ])
    );
  });
});
