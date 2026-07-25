import type {
  KernelLocalLiveBudgetSnapshot,
  KernelLocalLiveCaseId,
  KernelLocalLiveCost,
  KernelLocalLiveProvider,
  KernelLocalLiveProviderObservation,
  ProviderBudget
} from "./contracts.js";

export function createProviderBudget(limits: KernelLocalLiveCost): ProviderBudget {
  let deepSeekRequests = 0;
  let embeddingBatches = 0;
  let tail = Promise.resolve();
  const observations: KernelLocalLiveProviderObservation[] = [];

  async function run<T>(
    provider: KernelLocalLiveProvider,
    caseId: KernelLocalLiveCaseId,
    call: () => Promise<T>
  ): Promise<T> {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const nextOrdinal = provider === "deepseek" ? deepSeekRequests + 1 : embeddingBatches + 1;
    const maximum = provider === "deepseek" ? limits.deepSeekMax : limits.embeddingBatchMax;
    if (nextOrdinal > maximum) {
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
    runDeepSeek: (caseId, call) => run("deepseek", caseId, call),
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
