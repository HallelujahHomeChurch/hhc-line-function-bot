import type { KernelAcceptanceCase, KernelCaseObservation, RecurrenceFamily } from "./contracts.js";
import { SCHEDULE_KERNEL_CASES } from "./cases/schedule.js";
import { RETRIEVAL_KERNEL_CASES } from "./cases/retrieval.js";
import { SECURITY_AND_STATE_KERNEL_CASES } from "./cases/security-and-state.js";
import { REAL_JOURNEY_KERNEL_CASES } from "./cases/real-journeys.js";
import { REMOTE_RUNTIME_KERNEL_CASES } from "./cases/remote-runtime.js";

export const KERNEL_ACCEPTANCE_CASES: KernelAcceptanceCase[] = [
  ...SCHEDULE_KERNEL_CASES,
  ...RETRIEVAL_KERNEL_CASES,
  ...SECURITY_AND_STATE_KERNEL_CASES,
  ...REAL_JOURNEY_KERNEL_CASES,
  ...REMOTE_RUNTIME_KERNEL_CASES
];

export function validateKernelCorpus(
  cases: readonly KernelAcceptanceCase[],
  requiredFamilies: readonly RecurrenceFamily[] = []
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of cases) {
    if (!/^kernel-v1\/[a-z_]+\/[a-z0-9-]+@1$/u.test(entry.id)) {
      errors.push(`invalid_case_id:${entry.id}`);
    }
    if (seen.has(entry.id)) errors.push(`duplicate_case_id:${entry.id}`);
    seen.add(entry.id);
    if (entry.version !== 1) errors.push(`invalid_case_version:${entry.id}`);
  }
  const covered = new Set(cases.map(({ recurrenceFamily }) => recurrenceFamily));
  for (const family of requiredFamilies) {
    if (!covered.has(family)) errors.push(`missing_recurrence_family:${family}`);
  }
  return errors.sort();
}

export function validateKernelObservation(observation: KernelCaseObservation): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(observation.elapsedMs) || observation.elapsedMs <= 0) {
    errors.push(`invalid_elapsed_ms:${observation.caseId}`);
  }
  return errors;
}
