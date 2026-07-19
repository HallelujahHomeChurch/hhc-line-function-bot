export const RETRIEVAL_PRODUCT_CASES = [
  "sequential_ppt_queries",
  "legacy_alias_cannot_execute",
  "active_task_follow_up",
  "schedule_domain_ambiguity",
  "explicit_schedule_domain",
  "retrieval_not_found",
  "retrieval_unavailable",
  "write_preview_commit_precedence"
] as const;

export type RetrievalProductCaseName = (typeof RETRIEVAL_PRODUCT_CASES)[number];
