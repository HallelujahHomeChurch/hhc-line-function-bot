import {
  KERNEL_LOCAL_LIVE_CASE_IDS,
  type KernelLocalLiveCase,
  type KernelLocalLiveCaseId,
  type KernelLocalLiveCost
} from "./contracts.js";

const MAX_DEEPSEEK_REQUESTS = 10;
const MAX_EMBEDDING_BATCHES = 3;

export const KERNEL_LOCAL_LIVE_CASES: readonly Readonly<KernelLocalLiveCase>[] = Object.freeze(
  (
    [
      {
        id: "schedule-explicit",
        version: 1,
        journey: "schedule_explicit",
        deepSeekMax: 1,
        embeddingBatchMax: 0
      },
      {
        id: "schedule-refinement",
        version: 1,
        journey: "schedule_refinement",
        deepSeekMax: 2,
        embeddingBatchMax: 0
      },
      {
        id: "schedule-ambiguity",
        version: 1,
        journey: "schedule_ambiguity",
        deepSeekMax: 1,
        embeddingBatchMax: 0
      },
      {
        id: "capability-switch",
        version: 1,
        journey: "capability_switch",
        deepSeekMax: 2,
        embeddingBatchMax: 1
      },
      {
        id: "knowledge-follow-up",
        version: 1,
        journey: "knowledge_follow_up",
        deepSeekMax: 2,
        embeddingBatchMax: 2
      },
      {
        id: "group-requester-isolation",
        version: 1,
        journey: "group_requester_isolation",
        deepSeekMax: 1,
        embeddingBatchMax: 0
      },
      {
        id: "provider-unavailable",
        version: 1,
        journey: "provider_unavailable",
        deepSeekMax: 0,
        embeddingBatchMax: 0
      },
      {
        id: "write-preview-confirm",
        version: 1,
        journey: "write_preview_confirm",
        deepSeekMax: 1,
        embeddingBatchMax: 0
      }
    ] satisfies KernelLocalLiveCase[]
  ).map((entry) => Object.freeze(entry))
);

export function validateKernelLocalLiveCost(
  cases: readonly KernelLocalLiveCase[]
): KernelLocalLiveCost {
  const ids = new Set<string>();
  let deepSeekMax = 0;
  let embeddingBatchMax = 0;
  for (const entry of cases) {
    if (
      ids.has(entry.id) ||
      !Number.isInteger(entry.deepSeekMax) ||
      entry.deepSeekMax < 0 ||
      !Number.isInteger(entry.embeddingBatchMax) ||
      entry.embeddingBatchMax < 0
    ) {
      throw new Error("kernel_local_live_case_invalid");
    }
    ids.add(entry.id);
    deepSeekMax += entry.deepSeekMax;
    embeddingBatchMax += entry.embeddingBatchMax;
  }
  if (deepSeekMax > MAX_DEEPSEEK_REQUESTS || embeddingBatchMax > MAX_EMBEDDING_BATCHES) {
    throw new Error("kernel_local_live_cost_exceeded");
  }
  return { deepSeekMax, embeddingBatchMax };
}

export function selectKernelLocalLiveCases(
  caseId?: string
): readonly Readonly<KernelLocalLiveCase>[] {
  validateKernelLocalLiveCost(KERNEL_LOCAL_LIVE_CASES);
  if (!caseId) return KERNEL_LOCAL_LIVE_CASES;
  if (!KERNEL_LOCAL_LIVE_CASE_IDS.includes(caseId as KernelLocalLiveCaseId)) {
    throw new Error("kernel_local_live_case_unknown");
  }
  return Object.freeze(KERNEL_LOCAL_LIVE_CASES.filter((entry) => entry.id === caseId));
}
