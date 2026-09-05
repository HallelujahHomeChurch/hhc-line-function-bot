import type { AgentEvalCase } from "./contracts.js";

export const REQUIRED_AGENT_EVAL_CASE_IDS = [
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
] as const;

export const AGENT_EVAL_CASES: readonly AgentEvalCase[] = REQUIRED_AGENT_EVAL_CASE_IDS.map(
  (id) => ({
    id
  })
);

export function validateAgentEvalCorpus(
  cases: readonly AgentEvalCase[] = AGENT_EVAL_CASES
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const required = new Set<string>(REQUIRED_AGENT_EVAL_CASE_IDS);
  for (const entry of cases) {
    if (seen.has(entry.id)) errors.push(`duplicate_case_id:${entry.id}`);
    seen.add(entry.id);
    if (!required.has(entry.id)) errors.push(`unexpected_case_id:${entry.id}`);
  }
  for (const id of required) {
    if (!seen.has(id)) errors.push(`missing_case_id:${id}`);
  }
  return errors.sort();
}
