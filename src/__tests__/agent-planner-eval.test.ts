import { describe, expect, it, vi } from "vitest";

import {
  AGENT_PLANNER_EVAL_CASES,
  evaluateAgentPlannerCases,
  type AgentPlannerEvalCase,
  runOfflineAgentPlannerEval
} from "../tools/eval-agent-planner.js";

describe("controlled agent planner eval corpus", () => {
  it("covers every acceptance boundary plus negative routing cases", async () => {
    const names = AGENT_PLANNER_EVAL_CASES.map(({ name }) => name);

    for (let acceptance = 1; acceptance <= 14; acceptance += 1) {
      expect(names.some((name) => name.startsWith(`acceptance-${acceptance}-`))).toBe(true);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "negative-no-capability",
        "disabled-capability",
        "ambiguous-active-entity",
        "cross-function-switch",
        "negative-overreaching-proposal"
      ])
    );
    expect(AGENT_PLANNER_EVAL_CASES.every((entry) => !("proposal" in entry))).toBe(true);
    expect(
      AGENT_PLANNER_EVAL_CASES.find(({ name }) => name === "disabled-capability")?.expectedFinal
    ).toMatchObject({ disposition: "deny", reasonCode: "function_disabled" });
    expect(
      AGENT_PLANNER_EVAL_CASES.find(({ name }) => name === "acceptance-11-model-cannot-inject-date")
        ?.expectedFinal
    ).toMatchObject({
      arguments: { meeting: "主日", role: "音控" },
      absentArgumentKeys: ["specificDate"]
    });
    expect(
      AGENT_PLANNER_EVAL_CASES.find(
        ({ name }) => name === "acceptance-9-requester-isolation-no-inherited-task"
      )
    ).toHaveProperty("requesterIsolation");
    expect(
      AGENT_PLANNER_EVAL_CASES.find(({ name }) => name === "acceptance-1-focused-schedule-role")
        ?.expectedProposal
    ).toMatchObject({
      arguments: { dateIntent: "next_meeting", role: "導播" },
      absentArgumentKeys: ["specificDate"]
    });
    expect(
      AGENT_PLANNER_EVAL_CASES.find(({ name }) => name === "acceptance-11-model-cannot-inject-date")
        ?.expectedProposal
    ).toMatchObject({
      arguments: { meeting: "主日", role: "音控" },
      absentArgumentKeys: ["specificDate"]
    });
    expect(
      AGENT_PLANNER_EVAL_CASES.filter(
        ({ expectedProposal }) => expectedProposal.status !== "no_plan"
      ).every(({ expectedProposal }) => Boolean(expectedProposal.arguments))
    ).toBe(true);
  });

  it("passes deterministic stub proposals through the real validator", async () => {
    const report = await runOfflineAgentPlannerEval();

    expect(report.total).toBe(AGENT_PLANNER_EVAL_CASES.length);
    expect(report.candidateFailures).toEqual([]);
    expect(report.proposalAttempted).toBe(report.total);
    expect(report.proposalPassed).toBe(report.total - 6);
    expect(report.proposalFailures).toEqual([
      "acceptance-1-focused-schedule-role:proposal",
      "acceptance-5-dynamic-knowledge-title:proposal",
      "acceptance-7-explicit-cross-function-switch:proposal",
      "acceptance-10-expired-task-unavailable:proposal",
      "acceptance-11-model-cannot-inject-date:proposal",
      "negative-overreaching-proposal:proposal"
    ]);
    expect(report.validatedFailures).toEqual([]);
    expect(report.validatedPassed).toBe(report.total);
    expect(JSON.stringify(report)).not.toMatch(
      /王小明|example\.invalid|主日服事表\.xlsx|private evidence|secret-token/u
    );
  });

  it("scores proposal arguments before deterministic validation repairs them", async () => {
    const base = AGENT_PLANNER_EVAL_CASES.find(
      ({ name }) => name === "acceptance-7-explicit-cross-function-switch"
    )!;
    const expectedProposal = {
      disposition: "switch" as const,
      capability: "query_schedule" as const,
      arguments: { meeting: "主日", role: "音控" },
      absentArgumentKeys: ["specificDate"]
    };
    const wrongArguments = {
      ...base,
      name: "proposal-wrong-arguments",
      expectedProposal
    } as AgentPlannerEvalCase;
    const injectedArgument = {
      ...base,
      name: "proposal-injected-argument",
      expectedProposal
    } as AgentPlannerEvalCase;
    const report = await evaluateAgentPlannerCases(
      async (entry) => ({
        status: "proposed",
        disposition: "switch",
        capability: "query_schedule",
        arguments:
          entry.name === wrongArguments.name
            ? { query: entry.text, meeting: "晨更", role: "導播" }
            : {
                query: entry.text,
                meeting: "主日",
                role: "音控",
                specificDate: "2027-07-14"
              },
        confidence: 0.96
      }),
      [wrongArguments, injectedArgument]
    );

    expect(report).toMatchObject({
      proposalAttempted: 2,
      proposalPassed: 0,
      proposalFailures: [`${wrongArguments.name}:proposal`, `${injectedArgument.name}:proposal`],
      validatedAttempted: 2,
      validatedPassed: 2,
      validatedFailures: []
    });
  });

  it("reports candidate failures separately and skips proposal scoring", async () => {
    const base = AGENT_PLANNER_EVAL_CASES[0]!;
    const entry = { ...base, expectedCandidates: ["query_knowledge"] } as AgentPlannerEvalCase;
    const propose = vi.fn();
    const report = await evaluateAgentPlannerCases(propose, [entry]);

    expect(propose).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      candidatePassed: 0,
      candidateAttempted: 1,
      candidateFailures: [expect.stringContaining(`${entry.name}:candidate_set:`)],
      proposalAttempted: 0,
      proposalPassed: 0,
      validatedAttempted: 0,
      validatedPassed: 0
    });
  });
});
