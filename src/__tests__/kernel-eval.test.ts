import { describe, expect, it } from "vitest";

import type { KernelAcceptanceCase, KernelCaseObservation } from "../evals/kernel/contracts.js";
import { evaluateKernelGate } from "../evals/kernel/evaluate.js";

function observation(caseId: string, passed: boolean): KernelCaseObservation {
  return {
    caseId,
    passed,
    boundary: "adapter_retrieval",
    recurrenceFamily: "stale_result_replay",
    scheduleAssertions: [{ passed }],
    coreJourneyEligible: true,
    coreJourneySucceeded: passed,
    unavailableEligible: true,
    unavailableMisclassified: !passed,
    ambiguityEligible: true,
    ambiguityResolvedWithinTwoTurns: passed,
    securityViolations: passed ? [] : ["unauthorized_read"],
    performanceEligible: true,
    elapsedMs: 25,
    returnedRetrievableJob: false
  };
}

function acceptanceCase(id: string, run: KernelAcceptanceCase["run"]): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey: "resource",
    recurrenceFamily: "stale_result_replay",
    boundary: "adapter_retrieval",
    run
  };
}

describe("Kernel v1 evaluator", () => {
  it("rejects an invalid or incomplete corpus before executing it", async () => {
    await expect(
      evaluateKernelGate({
        cases: [acceptanceCase("invalid private id", async () => observation("ignored", true))],
        requiredFamilies: ["stale_result_replay"],
        now: () => new Date("2026-07-21T00:00:00.000Z")
      })
    ).rejects.toThrow("invalid_kernel_corpus");
  });

  it("sorts cases and passes complete successful observations", async () => {
    const report = await evaluateKernelGate({
      cases: [
        acceptanceCase("kernel-v1/resource/b@1", async () =>
          observation("kernel-v1/resource/b@1", true)
        ),
        acceptanceCase("kernel-v1/resource/a@1", async () =>
          observation("kernel-v1/resource/a@1", true)
        )
      ],
      requiredFamilies: ["stale_result_replay"],
      now: () => new Date("2026-07-21T00:00:00.000Z")
    });
    expect(report.passed).toBe(true);
    expect(report.totalCases).toBe(2);
    expect(report.generatedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("converts thrown case errors into allowlisted failed observations", async () => {
    const report = await evaluateKernelGate({
      cases: [
        acceptanceCase("kernel-v1/resource/error@1", async () => {
          throw new Error("private provider payload");
        })
      ],
      requiredFamilies: ["stale_result_replay"],
      now: () => new Date("2026-07-21T00:00:00.000Z")
    });
    expect(report.failedCaseIds).toEqual(["kernel-v1/resource/error@1"]);
    expect(JSON.stringify(report)).not.toContain("private provider payload");
  });
});
