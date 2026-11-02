import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, HumanMessage, tool } from "langchain";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  createHelperModels,
  createHelperRuntime,
  helperPolicyKey
} from "../helper-agent/runtime.js";
import { createHelperAgent } from "../helper-agent/agent.js";
import { runWithAgentBudget } from "../helper-agent/budget.js";
import { createHelperAgentState } from "../helper-agent/state.js";
import {
  fallbackError,
  normalizeFallbackMessages,
  withProviderFailover,
  type ProviderCircuit
} from "../helper-agent/provider-failover.js";
import { helperProfile } from "../evals/synthetic-runtime-fixture.js";

function completion(content = "done", calls?: unknown[]) {
  return new Response(
    JSON.stringify({
      id: "synthetic",
      object: "chat.completion",
      created: 0,
      model: "synthetic",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
          finish_reason: calls ? "tool_calls" : "stop"
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
    }),
    { headers: { "content-type": "application/json" } }
  );
}
function failure(status = 503) {
  return new Response(
    JSON.stringify({ error: { message: "synthetic unavailable", type: "server_error" } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
function circuit(): ProviderCircuit {
  return {
    acquire: vi.fn(async () => "closed"),
    fail: vi.fn(async () => {}),
    succeed: vi.fn(async () => {})
  };
}
function models(primary: typeof fetch, secondary: typeof fetch) {
  return createHelperModels({
    provider: "openai",
    apiKey: "synthetic",
    baseUrl: "https://openai.invalid/v1",
    model: "synthetic",
    summaryModel: "synthetic-summary",
    timeoutMs: 1000,
    fetchImpl: primary,
    fallback: {
      apiKey: "synthetic",
      baseUrl: "https://deepseek.invalid/v1",
      model: "synthetic-fallback",
      summaryModel: "synthetic-fallback-summary",
      fetchImpl: secondary
    }
  });
}

describe("context-safe provider failover", () => {
  it("continues after a completed tool without rerunning it, pins summary and later turns, and shares budget", async () => {
    const primary = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"topic":"synthetic"}' }
          }
        ])
      )
      .mockResolvedValue(failure());
    const requests: Record<string, unknown>[] = [];
    const secondary = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return completion();
    });
    const selected = models(primary, secondary);
    const handler = vi.fn(async () => "authoritative synthetic result");
    const state = createHelperAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "synthetic-scope-key"
    });
    const agent = createHelperAgent({
      ...selected,
      checkpointer: state.checkpointer,
      tools: [
        tool(handler, {
          name: "lookup",
          description: "synthetic lookup",
          schema: z.object({ topic: z.string() })
        })
      ]
    });
    const gate = circuit();
    const attempts: string[] = [];
    const turn = (text: string) =>
      state.run({
        threadId: "scope",
        policyKey: "pair-v1",
        source: { type: "user", userId: "synthetic" },
        task: (snapshot) =>
          runWithAgentBudget(
            "normal",
            () =>
              withProviderFailover(snapshot, gate, () =>
                agent.invoke(
                  { messages: [new HumanMessage(text)] },
                  { configurable: { thread_id: "scope" } }
                )
              ),
            (p) => attempts.push(p!)
          )
      });
    await turn("lookup synthetic");
    expect(handler).toHaveBeenCalledOnce();
    expect(primary).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["openai", "openai", "deepseek"]);
    expect(requests[0]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
          content: "authoritative synthetic result"
        })
      ])
    );
    await turn("continue");
    expect(primary).toHaveBeenCalledTimes(2);
    await state.run({
      threadId: "scope",
      policyKey: "pair-v1",
      source: { type: "user", userId: "synthetic" },
      task: (snapshot) =>
        runWithAgentBudget("normal", () =>
          withProviderFailover(snapshot, gate, () => selected.summaryModel.invoke("summary"))
        )
    });
    expect(requests.at(-1)!.model).toBe("synthetic-fallback-summary");
    expect(gate.fail).toHaveBeenCalledOnce();
  });

  it("counts failure and fallback attempts against the same four-request budget", async () => {
    const primary = vi.fn<typeof fetch>(async () => failure());
    const secondary = vi.fn<typeof fetch>(async () => completion());
    const selected = models(primary, secondary);
    const pin = vi.fn(async () => {});
    await expect(
      runWithAgentBudget("normal", () =>
        withProviderFailover({ pinFallback: pin }, circuit(), async () => {
          for (let i = 0; i < 4; i++) await selected.model.invoke("synthetic");
        })
      )
    ).rejects.toThrow();
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledTimes(3);
    expect(pin).toHaveBeenCalledOnce();
  });

  it.each([400, 404, 422])(
    "does not use fallback to hide non-availability errors (%i)",
    async (status) => {
      const secondary = vi.fn<typeof fetch>(async () => completion());
      const selected = models(async () => failure(status), secondary);
      await expect(
        runWithAgentBudget("normal", () =>
          withProviderFailover({ pinFallback: async () => {} }, circuit(), () =>
            selected.model.invoke("synthetic")
          )
        )
      ).rejects.toThrow();
      expect(secondary).not.toHaveBeenCalled();
    }
  );
  it("persists the pin even if both providers fail, and never calls a model outside scope", async () => {
    const primary = vi.fn<typeof fetch>(async () => failure());
    const secondary = vi.fn<typeof fetch>(async () => failure());
    const selected = models(primary, secondary);
    const pin = vi.fn(async () => {});
    await expect(selected.model.invoke("synthetic")).rejects.toThrow("fallback_scope_required");
    expect(primary).not.toHaveBeenCalled();
    await expect(
      runWithAgentBudget("normal", () =>
        withProviderFailover({ pinFallback: pin }, circuit(), () =>
          selected.model.invoke("synthetic")
        )
      )
    ).rejects.toThrow();
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledOnce();
    expect(pin).toHaveBeenCalledOnce();
  });
  it("reports actual provider attempts and unknown failed-request usage without exposing context", async () => {
    const primary = vi.fn<typeof fetch>(async () => failure());
    const secondary = vi.fn<typeof fetch>(async () => completion());
    const traceStore = new InMemoryAgentTraceStore();
    const profile = helperProfile([]);
    profile.agent = {
      ...profile.agent!,
      provider: "openai",
      model: "synthetic",
      fallback: {
        provider: "deepseek",
        model: "synthetic-fallback",
        summaryModel: "synthetic-fallback-summary"
      }
    };
    profile.allowedProviders = ["openai", "deepseek"];
    const runtime = createHelperRuntime({
      ...models(primary, secondary),
      providerCircuit: circuit(),
      traceStore,
      state: createHelperAgentState({ checkpointer: new MemorySaver(), hmacKey: "synthetic" }),
      handlers: {}
    });
    const result = await runtime.handleTextTurn({
      profile,
      event: {
        type: "message",
        source: { type: "user", userId: "private-user" },
        message: { type: "text", text: "private-context" }
      },
      requestId: "synthetic"
    });
    expect(result?.ok).toBe(true);
    const traces = await traceStore.list();
    const steps = traces.flatMap((trace) => trace.steps);
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          providerRequestCount: 1,
          usageMissingRequestCount: 1
        }),
        expect.objectContaining({
          provider: "deepseek",
          providerRequestCount: 1,
          inputTokens: 100,
          outputTokens: 10,
          usageMissingRequestCount: 0
        }),
        expect.objectContaining({ provider: "mixed", providerRequestCount: 2, reason: "transient" })
      ])
    );
    expect(JSON.stringify(traces)).not.toContain("private-context");
    expect(JSON.stringify(traces)).not.toContain("private-user");
  });

  it("discards an interrupted response and retries only a complete generation", async () => {
    const primary = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"choices":[{"message":{"tool_calls":[')
              );
              controller.error(
                Object.assign(new Error("synthetic interrupted body"), { code: "ECONNRESET" })
              );
            }
          }),
          { headers: { "content-type": "application/json" } }
        )
    );
    const secondary = vi.fn<typeof fetch>(async () => completion());
    const selected = models(primary, secondary);
    const result = await runWithAgentBudget("normal", () =>
      withProviderFailover({ pinFallback: async () => {} }, circuit(), () =>
        selected.model.invoke("synthetic")
      )
    );
    expect(result.content).toBe("done");
    expect(result.tool_calls).toEqual([]);
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledOnce();
  });

  it("revalidates policy before sending retained evidence to the fallback", async () => {
    const secondary = vi.fn<typeof fetch>(async () => completion());
    const selected = models(async () => failure(), secondary);
    const validate = vi.fn(async () => {
      throw new Error("fallback_context_invalidated");
    });
    await expect(
      runWithAgentBudget("normal", () =>
        withProviderFailover(
          { pinFallback: async () => {} },
          circuit(),
          () => selected.model.invoke("synthetic"),
          undefined,
          validate
        )
      )
    ).rejects.toThrow("fallback_context_invalidated");
    expect(validate).toHaveBeenCalledOnce();
    expect(secondary).not.toHaveBeenCalled();
  });

  it("drops provider-private reasoning and rejects unsupported/incomplete messages", () => {
    const result = normalizeFallbackMessages([
      new AIMessage({
        content: "safe",
        additional_kwargs: { reasoning_content: "private" },
        response_metadata: { secret: "private" }
      })
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(() =>
      normalizeFallbackMessages([
        new AIMessage({
          content: "",
          invalid_tool_calls: [{ name: "lookup", args: "{", id: "broken", error: "partial" }]
        })
      ])
    ).toThrow("fallback_incomplete_tool_call");
    expect(() =>
      normalizeFallbackMessages([
        new HumanMessage({ content: [{ type: "image_url", image_url: "synthetic" }] })
      ])
    ).toThrow("fallback_message_format_unsupported");
    expect(fallbackError(new Error("agent_model_budget_exceeded"))).toBeUndefined();
  });
  it("resets pin on policy change, expiry or reset without leaking between scopes", async () => {
    let now = 0;
    const state = createHelperAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "synthetic",
      now: () => new Date(now)
    });
    const source = { type: "group", groupId: "g", userId: "u" } as const;
    const run = (threadId: string, policyKey = "pair-v1", pin = false) =>
      state.run({
        threadId,
        policyKey,
        source,
        task: async (snapshot) => {
          if (pin) await snapshot.pinFallback!();
          return snapshot.fallbackPinned;
        }
      });
    await run("a", "pair-v1", true);
    expect(await run("a")).toBe(true);
    expect(await run("b")).toBe(false);
    expect(await run("a", "pair-v2")).toBe(false);
    await run("a", "pair-v2", true);
    now = 16 * 60_000;
    expect(await run("a", "pair-v2")).toBe(false);
    await run("a", "pair-v2", true);
    await state.reset("a");
    expect(await run("a", "pair-v2")).toBe(false);
    const profile = helperProfile([]);
    expect(
      helperPolicyKey({
        ...profile,
        agent: {
          ...profile.agent!,
          fallback: { provider: "deepseek", model: "a", summaryModel: "a" }
        }
      })
    ).not.toBe(helperPolicyKey(profile));
  });
});
