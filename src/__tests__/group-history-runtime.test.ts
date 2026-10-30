import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, FakeToolCallingModel, type BaseMessage } from "langchain";
import { expect, it, vi } from "vitest";
import { createHelperRuntime } from "../helper-agent/runtime.js";
import { createHelperAgentState } from "../helper-agent/state.js";
import { helperProfile } from "../evals/synthetic-runtime-fixture.js";
import type { GroupHistory } from "../history/types.js";

it("keeps task evidence within the task and removes raw/derived history before the next message", async () => {
  const model = new FakeToolCallingModel({ toolCalls: [[]] });
  vi.spyOn(model, "bindTools").mockReturnValue(model);
  const inputs: BaseMessage[][] = [];
  const outputs = [
    new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "search_group_history",
          args: { period: "recent" },
          id: "history-call",
          type: "tool_call"
        }
      ]
    }),
    new AIMessage("DERIVED_HISTORY_MARKER"),
    new AIMessage("下一輪")
  ];
  vi.spyOn(model, "_generate").mockImplementation(async (messages) => {
    inputs.push([...messages]);
    const message = outputs.shift()!;
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  });
  const history: GroupHistory = {
    enabledFor: () => true,
    ingest: vi.fn(),
    purge: vi.fn(),
    validate: vi.fn(async () => true),
    search: vi.fn(async () => ({
      status: "success",
      start: "2026-10-30T00:00:00Z",
      end: "2026-10-30T00:30:00Z",
      incomplete: true,
      records: [
        {
          key: "opaque",
          speaker: "speaker-1",
          at: "2026-10-30T00:10:00Z",
          text: "RAW_HISTORY_MARKER"
        }
      ],
      dependency: { scope: "opaque", revision: "v1", epoch: "v1", keys: ["opaque"] }
    }))
  };
  const runtime = createHelperRuntime({
    model,
    summaryModel: model,
    state: createHelperAgentState({ checkpointer: new MemorySaver(), hmacKey: "synthetic" }),
    handlers: {},
    history
  });
  const input = {
    profile: helperProfile([]),
    event: {
      type: "message",
      source: { type: "group", groupId: "synthetic", userId: "synthetic" },
      message: { type: "text", text: "小哈，查剛才的討論" }
    },
    requestId: "synthetic-1"
  };
  const first = await runtime.handleTextTurn(input);
  expect(first?.replyText).toBe("DERIVED_HISTORY_MARKER");
  expect(first?.historyDependencies).toHaveLength(1);
  expect(JSON.stringify(inputs[1])).toContain("RAW_HISTORY_MARKER");
  await runtime.handleTextTurn({
    ...input,
    requestId: "synthetic-2",
    event: { ...input.event, message: { type: "text", text: "小哈，下一個問題" } }
  });
  expect(JSON.stringify(inputs[2])).not.toContain("RAW_HISTORY_MARKER");
  expect(JSON.stringify(inputs[2])).not.toContain("DERIVED_HISTORY_MARKER");
});
