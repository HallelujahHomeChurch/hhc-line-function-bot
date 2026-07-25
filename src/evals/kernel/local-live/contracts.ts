export const KERNEL_LOCAL_LIVE_CASE_IDS = [
  "schedule-explicit",
  "schedule-refinement",
  "schedule-ambiguity",
  "capability-switch",
  "knowledge-follow-up",
  "group-requester-isolation",
  "provider-unavailable",
  "write-preview-confirm"
] as const;

export type KernelLocalLiveCaseId = (typeof KERNEL_LOCAL_LIVE_CASE_IDS)[number];

export type KernelLocalLiveJourney =
  | "schedule_explicit"
  | "schedule_refinement"
  | "schedule_ambiguity"
  | "capability_switch"
  | "knowledge_follow_up"
  | "group_requester_isolation"
  | "provider_unavailable"
  | "write_preview_confirm";

export interface KernelLocalLiveCase {
  readonly id: string;
  readonly version: 1;
  readonly journey: KernelLocalLiveJourney;
  readonly deepSeekMax: number;
  readonly embeddingBatchMax: number;
}

export interface KernelLocalLiveCost {
  deepSeekMax: number;
  embeddingBatchMax: number;
}

export type KernelLocalLiveProvider = "deepseek" | "azure_openai";
export type KernelLocalLiveProviderOutcome = "success" | "failed" | "budget_exhausted";

export interface KernelLocalLiveProviderObservation {
  provider: KernelLocalLiveProvider;
  caseId: KernelLocalLiveCaseId;
  ordinal: number;
  outcome: KernelLocalLiveProviderOutcome;
}

export interface KernelLocalLiveBudgetSnapshot {
  deepSeekRequests: number;
  embeddingBatches: number;
  observations: KernelLocalLiveProviderObservation[];
}

export interface ProviderBudget {
  runDeepSeek<T>(
    caseId: KernelLocalLiveCaseId,
    call: () => Promise<T>,
    turnIndex?: number
  ): Promise<T>;
  runEmbedding<T>(caseId: KernelLocalLiveCaseId, call: () => Promise<T>): Promise<T>;
  snapshot(): KernelLocalLiveBudgetSnapshot;
}
