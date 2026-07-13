import { describe, expect, it, vi } from "vitest";

import { evaluateForcedOllamaFallback } from "../tools/eval-agent-planner-live.js";
import type { ChatProvider } from "../types.js";

describe("live agent planner fallback probe", () => {
  it("forces the DeepSeek attempt to fail and accepts a validated Ollama plan", async () => {
    const fallback: ChatProvider = {
      providerName: "ollama",
      completeJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          version: 1,
          disposition: "execute",
          capability: "query_schedule",
          arguments: {
            query: "幫我查下一場聚會服事的導播",
            dateIntent: "next_meeting",
            role: "導播"
          },
          confidence: 0.96
        })
      )
    };

    const result = await evaluateForcedOllamaFallback(fallback, "helper");

    expect(result).toEqual({
      provider: "ollama",
      primaryStatus: "unavailable",
      finalDisposition: "execute",
      finalCapability: "query_schedule"
    });
    expect(fallback.completeJson).toHaveBeenCalledOnce();
  });
});
