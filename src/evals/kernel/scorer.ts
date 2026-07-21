import {
  type KernelCaseObservation,
  type KernelGateReport,
  type KernelMetric,
  type RecurrenceFamily
} from "./contracts.js";

interface ScoredEntry {
  caseId: string;
  passed: boolean;
}

export function scoreKernelGate(
  observations: readonly KernelCaseObservation[],
  requiredFamilies: readonly RecurrenceFamily[],
  generatedAt = new Date().toISOString()
): KernelGateReport {
  const schedule = observations.flatMap((entry) =>
    entry.scheduleAssertions.map((assertion) => ({
      caseId: entry.caseId,
      passed: assertion.passed
    }))
  );
  const core = observations
    .filter((entry) => entry.coreJourneyEligible)
    .map((entry) => ({ caseId: entry.caseId, passed: entry.coreJourneySucceeded }));
  const unavailable = observations
    .filter((entry) => entry.unavailableEligible)
    .map((entry) => ({ caseId: entry.caseId, passed: !entry.unavailableMisclassified }));
  const ambiguity = observations
    .filter((entry) => entry.ambiguityEligible)
    .map((entry) => ({
      caseId: entry.caseId,
      passed: entry.ambiguityResolvedWithinTwoTurns
    }));
  const performance = observations
    .filter((entry) => entry.performanceEligible)
    .map((entry) => ({
      caseId: entry.caseId,
      passed: entry.elapsedMs <= 8_000 || entry.returnedRetrievableJob
    }));
  const violations = observations.flatMap((entry) =>
    entry.securityViolations.map(() => entry.caseId)
  );
  const covered = new Set(observations.map((entry) => entry.recurrenceFamily));
  const missingFamilies = requiredFamilies.filter((family) => !covered.has(family));

  const metrics = {
    schedule_accuracy: ratioMetric(schedule, ">= 0.98", (value) => value >= 0.98),
    core_journey_success: ratioMetric(core, ">= 0.85", (value) => value >= 0.85),
    unavailable_misclassification: failureRatioMetric(unavailable, "< 0.01"),
    ambiguity_resolution: ratioMetric(ambiguity, ">= 0.80", (value) => value >= 0.8),
    security_violations: countMetric(violations),
    core_read_completion: ratioMetric(performance, ">= 0.90", (value) => value >= 0.9),
    recurrence_coverage: coverageMetric(requiredFamilies, missingFamilies)
  } satisfies KernelGateReport["metrics"];

  const boundaryFailures: KernelGateReport["boundaryFailures"] = {};
  for (const entry of observations.filter((candidate) => !candidate.passed)) {
    (boundaryFailures[entry.boundary] ??= []).push(entry.caseId);
  }

  return {
    schemaVersion: 1,
    generatedAt,
    passed:
      observations.every((entry) => entry.passed) &&
      Object.values(metrics).every((metric) => metric.passed && !metric.incomplete),
    totalCases: observations.length,
    failedCaseIds: observations.filter((entry) => !entry.passed).map((entry) => entry.caseId),
    metrics,
    boundaryFailures
  };
}

function ratioMetric(
  entries: readonly ScoredEntry[],
  threshold: string,
  accepts: (value: number) => boolean
): KernelMetric {
  if (entries.length === 0) return incompleteMetric(threshold);
  const numerator = entries.filter((entry) => entry.passed).length;
  const value = numerator / entries.length;
  return {
    numerator,
    denominator: entries.length,
    value,
    threshold,
    passed: accepts(value),
    failedCaseIds: entries.filter((entry) => !entry.passed).map((entry) => entry.caseId)
  };
}

function failureRatioMetric(entries: readonly ScoredEntry[], threshold: string): KernelMetric {
  if (entries.length === 0) return incompleteMetric(threshold);
  const failures = entries.filter((entry) => !entry.passed);
  const value = failures.length / entries.length;
  return {
    numerator: failures.length,
    denominator: entries.length,
    value,
    threshold,
    passed: value < 0.01,
    failedCaseIds: failures.map((entry) => entry.caseId)
  };
}

function countMetric(failedCaseIds: string[]): KernelMetric {
  return {
    numerator: failedCaseIds.length,
    denominator: 1,
    value: failedCaseIds.length,
    threshold: "= 0",
    passed: failedCaseIds.length === 0,
    failedCaseIds
  };
}

function coverageMetric(
  requiredFamilies: readonly RecurrenceFamily[],
  missingFamilies: readonly RecurrenceFamily[]
): KernelMetric {
  if (requiredFamilies.length === 0) return incompleteMetric("= 1.00");
  const numerator = requiredFamilies.length - missingFamilies.length;
  const value = numerator / requiredFamilies.length;
  return {
    numerator,
    denominator: requiredFamilies.length,
    value,
    threshold: "= 1.00",
    passed: missingFamilies.length === 0,
    failedCaseIds: missingFamilies.map((family) => `missing-family:${family}`)
  };
}

function incompleteMetric(threshold: string): KernelMetric {
  return {
    numerator: 0,
    denominator: 0,
    threshold,
    passed: false,
    incomplete: true,
    failedCaseIds: []
  };
}
