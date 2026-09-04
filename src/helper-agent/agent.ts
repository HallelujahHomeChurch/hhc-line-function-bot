import {
  AIMessage,
  ClearToolUsesEdit,
  contextEditingMiddleware,
  countTokensApproximately,
  createAgent,
  createMiddleware,
  modelCallLimitMiddleware,
  summarizationMiddleware,
  toolCallLimitMiddleware,
  type CreateAgentParams,
  type SummarizationMiddlewareConfig
} from "langchain";

import { exactToolCallDeduplicationMiddleware } from "../agent/sdk-runtime.js";
import type { AgentRunMode } from "./budget.js";

const limits: Record<AgentRunMode, number> = {
  normal: 4,
  sheet_music_research: 6
};

export const SAFE_SUMMARY_PROMPT = [
  "請簡短整理目前目標、已確認選擇、未解問題與一般對話指涉。",
  "不得保留或推論權限、可用工具、正式資料、新鮮度或寫入完成狀態。",
  "摘要不是授權或資料來源；後續必須重新查詢工具確認。"
].join("\n");

export interface HelperAgentOptions {
  model: CreateAgentParams["model"];
  summaryModel: SummarizationMiddlewareConfig["model"];
  checkpointer?: CreateAgentParams["checkpointer"];
  systemPrompt?: CreateAgentParams["systemPrompt"];
  tools?: CreateAgentParams["tools"];
  runMode?: AgentRunMode;
}

export function createHelperAgent({
  checkpointer,
  model,
  runMode = "normal",
  summaryModel,
  systemPrompt,
  tools = []
}: HelperAgentOptions) {
  const runLimit = limits[runMode];
  return createAgent({
    ...(checkpointer ? { checkpointer } : {}),
    model,
    systemPrompt,
    tools,
    middleware: [
      contextEditingMiddleware({
        edits: [new ClearToolUsesEdit({ trigger: { tokens: 8_000 }, keep: { messages: 2 } })],
        tokenCountMethod: "approx"
      }),
      summarizationMiddleware({
        model: summaryModel,
        trigger: { tokens: 16_000 },
        keep: { messages: 6 },
        trimTokensToSummarize: 16_000,
        summaryPrompt: SAFE_SUMMARY_PROMPT
      }),
      hardContextLimitMiddleware(24_000),
      exactToolCallDeduplicationMiddleware(),
      modelCallLimitMiddleware({ runLimit, exitBehavior: "end" }),
      toolCallLimitMiddleware({ runLimit, exitBehavior: "continue" })
    ]
  });
}

function hardContextLimitMiddleware(maxTokens: number) {
  return createMiddleware({
    name: "HardContextLimit",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async (state) => {
        if (countTokensApproximately(state.messages) < maxTokens) return;
        return {
          messages: [new AIMessage("對話內容較長，請縮小問題範圍後再試。")],
          jumpTo: "end" as const
        };
      }
    }
  });
}
