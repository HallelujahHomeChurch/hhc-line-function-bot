import type { KernelAcceptanceCase } from "./contracts.js";
import { SCHEDULE_KERNEL_CASES } from "./cases/schedule.js";
import { RETRIEVAL_KERNEL_CASES } from "./cases/retrieval.js";
import { SECURITY_AND_STATE_KERNEL_CASES } from "./cases/security-and-state.js";

export const KERNEL_ACCEPTANCE_CASES: KernelAcceptanceCase[] = [
  ...SCHEDULE_KERNEL_CASES,
  ...RETRIEVAL_KERNEL_CASES,
  ...SECURITY_AND_STATE_KERNEL_CASES
];

export function validateKernelCorpus(cases: readonly KernelAcceptanceCase[]): string[] {
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
  return errors.sort();
}
