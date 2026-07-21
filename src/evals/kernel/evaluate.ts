import {
  RECURRENCE_FAMILIES,
  type KernelAcceptanceCase,
  type KernelCaseObservation,
  type KernelGateReport,
  type RecurrenceFamily
} from "./contracts.js";
import {
  KERNEL_ACCEPTANCE_CASES,
  validateKernelCorpus,
  validateKernelObservation
} from "./corpus.js";
import { scoreKernelGate } from "./scorer.js";

export interface EvaluateKernelGateOptions {
  cases?: readonly KernelAcceptanceCase[];
  requiredFamilies?: readonly RecurrenceFamily[];
  now?: () => Date;
  concurrency?: number;
}

export async function evaluateKernelGate(
  options: EvaluateKernelGateOptions = {}
): Promise<KernelGateReport> {
  const now = options.now ?? (() => new Date());
  const cases = [...(options.cases ?? KERNEL_ACCEPTANCE_CASES)].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const requiredFamilies = options.requiredFamilies ?? RECURRENCE_FAMILIES;
  const corpusErrors = validateKernelCorpus(cases, requiredFamilies);
  if (corpusErrors.length > 0) {
    throw new Error(`invalid_kernel_corpus:${corpusErrors.join(",")}`);
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const observations = await mapWithConcurrency(cases, concurrency, async (entry) => {
    try {
      const observation = await entry.run({ now });
      const grounded = {
        ...observation,
        caseId: entry.id,
        recurrenceFamily: entry.recurrenceFamily
      };
      return validateKernelObservation(grounded).length === 0
        ? grounded
        : failedExecutionObservation(entry);
    } catch {
      return failedExecutionObservation(entry);
    }
  });
  return scoreKernelGate(observations, requiredFamilies, now().toISOString());
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index]!);
      }
    })
  );
  return results;
}

function failedExecutionObservation(entry: KernelAcceptanceCase): KernelCaseObservation {
  return {
    caseId: entry.id,
    passed: false,
    boundary: entry.boundary,
    recurrenceFamily: entry.recurrenceFamily,
    failureCode: "case_execution_failed",
    scheduleAssertions: [{ passed: false }],
    coreJourneyEligible: true,
    coreJourneySucceeded: false,
    unavailableEligible: true,
    unavailableMisclassified: true,
    ambiguityEligible: true,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: [],
    performanceEligible: true,
    elapsedMs: 9_000,
    returnedRetrievableJob: false
  };
}
