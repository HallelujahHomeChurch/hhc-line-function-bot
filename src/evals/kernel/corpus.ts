import type { SdkAgentAcceptanceCase } from "./contracts.js";
import { SDK_AGENT_ACCEPTANCE_CASES } from "./cases/sdk-journeys.js";

export { SDK_AGENT_ACCEPTANCE_CASES };

export function validateSdkAgentCorpus(
  cases: readonly SdkAgentAcceptanceCase[] = SDK_AGENT_ACCEPTANCE_CASES
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of cases) {
    if (!/^sdk-v1\/[a-z_]+\/[a-z0-9-]+@1$/u.test(entry.id)) {
      errors.push(`invalid_case_id:${entry.id}`);
    }
    if (seen.has(entry.id)) errors.push(`duplicate_case_id:${entry.id}`);
    seen.add(entry.id);
    if (entry.messages.length < 2) errors.push(`insufficient_turns:${entry.id}`);
    if (entry.expected.writes === 1 && !entry.expected.approvalRequired) {
      errors.push(`write_without_approval:${entry.id}`);
    }
    if (entry.profile === "main" && entry.expected.providerCalls !== 0) {
      errors.push(`main_provider_call:${entry.id}`);
    }
  }
  if (cases.length < 30) errors.push("insufficient_case_count");
  if (cases.filter(({ category }) => category === "cross_source").length < 20) {
    errors.push("insufficient_cross_source_cases");
  }
  return errors.sort();
}
