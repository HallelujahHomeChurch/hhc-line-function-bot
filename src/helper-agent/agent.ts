import {
  AIMessage,
  ClearToolUsesEdit,
  contextEditingMiddleware,
  countTokensApproximately,
  createAgent,
  createMiddleware,
  humanInTheLoopMiddleware,
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
  writeReview?: boolean;
  prepareWriteArguments?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
}

export function createHelperAgent({
  checkpointer,
  model,
  runMode = "normal",
  summaryModel,
  systemPrompt,
  tools = [],
  writeReview = false,
  prepareWriteArguments
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
      ...(writeReview
        ? [
            humanInTheLoopMiddleware({
              interruptOn: {
                propose_save_schedule: { allowedDecisions: ["approve", "reject"] },
                propose_save_memory: { allowedDecisions: ["approve", "reject"] },
                propose_save_resource: { allowedDecisions: ["approve", "reject"] }
              }
            }),
            bindWriteReviewArgumentsMiddleware(prepareWriteArguments)
          ]
        : []),
      modelCallLimitMiddleware({ runLimit, exitBehavior: "end" }),
      toolCallLimitMiddleware({ runLimit, exitBehavior: "continue" })
    ]
  });
}

function bindWriteReviewArgumentsMiddleware(
  prepare: ((name: string, args: Record<string, unknown>) => Record<string, unknown>) | undefined
) {
  return createMiddleware({
    name: "BindWriteReviewArguments",
    afterModel: async (state) => {
      if (!prepare) return;
      const message = [...state.messages].reverse().find(AIMessage.isInstance);
      if (!message?.tool_calls?.length) return;
      message.tool_calls = message.tool_calls.map((call) => ({
        ...call,
        args: prepare(call.name, call.args)
      }));
      return { messages: [message] };
    }
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
