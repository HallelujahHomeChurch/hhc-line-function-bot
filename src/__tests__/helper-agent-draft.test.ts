import { createSaveScheduleMemoryHandler } from "../functions/schedule-memory.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { DEFAULT_SCHEDULE_DOMAINS } from "../schedules/domain-registry.js";
import { MemorySaver } from "@langchain/langgraph";
import { FakeToolCallingModel } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { createHelperAgent } from "../helper-agent/agent.js";
import { createHelperWriteTools } from "../helper-agent/write-tools.js";
import type { FunctionHandlerContext } from "../types.js";

describe("native proposal tool conversation", () => {
  it("returns a business clarification to the model without an interrupt and accepts the next question", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "propose_save_memory", args: { content: "" }, id: "draft-1" }]]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const propose = vi
      .fn()
      .mockResolvedValue({ status: "needs_input", clarification: "請提供內容。" });
    const tools = createHelperWriteTools({
      context: {
        profile: { name: "helper", enabledFunctions: ["save_memory"] },
        event: { source: { type: "user", userId: "u" } }
      } as FunctionHandlerContext,
      propose
    });
    const agent = createHelperAgent({
      model,
      summaryModel: model,
      checkpointer: new MemorySaver(),
      tools
    });
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "記住" }] },
      { configurable: { thread_id: "draft" } }
    );
    expect(result.__interrupt__).toBeUndefined();
    expect(propose).toHaveBeenCalledOnce();
    expect(result.messages.some((message) => message.text.includes("needs_input"))).toBe(true);
    const next = await agent.invoke(
      { messages: [{ role: "user", content: "這會保存多久？" }] },
      { configurable: { thread_id: "draft" } }
    );
    expect(next.__interrupt__).toBeUndefined();
    expect(next.messages.some((message) => message.text === "記住")).toBe(true);
  });
});

it("agent schedule preview cannot commit through a confirm query", async () => {
  const memoryStore = new InMemoryAgentMemoryStore();
  const handler = createSaveScheduleMemoryHandler({
    memoryStore,
    now: () => new Date("2026-09-07T00:00:00Z")
  });
  const context = {
    profile: { name: "helper", schedulePolicy: { domains: DEFAULT_SCHEDULE_DOMAINS } },
    event: { source: { type: "user", userId: "u" } },
    agentTool: true
  } as FunctionHandlerContext;
  const result = await handler(
    { content: "9/13 甲組", domainKey: "custom_service_schedule", query: "確認" },
    context
  );
  expect(result.writePhase).toBe("preview");
  expect(await memoryStore.listScheduleMemories({ profileName: "helper", limit: 10 })).toHaveLength(
    0
  );
});

it("clarifies a multi-month schedule without saving a partial first-month record", async () => {
  const memoryStore = new InMemoryAgentMemoryStore();
  const handler = createSaveScheduleMemoryHandler({
    memoryStore,
    now: () => new Date("2026-09-07T00:00:00Z")
  });
  const context = {
    profile: { name: "helper", schedulePolicy: { domains: DEFAULT_SCHEDULE_DOMAINS } },
    event: { source: { type: "user", userId: "u" } },
    agentTool: true
  } as FunctionHandlerContext;
  const result = await handler(
    { content: "9/13 甲組\n10/11 乙組", domainKey: "custom_service_schedule" },
    context
  );
  expect(result.writePreparation).toBe("ambiguous");
  expect(result.writePhase).toBeUndefined();
  expect(await memoryStore.listScheduleMemories({ profileName: "helper", limit: 10 })).toHaveLength(
    0
  );
});

it.each([
  "9/14 週日 甲組",
  "9/14（日）甲組",
  "2/30 甲組",
  "9/13 甲組\n13/02 乙組",
  "9/13 甲組\n9/00 乙組"
])(
  "asks to resolve invalid or conflicting date %s before any preview or commit",
  async (content) => {
    const memoryStore = new InMemoryAgentMemoryStore();
    const handler = createSaveScheduleMemoryHandler({
      memoryStore,
      now: () => new Date("2026-09-07T00:00:00Z")
    });
    const context = {
      profile: { name: "helper", schedulePolicy: { domains: DEFAULT_SCHEDULE_DOMAINS } },
      event: { source: { type: "user", userId: "u" } },
      agentTool: true
    } as FunctionHandlerContext;
    const result = await handler({ content, domainKey: "custom_service_schedule" }, context);
    expect(result.writePreparation).toBe("needs_input");
    expect(result.writePhase).toBeUndefined();
    expect(
      await memoryStore.listScheduleMemories({ profileName: "helper", limit: 10 })
    ).toHaveLength(0);
  }
);

it.each(["9/14 主日服事：甲組", "2027/9/13 週一 甲組"])(
  "does not infer recurrence from a meeting title and respects an explicit year: %s",
  async (content) => {
    const handler = createSaveScheduleMemoryHandler({
      memoryStore: new InMemoryAgentMemoryStore(),
      now: () => new Date("2026-09-07T00:00:00Z")
    });
    const context = {
      profile: { name: "helper", schedulePolicy: { domains: DEFAULT_SCHEDULE_DOMAINS } },
      event: { source: { type: "user", userId: "u" } },
      agentTool: true
    } as FunctionHandlerContext;
    expect(
      (await handler({ content, domainKey: "custom_service_schedule" }, context)).writePhase
    ).toBe("preview");
  }
);

it("proposal tools reject model-supplied approval fields before invoking the server", async () => {
  const propose = vi.fn();
  const tools = createHelperWriteTools({
    context: {
      profile: { name: "helper", enabledFunctions: ["save_memory"] },
      event: { source: { type: "user", userId: "u" } }
    } as FunctionHandlerContext,
    propose
  });
  await expect(tools[0].invoke({ content: "draft", confirm: true })).rejects.toThrow();
  expect(propose).not.toHaveBeenCalled();
});
