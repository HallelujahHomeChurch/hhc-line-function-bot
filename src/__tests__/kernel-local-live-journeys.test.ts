import { describe, expect, it } from "vitest";

import {
  KERNEL_LOCAL_LIVE_JOURNEYS,
  selectKernelLocalLiveJourneys
} from "../evals/kernel/local-live/journeys.js";

describe("Kernel local live journeys", () => {
  it("declares exactly eight fixed bounded journeys and expected outcomes", () => {
    expect(
      KERNEL_LOCAL_LIVE_JOURNEYS.map(({ caseId, expectedOutcome, turns }) => [
        caseId,
        expectedOutcome,
        turns.length
      ])
    ).toEqual([
      ["schedule-explicit", "execute", 1],
      ["schedule-refinement", "active_task_continuation", 2],
      ["schedule-ambiguity", "clarify", 1],
      ["capability-switch", "explicit_switch", 2],
      ["knowledge-follow-up", "grounded_follow_up", 2],
      ["group-requester-isolation", "requester_isolated", 1],
      ["provider-unavailable", "providers_unavailable", 1],
      ["write-preview-confirm", "confirmed_local_write", 5]
    ]);
    expect(Object.isFrozen(KERNEL_LOCAL_LIVE_JOURNEYS)).toBe(true);
    expect(KERNEL_LOCAL_LIVE_JOURNEYS.every(({ turns }) => Object.isFrozen(turns))).toBe(true);
    expect(
      KERNEL_LOCAL_LIVE_JOURNEYS.find(({ caseId }) => caseId === "knowledge-follow-up")?.turns[1]
        ?.message
    ).toEqual({ type: "text", text: "那最後由哪個角色驗證？" });
  });

  it("contains no loop, retry, random, or dynamically generated turn contract", () => {
    for (const journey of KERNEL_LOCAL_LIVE_JOURNEYS) {
      expect(journey.turns.length).toBeGreaterThan(0);
      expect(journey.turns.length).toBeLessThanOrEqual(5);
      expect(journey.turns.map(({ turnIndex }) => turnIndex)).toEqual(
        journey.turns.map((_, index) => index)
      );
      expect(new Set(journey.turns.map(({ turnIndex }) => turnIndex)).size).toBe(
        journey.turns.length
      );
    }
  });

  it("allows only one explicit declared case selection", () => {
    expect(
      selectKernelLocalLiveJourneys("knowledge-follow-up").map(({ caseId }) => caseId)
    ).toEqual(["knowledge-follow-up"]);
    expect(() => selectKernelLocalLiveJourneys("unknown-case")).toThrow(
      "kernel_local_live_case_unknown"
    );
  });
});
