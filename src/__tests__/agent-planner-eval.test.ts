import { describe, expect, it } from "vitest";

import {
  AGENT_PLANNER_EVAL_CASES,
  runOfflineAgentPlannerEval
} from "../tools/eval-agent-planner.js";

describe("controlled agent planner eval corpus", () => {
  it("covers every acceptance boundary plus negative routing cases", async () => {
    const names = AGENT_PLANNER_EVAL_CASES.map(({ name }) => name);

    for (let acceptance = 1; acceptance <= 11; acceptance += 1) {
      expect(names.some((name) => name.startsWith(`acceptance-${acceptance}-`))).toBe(true);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "negative-no-capability",
        "disabled-capability",
        "ambiguous-active-entity",
        "cross-function-switch"
      ])
    );
  });

  it("passes deterministic stub proposals through the real validator", async () => {
    const report = await runOfflineAgentPlannerEval();

    expect(report.total).toBe(AGENT_PLANNER_EVAL_CASES.length);
    expect(report.proposalFailures).toEqual([]);
    expect(report.validatedFailures).toEqual([]);
    expect(report.validatedPassed).toBe(report.total);
    expect(JSON.stringify(report)).not.toMatch(
      /王小明|example\.invalid|主日服事表\.xlsx|private evidence|secret-token/u
    );
  });
});
