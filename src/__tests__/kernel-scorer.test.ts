import { describe, expect, it } from "vitest";

import type { KernelCaseObservation, RecurrenceFamily } from "../evals/kernel/contracts.js";
import { scoreKernelGate } from "../evals/kernel/scorer.js";

const families: RecurrenceFamily[] = ["explicit_domain_lost", "stale_result_replay"];

function observation(
  id: string,
  override: Partial<KernelCaseObservation> = {}
): KernelCaseObservation {
  return {
    caseId: id,
    passed: true,
    boundary: "result_envelope",
    recurrenceFamily: id.endsWith("1") ? families[0]! : families[1]!,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: true,
    unavailableEligible: false,
    unavailableMisclassified: false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: [],
    performanceEligible: true,
    elapsedMs: 100,
    returnedRetrievableJob: false,
    ...override
  };
}

describe("Kernel v1 gate scorer", () => {
  it("fails closed when a case fails even if aggregate thresholds still pass", () => {
    const observations = Array.from({ length: 100 }, (_, index) =>
      observation(`case-${index + 1}`, {
        passed: index !== 0,
        scheduleAssertions: [{ passed: true }],
        unavailableEligible: true,
        ambiguityEligible: true,
        ambiguityResolvedWithinTwoTurns: true
      })
    );

    expect(scoreKernelGate(observations, families).passed).toBe(false);
  });

  it("passes metrics at their approved boundaries while incomplete metrics fail closed", () => {
    const observations = Array.from({ length: 100 }, (_, index) =>
      observation(`case-${index + 1}`, {
        recurrenceFamily: index === 0 ? families[0]! : families[1]!,
        scheduleAssertions: [{ passed: index !== 0 }],
        ambiguityEligible: index < 5,
        ambiguityResolvedWithinTwoTurns: index < 4,
        performanceEligible: index < 10,
        elapsedMs: index < 9 ? 100 : 9_000,
        returnedRetrievableJob: index === 9
      })
    );

    const report = scoreKernelGate(observations, families);

    expect(report.metrics.schedule_accuracy).toMatchObject({ value: 0.99, passed: true });
    expect(report.metrics.core_journey_success).toMatchObject({ value: 1, passed: true });
    expect(report.metrics.unavailable_misclassification).toMatchObject({
      incomplete: true,
      passed: false
    });
    expect(report.metrics.ambiguity_resolution).toMatchObject({ value: 0.8, passed: true });
    expect(report.metrics.security_violations).toMatchObject({ value: 0, passed: true });
    expect(report.metrics.core_read_completion).toMatchObject({ value: 1, passed: true });
    expect(report.metrics.recurrence_coverage).toMatchObject({ value: 1, passed: true });
    expect(report.passed).toBe(false);
  });

  it("fails closed for a security violation and one-percent unavailable misclassification", () => {
    const observations = Array.from({ length: 100 }, (_, index) =>
      observation(`case-${index + 1}`, {
        unavailableEligible: true,
        unavailableMisclassified: index === 0,
        securityViolations: index === 0 ? ["unauthorized_read"] : []
      })
    );

    const report = scoreKernelGate(observations, families);

    expect(report.metrics.unavailable_misclassification).toMatchObject({
      value: 0.01,
      passed: false
    });
    expect(report.metrics.security_violations).toMatchObject({ value: 1, passed: false });
    expect(report.passed).toBe(false);
  });

  it("fails recurrence coverage when a required family has no observation", () => {
    const report = scoreKernelGate(
      [
        observation("case-1", {
          recurrenceFamily: "explicit_domain_lost",
          scheduleAssertions: [{ passed: true }],
          unavailableEligible: true,
          ambiguityEligible: true,
          ambiguityResolvedWithinTwoTurns: true
        })
      ],
      families
    );

    expect(report.metrics.recurrence_coverage).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
      passed: false,
      failedCaseIds: ["missing-family:stale_result_replay"]
    });
  });
});
