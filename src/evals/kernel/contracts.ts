export const RECURRENCE_FAMILIES = [
  "wrapper_words_hide_subject",
  "generic_schedule_domain_ambiguity",
  "explicit_domain_lost",
  "role_follow_up_lost",
  "stale_result_replay",
  "resource_memory_resurrection",
  "required_slot_misrouted",
  "pending_write_confirmation_escape",
  "group_requester_scope_leak",
  "unavailable_presented_as_not_found",
  "write_safety_bypass",
  "replica_state_divergence"
] as const;

export type RecurrenceFamily = (typeof RECURRENCE_FAMILIES)[number];

export type KernelJourney =
  "schedule" | "ppt" | "sheet_music" | "resource" | "knowledge" | "memory" | "write";

export type KernelBoundary =
  | "entrance_access"
  | "candidate_generation"
  | "planner_proposal"
  | "deterministic_validation"
  | "slot_ambiguity_resolution"
  | "active_task_lifecycle"
  | "adapter_retrieval"
  | "freshness_invalidation"
  | "result_envelope"
  | "response_projection"
  | "write_workflow"
  | "external_dependency"
  | "deployment_configuration";

export type SecurityViolation =
  | "unauthorized_read"
  | "unauthorized_write"
  | "scope_leak"
  | "confirmation_bypass"
  | "unsafe_binary_publication"
  | "scan_bypass";

export interface KernelScheduleAssertion {
  passed: boolean;
}

export interface KernelCaseObservation {
  caseId: string;
  passed: boolean;
  boundary: KernelBoundary;
  recurrenceFamily: RecurrenceFamily;
  failureCode?: string;
  scheduleAssertions: KernelScheduleAssertion[];
  coreJourneyEligible: boolean;
  coreJourneySucceeded: boolean;
  unavailableEligible: boolean;
  unavailableMisclassified: boolean;
  ambiguityEligible: boolean;
  ambiguityResolvedWithinTwoTurns: boolean;
  securityViolations: SecurityViolation[];
  performanceEligible: boolean;
  elapsedMs: number;
  returnedRetrievableJob: boolean;
}

export interface KernelCaseContext {
  now: () => Date;
}

export interface KernelAcceptanceCase {
  id: string;
  version: 1;
  journey: KernelJourney;
  recurrenceFamily: RecurrenceFamily;
  boundary: KernelBoundary;
  run(context: KernelCaseContext): Promise<KernelCaseObservation>;
}

export interface KernelMetric {
  numerator: number;
  denominator: number;
  value?: number;
  threshold: string;
  passed: boolean;
  incomplete?: boolean;
  failedCaseIds: string[];
}

export type KernelMetricName =
  | "schedule_accuracy"
  | "core_journey_success"
  | "unavailable_misclassification"
  | "ambiguity_resolution"
  | "security_violations"
  | "core_read_completion"
  | "recurrence_coverage";

export interface KernelGateReport {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  totalCases: number;
  failedCaseIds: string[];
  metrics: Record<KernelMetricName, KernelMetric>;
  boundaryFailures: Partial<Record<KernelBoundary, string[]>>;
}
