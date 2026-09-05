import { describe, expect, it, vi } from "vitest";

import { createBudgetedFetch, runWithAgentBudget, takeToolCall } from "../helper-agent/budget.js";

describe("helper agent budget", () => {
  it("counts retries and summarization through the same DeepSeek fetch budget", async () => {
    const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
    const budgetedFetch = createBudgetedFetch(upstream);

    await expect(
      runWithAgentBudget("normal", async () => {
        await Promise.all([1, 2, 3, 4].map(() => budgetedFetch("https://api.test")));
        await budgetedFetch("https://api.test");
      })
    ).rejects.toThrow("agent_model_budget_exceeded");
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("allows six requests only in consented research mode", async () => {
    const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
    const budgetedFetch = createBudgetedFetch(upstream);

    await runWithAgentBudget("sheet_music_research", async () => {
      for (let index = 0; index < 6; index += 1) await budgetedFetch("https://api.test");
    });

    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("stops the fifth normal tool call", async () => {
    await expect(
      runWithAgentBudget("normal", async () => {
        for (let index = 0; index < 4; index += 1) takeToolCall();
        takeToolCall();
      })
    ).rejects.toThrow("agent_tool_budget_exceeded");
  });

  it("allows six tool calls only in consented research mode", async () => {
    await expect(
      runWithAgentBudget("sheet_music_research", async () => {
        for (let index = 0; index < 6; index += 1) takeToolCall();
        takeToolCall();
      })
    ).rejects.toThrow("agent_tool_budget_exceeded");
  });
});
