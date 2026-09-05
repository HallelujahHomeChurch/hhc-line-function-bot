import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRunMode = "normal" | "sheet_music_research";

type Budget = { modelCalls: number; toolCalls: number };

const limits: Record<AgentRunMode, Budget> = {
  normal: { modelCalls: 4, toolCalls: 4 },
  sheet_music_research: { modelCalls: 6, toolCalls: 6 }
};
const storage = new AsyncLocalStorage<Budget>();

export function runWithAgentBudget<T>(mode: AgentRunMode, task: () => Promise<T>): Promise<T> {
  return storage.run({ ...limits[mode] }, task);
}

export function createBudgetedFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const budget = storage.getStore();
    if (budget) {
      if (budget.modelCalls <= 0) throw new Error("agent_model_budget_exceeded");
      budget.modelCalls -= 1;
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
