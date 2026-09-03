import { describe, expect, it, vi } from "vitest";

import { createSdkFunctionTools } from "../agent/sdk-tools.js";
import type { BotProfileConfig, FunctionHandlerContext, FunctionRegistry } from "../types.js";

function context(
  source: FunctionHandlerContext["event"]["source"] = {
    type: "user",
    userId: "U1"
  }
): FunctionHandlerContext {
  return {
    profile: profile(),
    event: {
      type: "message",
      source,
      message: { type: "text", text: "查服事表" }
    }
  };
}

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["query_schedule"],
    permissionRequiredFunctions: [],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

describe("SDK function tools", () => {
  it("exposes only configured, enabled functions", () => {
    const registry: FunctionRegistry = {
      query_schedule: vi.fn(),
      save_memory: vi.fn()
    };

    const tools = createSdkFunctionTools({
      context: context(),
      functionRegistry: registry
    });

    expect(tools.map(({ name }) => name)).toEqual(["query_schedule"]);
  });

  it("does not create group tools without a requester identity", () => {
    const tools = createSdkFunctionTools({
      context: context({ type: "group", groupId: "G1" }),
      functionRegistry: { query_schedule: vi.fn() }
    });

    expect(tools).toEqual([]);
  });

  it("rechecks live authorization before calling a handler", async () => {
    const handler = vi.fn();
    const [querySchedule] = createSdkFunctionTools({
      authorize: async () => false,
      context: context(),
      functionRegistry: { query_schedule: handler }
    });

    await expect(querySchedule?.invoke({ query: "2026-09-06" })).resolves.toEqual({
      status: "denied",
      reason: "authorization_changed"
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps raw handler replies out of checkpointed tool output", async () => {
    const onResult = vi.fn();
    const result = {
      ok: true,
      replyText: "https://temporary.example.test/private",
      writePhase: "preview" as const
    };
    const [querySchedule] = createSdkFunctionTools({
      context: context(),
      functionRegistry: { query_schedule: vi.fn(async () => result) },
      onResult
    });

    await expect(querySchedule?.invoke({ query: "2026-09-06" })).resolves.toEqual({
      status: "success",
      writePhase: "preview"
    });
    expect(onResult).toHaveBeenCalledWith("query_schedule", result);
  });

  it("rejects model-only confirmation fields through the function schema", async () => {
    const handler = vi.fn();
    const [querySchedule] = createSdkFunctionTools({
      context: context(),
      functionRegistry: { query_schedule: handler }
    });

    await expect(querySchedule?.invoke({ query: "2026-09-06", confirm: true })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
