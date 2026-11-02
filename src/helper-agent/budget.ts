import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRunMode = "normal";

type Budget = {
  modelCalls: number;
  toolCalls: number;
  onProviderRequest?: (provider?: "openai" | "deepseek", role?: "response" | "summary") => void;
};

const limits: Record<AgentRunMode, Budget> = {
  normal: { modelCalls: 4, toolCalls: 4 }
};
const storage = new AsyncLocalStorage<Budget>();

export function runWithAgentBudget<T>(
  mode: AgentRunMode,
  task: () => Promise<T>,
  onProviderRequest?: (provider?: "openai" | "deepseek", role?: "response" | "summary") => void
): Promise<T> {
  return storage.run({ ...limits[mode], onProviderRequest }, task);
}

export function createBudgetedFetch(
  fetchImpl: typeof fetch = fetch,
  provider?: "openai" | "deepseek",
  role?: "response" | "summary"
): typeof fetch {
  return async (input, init) => {
    const budget = storage.getStore();
    if (budget) {
      if (budget.modelCalls <= 0) throw new Error("agent_model_budget_exceeded");
      budget.modelCalls -= 1;
      budget.onProviderRequest?.(provider, role);
    }
    return fetchImpl(input, init);
  };
}

export function takeToolCall(): void {
  const budget = storage.getStore();
  if (!budget) return;
  if (budget.toolCalls <= 0) throw new Error("agent_tool_budget_exceeded");
  budget.toolCalls -= 1;
}
