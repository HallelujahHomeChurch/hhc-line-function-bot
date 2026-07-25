import { AsyncLocalStorage } from "node:async_hooks";

import { createAzureOpenAiEmbeddingClient } from "../../clients/azure-openai-embedding.js";
import type { EmbeddingClient } from "../../clients/embedding.js";
import { createDeepSeekProvider } from "../../clients/deepseek.js";
import type {
  KernelLocalLiveCaseId,
  KernelLocalLiveProviderObservation,
  ProviderBudget
} from "../../evals/kernel/local-live/contracts.js";
import type { AppConfig, ChatProvider, TextGenerationProvider } from "../../types.js";

export interface KernelLocalLiveCaseContext {
  run<T>(caseId: KernelLocalLiveCaseId, operation: () => T, turnIndex?: number): T;
  current(): KernelLocalLiveCaseId | undefined;
  currentTurnIndex(): number | undefined;
}

export interface BudgetedProviderClients {
  deepSeek: ChatProvider & TextGenerationProvider;
  embedding: EmbeddingClient;
}

export function createKernelLocalLiveCaseContext(): KernelLocalLiveCaseContext {
  const storage = new AsyncLocalStorage<{
    caseId: KernelLocalLiveCaseId;
    turnIndex?: number;
  }>();
  return {
    run: (caseId, operation, turnIndex) =>
      storage.run({ caseId, ...(turnIndex === undefined ? {} : { turnIndex }) }, operation),
    current: () => storage.getStore()?.caseId,
    currentTurnIndex: () => storage.getStore()?.turnIndex
  };
}

export function createBudgetedProviderClients(options: {
  config: AppConfig;
  budget: ProviderBudget;
  caseContext: KernelLocalLiveCaseContext;
  fetchImpl?: typeof fetch;
  onProviderObservation?: (observation: KernelLocalLiveProviderObservation) => void | Promise<void>;
}): BudgetedProviderClients {
  const deepSeek = createDeepSeekProvider({
    apiKey: options.config.llm.deepseekApiKey,
    baseUrl: options.config.llm.deepseekBaseUrl,
    model: options.config.llm.deepseekModel,
    timeoutMs: options.config.llm.deepseekTimeoutMs,
    routeMaxOutputTokens: options.config.llm.routeMaxOutputTokens ?? 256,
    generalMaxOutputTokens: options.config.llm.generalMaxOutputTokens ?? 160,
    fetchImpl: options.fetchImpl
  });
  const embeddingConfig = options.config.knowledge?.embedding;
  if (!embeddingConfig) throw new Error("kernel_local_live_embedding_config_missing");
  const embedding = createAzureOpenAiEmbeddingClient({
    apiKey: embeddingConfig.apiKey,
    endpoint: embeddingConfig.endpoint,
    deployment: embeddingConfig.deployment,
    apiVersion: embeddingConfig.apiVersion,
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
    timeoutMs: embeddingConfig.timeoutMs,
    fetchImpl: options.fetchImpl
  });
  const embeddingCache = new Map<string, number[]>();

  function currentCase(): KernelLocalLiveCaseId {
    const caseId = options.caseContext.current();
    if (!caseId) throw new Error("kernel_local_live_case_context_missing");
    return caseId;
  }

  async function runDeepSeek<T>(call: () => Promise<T>): Promise<T> {
    const caseId = currentCase();
    if (caseId === "provider-unavailable") {
      throw new Error("kernel_local_live_forced_provider_unavailable");
    }
    try {
      return await options.budget.runDeepSeek(caseId, call, options.caseContext.currentTurnIndex());
    } finally {
      await emitLatestObservation();
    }
  }

  async function emitLatestObservation(): Promise<void> {
    const latest = options.budget.snapshot().observations.at(-1);
    if (latest && options.onProviderObservation) {
      await options.onProviderObservation(latest);
    }
  }

  return {
    deepSeek: {
      providerName: deepSeek.providerName,
      capabilities: deepSeek.capabilities,
      async completeJson(request) {
        return runDeepSeek(() => deepSeek.completeJson(request));
      },
      async completeText(request) {
        return runDeepSeek(() => deepSeek.completeText(request));
      }
    },
    embedding: {
      provider: embedding.provider,
      model: embedding.model,
      dimensions: embedding.dimensions,
      async embed(input) {
        const caseId = currentCase();
        if (caseId !== "knowledge-follow-up" && caseId !== "capability-switch") {
          throw new Error("kernel_local_live_embedding_case_rejected");
        }
        const cached = input.map((value) => embeddingCache.get(value));
        if (cached.every((value): value is number[] => value !== undefined)) {
          return cached.map((value) => [...value]);
        }
        try {
          const vectors = await options.budget.runEmbedding(caseId, () => embedding.embed(input));
          input.forEach((value, index) => {
            embeddingCache.set(value, [...vectors[index]!]);
          });
          return vectors;
        } finally {
          await emitLatestObservation();
        }
      }
    }
  };
}
