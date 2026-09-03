import { ChatDeepSeek } from "@langchain/deepseek";
import { FakeToolCallingModel, tool } from "langchain";
import { z } from "zod";

import { createSdkAgent } from "../agent/sdk-runtime.js";

const live = process.argv.includes("--live");
const toolCalls: string[] = [];
const querySchedule = tool(
  async () => {
    toolCalls.push("query_schedule");
    return { status: "not_found", records: [] };
  },
  {
    name: "query_schedule",
    description: "查詢正式服事表。找不到時可查詢其他可見資訊。",
    schema: z.object({ query: z.string().min(1).max(500) }).strict()
  }
);
const searchInformation = tool(
  async () => {
    toolCalls.push("search_information");
    return {
      status: "success",
      records: [
        {
          ref: "synthetic-note",
          sourceKind: "visible_note",
          excerpt: "敬拜與司琴是待確認筆記。"
        }
      ]
    };
  },
  {
    name: "search_information",
    description: "查詢目前請求者可見的筆記與知識。",
    schema: z.object({ query: z.string().min(1).max(500) }).strict()
  }
);

const model = live
  ? new ChatDeepSeek({
      apiKey: requireLiveKey(),
      model: "deepseek-chat",
      temperature: 0,
      maxRetries: 0
    })
  : new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "query_schedule",
            args: { query: "2026-09-06" },
            id: "schedule-1"
          }
        ],
        [
          {
            name: "search_information",
            args: { query: "2026-09-06 敬拜 司琴" },
            id: "information-1"
          }
        ],
        []
      ]
    });

const startedAt = performance.now();
const result = await createSdkAgent({
  model,
  tools: [querySchedule, searchInformation],
  systemPrompt: "先查正式服事表；沒有資料時查可見資訊。必須說明筆記不是正式服事表。"
}).invoke(
  { messages: [{ role: "user", content: "這週日誰帶敬拜？那司琴呢？" }] },
  {
    configurable: { thread_id: live ? "sdk-live-eval" : "sdk-offline-eval" },
    recursionLimit: 50
  }
);

const reply = result.messages.at(-1)?.text ?? "";
const passed = live
  ? toolCalls.includes("query_schedule") &&
    (reply.length > 0 || toolCalls.includes("search_information"))
  : toolCalls.join(",") === "query_schedule,search_information";

console.log(
  JSON.stringify({
    caseId: "sdk-v1/schedule/saved-note@1",
    mode: live ? "live" : "offline",
    model: live ? "deepseek-chat" : "fake-tool-calling",
    passed,
    toolNames: toolCalls,
    elapsedMs: Math.round(performance.now() - startedAt)
  })
);

if (!passed) process.exitCode = 1;

function requireLiveKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is required with --live");
  return key;
}
