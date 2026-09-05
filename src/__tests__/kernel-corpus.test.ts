import { describe, expect, it } from "vitest";

import { AGENT_EVAL_CASES, validateAgentEvalCorpus } from "../evals/kernel/corpus.js";

describe("SDK agent acceptance corpus", () => {
  it("keeps every final helper runtime boundary in the offline corpus", () => {
    const requiredCases = [
      "conversation/greeting",
      "schedule/latest-default",
      "schedule/note-authority-separation",
      "schedule/follow-up-next-period",
      "retrieval/genuine-ambiguity",
      "wikipedia/fixed-source",
      "tool/authorization-recheck",
      "review/approve-once",
      "review/revision-invalidates-original",
      "review/group-requester-isolation",
      "context/clear-tool-results-before-summary",
      "context/hard-budget-end",
      "error/checkpoint-unavailable-no-provider",
      "error/provider-failure-support-id",
      "action/reply-failure-durable-result",
      "web/prompt-injection-contained",
      "main/provider-free"
    ];

    expect(validateAgentEvalCorpus()).toEqual([]);
    expect(AGENT_EVAL_CASES.map(({ id }) => id)).toEqual(requiredCases);
  });

  it("rejects missing, duplicate, and unexpected boundary IDs", () => {
    const missing = AGENT_EVAL_CASES[0]!;
    const duplicate = AGENT_EVAL_CASES[1]!;
    expect(
      validateAgentEvalCorpus([...AGENT_EVAL_CASES.slice(1), duplicate, { id: "extra/case" }])
    ).toEqual(
      expect.arrayContaining([
        `missing_case_id:${missing.id}`,
        `duplicate_case_id:${duplicate.id}`,
        "unexpected_case_id:extra/case"
      ])
    );
  });
});
