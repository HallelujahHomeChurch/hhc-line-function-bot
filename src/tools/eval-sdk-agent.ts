import { ChatDeepSeek } from "@langchain/deepseek";
import { FakeToolCallingModel, tool, type CreateAgentParams } from "langchain";
import { z } from "zod";

import { createHelperAgent } from "../helper-agent/agent.js";
import { SDK_AGENT_ACCEPTANCE_CASES, validateSdkAgentCorpus } from "../evals/kernel/corpus.js";

const corpusErrors = validateSdkAgentCorpus();
if (corpusErrors.length) throw new Error(`invalid_sdk_agent_corpus:${corpusErrors.join(",")}`);

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
      model: "deepseek-v4-flash",
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
const result = await createEvalAgent({
  model,
  tools: [querySchedule, searchInformation],
  systemPrompt: "先查正式服事表；沒有資料時查可見資訊。必須說明筆記不是正式服事表。"
}).invoke(
  {
    messages: [{ role: "user", content: live ? "查服事表" : "這週日誰帶敬拜？那司琴呢？" }]
  },
  {
    configurable: { thread_id: live ? "sdk-live-eval" : "sdk-offline-eval" },
    recursionLimit: 50
  }
);

const reply = result.messages.at(-1)?.text ?? "";
const primaryPassed = live
  ? toolCalls.includes("query_schedule") &&
    (reply.length > 0 || toolCalls.includes("search_information"))
  : toolCalls.join(",") === "query_schedule,search_information";
const additionalCases = live ? await runAdditionalLiveCases(model) : [];
const passed = primaryPassed && additionalCases.every((testCase) => testCase.passed);

console.log(
  JSON.stringify({
    caseId: "sdk-v1/schedule/saved-note@1",
    mode: live ? "live" : "offline",
    model: live ? "deepseek-v4-flash" : "fake-tool-calling",
    passed,
    corpusCases: SDK_AGENT_ACCEPTANCE_CASES.length,
    toolNames: toolCalls,
    ...(live ? { additionalCases } : {}),
    elapsedMs: Math.round(performance.now() - startedAt)
  })
);

if (!passed) process.exitCode = 1;

function createEvalAgent(options: CreateAgentParams) {
  return createHelperAgent({
    model: options.model as Parameters<typeof createHelperAgent>[0]["model"],
    summaryModel: options.model as Parameters<typeof createHelperAgent>[0]["summaryModel"],
    tools: options.tools,
    systemPrompt: options.systemPrompt
  });
}

function requireLiveKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is required with --live");
  return key;
}

interface LiveCaseResult {
  id: string;
  passed: boolean;
  toolNames: string[];
}

async function runAdditionalLiveCases(
  liveModel: CreateAgentParams["model"]
): Promise<LiveCaseResult[]> {
  return [await runWikipediaCase(liveModel)];
}

async function runWikipediaCase(model: CreateAgentParams["model"]): Promise<LiveCaseResult> {
  const toolNames: string[] = [];
  const queryWikipedia = tool(
    async () => {
      toolNames.push("query_wikipedia");
      return { status: "success", title: "臺灣", extract: "臺灣位於東亞。" };
    },
    {
      name: "query_wikipedia",
      description: "查詢維基百科事實。成功後直接依結果回答。",
      schema: z.object({ query: z.string().min(1).max(500) }).strict()
    }
  );
  const output = await createEvalAgent({
    model,
    tools: [queryWikipedia],
    systemPrompt: "百科問題只呼叫 query_wikipedia。工具成功後直接回答，不要重複相同呼叫。"
  }).invoke(
    { messages: [{ role: "user", content: "查維基百科：臺灣在哪裡？" }] },
    { configurable: { thread_id: `sdk-live-wikipedia-${Date.now()}` }, recursionLimit: 30 }
  );
  return {
    id: "sdk-v1/wikipedia/routing@1",
    passed: toolNames.join(",") === "query_wikipedia" && Boolean(output.messages.at(-1)?.text),
    toolNames
  };
}
