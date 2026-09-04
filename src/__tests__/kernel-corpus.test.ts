import { describe, expect, it } from "vitest";

import { SDK_AGENT_ACCEPTANCE_CASES, validateSdkAgentCorpus } from "../evals/kernel/corpus.js";

describe("SDK agent acceptance corpus", () => {
  it("keeps the approved multi-turn, cross-source, write-safety, and main isolation coverage", () => {
    expect(validateSdkAgentCorpus()).toEqual([]);
    expect(SDK_AGENT_ACCEPTANCE_CASES).toHaveLength(30);
    expect(
      SDK_AGENT_ACCEPTANCE_CASES.filter(({ category }) => category === "cross_source")
    ).toHaveLength(20);
    expect(
      SDK_AGENT_ACCEPTANCE_CASES.filter(({ expected }) => expected.writes === 1).every(
        ({ expected }) => expected.approvalRequired
      )
    ).toBe(true);
    expect(
      SDK_AGENT_ACCEPTANCE_CASES.find(({ id }) => id === "sdk-v1/main/provider-free@1")?.expected
        .providerCalls
    ).toBe(0);
  });

  it("rejects unsafe writes and duplicate IDs", () => {
    const base = SDK_AGENT_ACCEPTANCE_CASES[0]!;
    expect(
      validateSdkAgentCorpus([
        ...SDK_AGENT_ACCEPTANCE_CASES,
        { ...base, expected: { ...base.expected, writes: 1, approvalRequired: false } }
      ])
    ).toEqual(
      expect.arrayContaining([`duplicate_case_id:${base.id}`, `write_without_approval:${base.id}`])
    );
  });
});
