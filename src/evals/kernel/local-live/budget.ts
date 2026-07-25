import type {
  KernelLocalLiveBudgetSnapshot,
  KernelLocalLiveCaseId,
  KernelLocalLiveCost,
  KernelLocalLiveProvider,
  KernelLocalLiveProviderObservation,
  ProviderBudget
} from "./contracts.js";
import { KERNEL_LOCAL_LIVE_CASES } from "./cases.js";

export function createProviderBudget(limits: KernelLocalLiveCost): ProviderBudget {
  let deepSeekRequests = 0;
  let embeddingBatches = 0;
  let tail = Promise.resolve();
  const observations: KernelLocalLiveProviderObservation[] = [];
  const caseCounts = new Map<string, number>();
  const deepSeekTurnCounts = new Map<string, number>();

  async function run<T>(
    provider: KernelLocalLiveProvider,
    caseId: KernelLocalLiveCaseId,
    call: () => Promise<T>,
    turnIndex?: number
  ): Promise<T> {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const nextOrdinal = provider === "deepseek" ? deepSeekRequests + 1 : embeddingBatches + 1;
    const maximum = provider === "deepseek" ? limits.deepSeekMax : limits.embeddingBatchMax;
    const declaredCase = KERNEL_LOCAL_LIVE_CASES.find(({ id }) => id === caseId)!;
    const caseKey = `${provider}:${caseId}`;
    const nextCaseOrdinal = (caseCounts.get(caseKey) ?? 0) + 1;
    const caseMaximum =
      provider === "deepseek" ? declaredCase.deepSeekMax : declaredCase.embeddingBatchMax;
    const turnKey =
      provider === "deepseek" && turnIndex !== undefined ? `${caseId}:${turnIndex}` : undefined;
    const nextTurnOrdinal = turnKey ? (deepSeekTurnCounts.get(turnKey) ?? 0) + 1 : 0;
    if (nextOrdinal > maximum || nextCaseOrdinal > caseMaximum || nextTurnOrdinal > 1) {
      observations.push({
        provider,
        caseId,
        ordinal: nextOrdinal,
        outcome: "budget_exhausted"
      });
      release();
      throw new Error(
        provider === "deepseek"
          ? "kernel_local_live_deepseek_budget_exhausted"
          : "kernel_local_live_embedding_budget_exhausted"
      );
    }

    if (provider === "deepseek") deepSeekRequests = nextOrdinal;
    else embeddingBatches = nextOrdinal;
    caseCounts.set(caseKey, nextCaseOrdinal);
    if (turnKey) deepSeekTurnCounts.set(turnKey, nextTurnOrdinal);

    try {
      const result = await call();
      observations.push({ provider, caseId, ordinal: nextOrdinal, outcome: "success" });
      return result;
    } catch (error) {
      observations.push({ provider, caseId, ordinal: nextOrdinal, outcome: "failed" });
      throw error;
    } finally {
      release();
    }
  }

  return {
    runDeepSeek: (caseId, call, turnIndex) => run("deepseek", caseId, call, turnIndex),
    runEmbedding: (caseId, call) => run("azure_openai", caseId, call),
    snapshot(): KernelLocalLiveBudgetSnapshot {
      return {
        deepSeekRequests,
        embeddingBatches,
        observations: observations.map((entry) => ({ ...entry }))
      };
    }
  };
}
