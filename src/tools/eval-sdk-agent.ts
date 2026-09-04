import { ChatDeepSeek } from "@langchain/deepseek";
import { FakeToolCallingModel, tool, type CreateAgentParams } from "langchain";
import { z } from "zod";

import { createSdkAgent } from "../agent/sdk-runtime.js";
import { createSdkFunctionTools } from "../agent/sdk-tools.js";
import { SDK_AGENT_ACCEPTANCE_CASES, validateSdkAgentCorpus } from "../evals/kernel/corpus.js";
import type { BotProfileConfig } from "../types.js";

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
const result = await createSdkAgent({
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
  return [await runWikipediaCase(liveModel), await runSheetMusicCase(liveModel)];
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
  const output = await createSdkAgent({
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

async function runSheetMusicCase(model: CreateAgentParams["model"]): Promise<LiveCaseResult> {
  const toolNames: string[] = [];
  let searches = 0;
  const tools = createSdkFunctionTools({
    context: {
      profile: helperProfile(["find_sheet_music"]),
      event: {
        type: "message",
        source: { type: "user", userId: "sdk-live-user" },
        message: { type: "text", text: "找歌譜" }
      }
    },
    functionRegistry: {
      find_sheet_music: async () => {
        toolNames.push("search_files");
        return {
          ok: true,
          replyText: "找不到內部歌譜。",
          agentResult: { status: "not_found", replyText: "找不到內部歌譜。" }
        };
      }
    },
    externalSheetMusicSearch: {
      allowed: true,
      webSearch: {
        search: async () => {
          searches += 1;
          toolNames.push("search_sheet_music_web");
          return searches === 1
            ? [{ title: "歌詞頁", url: "https://public.example.test/lyrics" }]
            : [{ title: "合唱譜 PDF", url: "https://public.example.test/score.pdf" }];
        }
      },
      pageReader: {
        read: async (url) => {
          toolNames.push("read_sheet_music_page");
          return url.endsWith(".pdf")
            ? { kind: "direct_file", untrusted: true, links: [] }
            : { kind: "html", untrusted: true, text: "只有歌詞", links: [] };
        }
      }
    }
  });
  const output = await createSdkAgent({
    model,
    tools,
    modelCallLimit: 10,
    toolCallLimit: 10,
    systemPrompt:
      "找歌譜先用 search_files。內部沒有且使用者已同意上網時，使用 search_sheet_music_web。每次搜尋後立刻以 read_sheet_music_page 讀取 ref。若只是歌詞頁，改用 PDF 查詢再搜尋並讀取。找到 direct_file 後停止工具並回覆候選，不要儲存。"
  }).invoke(
    {
      messages: [
        {
          role: "user",
          content: "找《測試詩歌》合唱譜；內部沒有的話，我同意這次上網找 PDF。"
        }
      ]
    },
    { configurable: { thread_id: `sdk-live-sheet-music-${Date.now()}` }, recursionLimit: 40 }
  );
  const expectedExternal = [
    "search_sheet_music_web",
    "read_sheet_music_page",
    "search_sheet_music_web",
    "read_sheet_music_page"
  ];
  const internalSearchCount = toolNames.filter((name) => name === "search_files").length;
  const externalSequence = toolNames.filter((name) => name !== "search_files");
  return {
    id: "sdk-v1/sheet_music/iterative-discovery@1",
    passed:
      internalSearchCount >= 1 &&
      internalSearchCount <= 2 &&
      expectedExternal.every((name, index) => externalSequence[index] === name) &&
      externalSequence.length === expectedExternal.length &&
      Boolean(output.messages.at(-1)?.text),
    toolNames
  };
}

function helperProfile(enabledFunctions: BotProfileConfig["enabledFunctions"]): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "synthetic",
    channelAccessToken: "synthetic",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions,
    permissionRequiredFunctions: [],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}
