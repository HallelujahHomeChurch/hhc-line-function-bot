import { describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { FakeToolCallingModel, tool } from "langchain";
import { z } from "zod";

import { createSdkAgent } from "../agent/sdk-runtime.js";

const config = (threadId: string) => ({
  configurable: { thread_id: threadId },
  recursionLimit: 50
});

describe("SDK agent runtime", () => {
  it("lets the SDK own the model-tool-model loop", async () => {
    const execute = vi.fn(async ({ query }: { query: string }) => ({
      status: "success",
      records: [{ sourceKind: "formal_schedule", excerpt: query }]
    }));
    const querySchedule = tool(execute, {
      name: "query_schedule",
      description: "Query the formal schedule.",
      schema: z.object({ query: z.string().min(1).max(500) }).strict()
    });
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "query_schedule",
            args: { query: "2026-09-06" },
            id: "schedule-1"
          }
        ],
        []
      ]
    });
    const agent = createSdkAgent({ model, tools: [querySchedule] });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "這週日誰服事？" }] },
      config("sdk-loop")
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ query: "2026-09-06" }, expect.anything());
    expect(result.messages.some((message) => message.getType() === "tool")).toBe(true);
  });

  it("does not execute a tool for ordinary chat", async () => {
    const execute = vi.fn(async () => ({ status: "success" }));
    const chatOnlyTool = tool(execute, {
      name: "query_schedule",
      description: "Query the formal schedule.",
      schema: z.object({ query: z.string() }).strict()
    });
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      tools: [chatOnlyTool]
    });

    await agent.invoke({ messages: [{ role: "user", content: "你好" }] }, config("sdk-chat"));

    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a schema error to the model and allows one bounded correction", async () => {
    const execute = vi.fn(async () => ({ status: "success" }));
    const guardedTool = tool(execute, {
      name: "query_schedule",
      description: "Query the formal schedule.",
      schema: z.object({ query: z.string() }).strict()
    });
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "query_schedule",
              args: { query: "Sunday", confirm: true },
              id: "invalid-1"
            }
          ],
          [
            {
              name: "query_schedule",
              args: { query: "Sunday" },
              id: "valid-1"
            }
          ],
          []
        ]
      }),
      tools: [guardedTool]
    });

    await agent.invoke({ messages: [{ role: "user", content: "查服事表" }] }, config("sdk-schema"));

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ query: "Sunday" }, expect.anything());
  });

  it("executes an identical tool call only once per agent run", async () => {
    const execute = vi.fn(async () => ({ status: "success", value: "Taiwan" }));
    const queryWikipedia = tool(execute, {
      name: "query_wikipedia",
      description: "Query Wikipedia.",
      schema: z.object({ query: z.string() }).strict()
    });
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ name: "query_wikipedia", args: { query: "Taiwan" }, id: "wiki-1" }],
          [{ name: "query_wikipedia", args: { query: "Taiwan" }, id: "wiki-2" }],
          []
        ]
      }),
      tools: [queryWikipedia]
    });

    await agent.invoke({ messages: [{ role: "user", content: "Taiwan" }] }, config("sdk-dedup"));

    expect(execute).toHaveBeenCalledOnce();
  });

  it("never executes a tool that was not exposed", async () => {
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "hidden_write",
              args: { confirm: true },
              id: "unknown-1"
            }
          ],
          []
        ]
      }),
      tools: []
    });

    await expect(
      agent.invoke({ messages: [{ role: "user", content: "do it" }] }, config("sdk-unknown"))
    ).rejects.toThrow(/hidden_write|tool/i);
  });

  it("pauses a write until the next event explicitly approves it", async () => {
    const execute = vi.fn(async () => ({ status: "saved" }));
    const saveSchedule = tool(execute, {
      name: "save_schedule",
      description: "Save a reviewed schedule.",
      schema: z.object({ previewId: z.string() }).strict()
    });
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "save_schedule",
              args: { previewId: "preview-1" },
              id: "write-1"
            }
          ],
          []
        ]
      }),
      tools: [saveSchedule],
      interruptOn: {
        save_schedule: { allowedDecisions: ["approve", "reject"] }
      }
    });

    const paused = await agent.invoke(
      { messages: [{ role: "user", content: "儲存這份服事表" }] },
      config("sdk-write")
    );

    expect(paused.__interrupt__).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();

    await agent.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      config("sdk-write")
    );

    expect(execute).toHaveBeenCalledOnce();
  });

  it("lets the model search, inspect, revise, and inspect again", async () => {
    const calls: string[] = [];
    const search = tool(
      async ({ query }: { query: string }) => {
        calls.push(`search:${query}`);
        return { ref: query.includes("PDF") ? "score-page" : "lyrics-page" };
      },
      {
        name: "search_sheet_music_web",
        description: "Search public pages for sheet music.",
        schema: z.object({ query: z.string() }).strict()
      }
    );
    const read = tool(
      async ({ ref }: { ref: string }) => {
        calls.push(`read:${ref}`);
        return ref === "score-page"
          ? { kind: "score", fileRef: "opaque-pdf" }
          : { kind: "lyrics", fileRef: null };
      },
      {
        name: "read_sheet_music_page",
        description: "Inspect one public search result.",
        schema: z.object({ ref: z.string() }).strict()
      }
    );
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "search_sheet_music_web",
              args: { query: "合成曲目 歌譜" },
              id: "web-1"
            }
          ],
          [
            {
              name: "read_sheet_music_page",
              args: { ref: "lyrics-page" },
              id: "web-2"
            }
          ],
          [
            {
              name: "search_sheet_music_web",
              args: { query: "合成曲目 合唱 樂譜 PDF" },
              id: "web-3"
            }
          ],
          [
            {
              name: "read_sheet_music_page",
              args: { ref: "score-page" },
              id: "web-4"
            }
          ],
          []
        ]
      }),
      tools: [search, read]
    });

    await agent.invoke(
      { messages: [{ role: "user", content: "幫我找合唱譜" }] },
      config("sdk-web")
    );

    expect(calls).toEqual([
      "search:合成曲目 歌譜",
      "read:lyrics-page",
      "search:合成曲目 合唱 樂譜 PDF",
      "read:score-page"
    ]);
  });

  it("bounds repeated model-tool loops", async () => {
    const execute = vi.fn(async () => ({ status: "not_found" }));
    const repeatedTool = tool(execute, {
      name: "query_schedule",
      description: "Query the formal schedule.",
      schema: z.object({ query: z.string() }).strict()
    });
    const agent = createSdkAgent({
      model: new FakeToolCallingModel({
        toolCalls: [1, 2, 3].map((index) => [
          {
            name: "query_schedule",
            args: { query: `repeat-${index}` },
            id: `repeat-${index}`
          }
        ])
      }),
      tools: [repeatedTool],
      modelCallLimit: 2,
      toolCallLimit: 2
    });

    await expect(
      agent.invoke({ messages: [{ role: "user", content: "一直找" }] }, config("sdk-limit"))
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
