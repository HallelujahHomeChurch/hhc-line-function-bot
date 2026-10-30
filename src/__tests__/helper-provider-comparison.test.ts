import { tool } from "langchain";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createHelperModels, helperPolicyKey } from "../helper-agent/runtime.js";
import { createHelperAgent } from "../helper-agent/agent.js";
import { runWithAgentBudget } from "../helper-agent/budget.js";
import { helperProfile } from "../evals/synthetic-runtime-fixture.js";

describe("equivalent helper provider contract (offline)", () => {
  it.each(["deepseek", "openai"] as const)(
    "runs the same strict tool journey on %s",
    async (provider) => {
      const requests: Record<string, unknown>[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const message =
          requests.length === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "synthetic-call",
                    type: "function",
                    function: { name: "lookup", arguments: '{"topic":"synthetic"}' }
                  }
                ]
              }
            : { role: "assistant", content: "合成查詢完成" };
        return new Response(
          JSON.stringify({
            id: `synthetic-${requests.length}`,
            object: "chat.completion",
            created: 0,
            model: "synthetic",
            choices: [
              { index: 0, message, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 30 }
            }
          }),
          { headers: { "content-type": "application/json" } }
        );
      });
      const handler = vi.fn(async () => ({ status: "success", text: "合成證據" }));
      const models = createHelperModels({
        provider,
        apiKey: "synthetic",
        baseUrl: "https://synthetic.invalid/v1",
        model: "synthetic",
        summaryModel: "synthetic-summary",
        timeoutMs: 8000,
        fetchImpl
      });
      const agent = createHelperAgent({
        ...models,
        tools: [
          tool(handler, {
            name: "lookup",
            description: "Synthetic lookup",
            schema: z.object({ topic: z.string() }).strict()
          })
        ]
      });
      const result = await runWithAgentBudget("normal", () =>
        agent.invoke({ messages: [{ role: "user", content: "查詢合成資料" }] })
      );
      expect(requests).toHaveLength(2);
      expect(result.messages.at(-1)?.text).toBe("合成查詢完成");
      expect(requests).toHaveLength(2);
      expect(handler).toHaveBeenCalledOnce();
      expect(requests[0]).toMatchObject({ model: "synthetic" });
      if (provider === "openai") {
        expect(requests[0]).toMatchObject({ store: false });
        expect(requests[0]!.max_completion_tokens ?? requests[0]!.max_tokens).toBe(800);
        expect(requests[0]).not.toHaveProperty("thinking");
      }
    }
  );
  it("rotates checkpoint policy when provider or model changes", () => {
    const profile = helperProfile([]);
    const baseline = helperPolicyKey(profile);
    expect(
      helperPolicyKey({
        ...profile,
        agent: { ...profile.agent!, provider: "openai", model: "synthetic" }
      })
    ).not.toBe(baseline);
    expect(
      helperPolicyKey({ ...profile, agent: { ...profile.agent!, summaryModel: "different" } })
    ).not.toBe(baseline);
  });
});
