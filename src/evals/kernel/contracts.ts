export type KernelBoundary =
  | "entrance_access"
  | "slot_ambiguity_resolution"
  | "state_lifecycle"
  | "adapter_retrieval"
  | "freshness_invalidation"
  | "write_workflow"
  | "external_dependency"
  | "deployment_configuration";

export interface AgentEvalCase {
  id: string;
}
