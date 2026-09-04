export type KernelBoundary =
  | "entrance_access"
  | "slot_ambiguity_resolution"
  | "state_lifecycle"
  | "adapter_retrieval"
  | "freshness_invalidation"
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

export type SdkAgentCaseCategory =
  "conversation" | "cross_source" | "isolation" | "sheet_music" | "write";

export interface SdkAgentAcceptanceCase {
  id: `sdk-v1/${string}@1`;
  profile: "helper" | "main";
  category: SdkAgentCaseCategory;
  now: string;
  messages: readonly [string, string, ...string[]];
  expected: {
    writes: 0 | 1;
    providerCalls: 0 | "bounded";
    securityViolations: readonly SecurityViolation[];
    evidenceSource?: "formal_schedule" | "visible_note" | "knowledge" | "none";
    distinguishFromFormalSchedule?: boolean;
    requiredTools?: readonly string[];
    approvalRequired?: boolean;
  };
}
