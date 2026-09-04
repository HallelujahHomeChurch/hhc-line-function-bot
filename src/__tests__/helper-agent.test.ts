import { AIMessage, FakeToolCallingModel, HumanMessage, ToolMessage } from "langchain";
import { describe, expect, it, vi } from "vitest";

import { createHelperAgent, SAFE_SUMMARY_PROMPT } from "../helper-agent/agent.js";

const config = (threadId: string) => ({
  configurable: { thread_id: threadId },
  recursionLimit: 50
});

function models() {
  const model = new FakeToolCallingModel({ toolCalls: [[]] });
  const summaryModel = new FakeToolCallingModel({ toolCalls: [[]] });
  vi.spyOn(model, "bindTools").mockReturnValue(model);
  const modelGenerate = vi.spyOn(model, "_generate").mockResolvedValue({
    generations: [{ text: "完成", message: new AIMessage("完成") }],
    llmOutput: {}
  });
  const summaryGenerate = vi.spyOn(summaryModel, "_generate").mockResolvedValue({
    generations: [{ text: "安全摘要", message: new AIMessage("安全摘要") }],
    llmOutput: {}
  });
  return { model, summaryModel, modelGenerate, summaryGenerate };
}

function longToolHistory() {
  const messages = [new HumanMessage("合成查詢")];
  for (let index = 0; index < 4; index += 1) {
    const id = `tool-${index}`;
    messages.push(
      new AIMessage({
        content: "",
        tool_calls: [{ name: "synthetic_lookup", args: { index }, id, type: "tool_call" }]
      }),
      new ToolMessage({
        content: String(index).repeat(9_000),
        name: "synthetic_lookup",
        tool_call_id: id
      })
    );
  }
  return { messages };
}

function longConversation(charsPerMessage: number) {
  return {
    messages: Array.from({ length: 8 }, (_, index) =>
      index % 2 === 0
        ? new HumanMessage(String(index).repeat(charsPerMessage))
        : new AIMessage(String(index).repeat(charsPerMessage))
    )
  };
}

describe("bounded helper agent", () => {
  it("clears old tool results before summarizing", async () => {
    const { model, summaryModel, summaryGenerate } = models();
    const result = await createHelperAgent({ model, summaryModel }).invoke(
      longToolHistory(),
      config("thread-clear")
    );
    const toolMessages = result.messages.filter(ToolMessage.isInstance);

    expect(toolMessages.slice(0, -2).every((message) => message.text === "[cleared]")).toBe(true);
    expect(toolMessages.slice(-2).every((message) => message.text !== "[cleared]")).toBe(true);
    expect(summaryGenerate).not.toHaveBeenCalled();
  });

  it("summarizes after sixteen thousand approximate tokens and keeps six recent messages", async () => {
    const { model, summaryModel, modelGenerate, summaryGenerate } = models();
    await createHelperAgent({ model, summaryModel }).invoke(
      longConversation(9_000),
      config("thread-summary")
    );

    expect(summaryGenerate).toHaveBeenCalledOnce();
    const mainMessages = modelGenerate.mock.calls.at(-1)?.[0] ?? [];
    expect(
      mainMessages.filter(
        (message) =>
          !message.getType().includes("system") &&
          message.additional_kwargs.lc_source !== "summarization"
      )
    ).toHaveLength(6);
  });

  it("ends before another provider call when reduced context remains over twenty-four thousand tokens", async () => {
    const { model, summaryModel, modelGenerate } = models();
    const result = await createHelperAgent({ model, summaryModel }).invoke(
      longConversation(18_000),
      config("thread-hard-limit")
    );

    expect(result.messages.at(-1)?.text).toContain("對話內容較長");
    expect(modelGenerate).not.toHaveBeenCalled();
  });

  it("uses a summary that cannot grant authority or claim current data", () => {
    expect(SAFE_SUMMARY_PROMPT).toContain("不得保留或推論權限");
    expect(SAFE_SUMMARY_PROMPT).toContain("正式資料");
    expect(SAFE_SUMMARY_PROMPT).toContain("新鮮度");
    expect(SAFE_SUMMARY_PROMPT).toContain("寫入完成");
  });
});
