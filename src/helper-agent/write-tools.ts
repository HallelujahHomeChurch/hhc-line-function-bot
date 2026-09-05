import { tool } from "langchain";

import {
  saveMemoryAgentArgumentsSchema,
  saveResourceAgentArgumentsSchema,
  saveScheduleAgentArgumentsSchema
} from "../function-arguments.js";
import type { ActionExecutor } from "../runtime/action-executor.js";
import type { ActionReviewSession } from "../state/session-store.js";
import type { FunctionHandlerContext, JsonRecord } from "../types.js";

export interface HelperWriteToolsOptions {
  context: FunctionHandlerContext;
  executor: ActionExecutor;
  review?: ActionReviewSession;
  onResult?(result: Awaited<ReturnType<ActionExecutor["execute"]>>): void;
}

export function createHelperWriteTools(options: HelperWriteToolsOptions) {
  if (
    options.context.profile.name !== "helper" ||
    !options.context.event.source.userId ||
    !["user", "group"].includes(options.context.event.source.type)
  ) {
    return [];
  }

  const candidates = [
    {
      capability: "save_schedule" as const,
      value: tool((args) => execute(options, "propose_save_schedule", args as JsonRecord), {
        name: "propose_save_schedule",
        description: "提出完整服事表新增、修改、刪除或取代內容，交由使用者預覽確認。",
        schema: saveScheduleAgentArgumentsSchema,
        returnDirect: true
      })
    },
    {
      capability: "save_memory" as const,
      value: tool((args) => execute(options, "propose_save_memory", args as JsonRecord), {
        name: "propose_save_memory",
        description: "只在使用者明確要求記住文字時提出保存內容與可見範圍，交由使用者預覽確認。",
        schema: saveMemoryAgentArgumentsSchema,
        returnDirect: true
      })
    },
    {
      capability: "save_resource" as const,
      value: tool((args) => execute(options, "propose_save_resource", args as JsonRecord), {
        name: "propose_save_resource",
        description: "提出保存目前明確提供的 HTTPS 投影片或歌譜連結，交由使用者預覽確認。",
        schema: saveResourceAgentArgumentsSchema,
        returnDirect: true
      })
    }
  ];
  return candidates.flatMap(({ capability, value }) =>
    options.context.profile.enabledFunctions.includes(capability) ? [value] : []
  );
}

async function execute(
  options: HelperWriteToolsOptions,
  toolName: "propose_save_schedule" | "propose_save_memory" | "propose_save_resource",
  args: JsonRecord
) {
  if (!options.review || options.review.toolName !== toolName) {
    return { status: "denied" as const };
  }
  const outcome = await options.executor.execute({
    review: options.review,
    arguments: args,
    context: options.context
  });
  options.onResult?.(outcome);
  return outcome.status === "approved" ? outcome.result : outcome;
}
