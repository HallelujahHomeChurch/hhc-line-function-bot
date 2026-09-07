import type { AgentJobStore } from "../agent/jobs.js";
import { z } from "zod";
import type { CapabilityName } from "../capabilities/names.js";
import type { SessionStore } from "../state/session-store.js";
import { tool } from "langchain";
import { getFunctionDefinition } from "../capabilities/catalog.js";
import { takeToolCall } from "./budget.js";

import {
  saveMemoryAgentArgumentsSchema,
  saveResourceAgentArgumentsSchema,
  saveScheduleAgentArgumentsSchema
} from "../function-arguments.js";
import type { FunctionHandlerContext, JsonRecord } from "../types.js";

export interface HelperWriteToolsOptions {
  context: FunctionHandlerContext;
  sessions?: SessionStore;
  jobs?: AgentJobStore;
  hasCurrentDraft?: boolean;
  currentPolicyKey?: () => Promise<string>;
  beforeCancel?: () => boolean;
  authorize?: (capability: CapabilityName) => Promise<boolean>;
  now?: () => Date;
  propose(
    toolName: "propose_save_schedule" | "propose_save_memory" | "propose_save_resource",
    args: JsonRecord
  ): Promise<unknown>;
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
        description: getFunctionDefinition("save_schedule")!.agentCapability!.semanticDescription,
        schema: saveScheduleAgentArgumentsSchema
      })
    },
    {
      capability: "save_memory" as const,
      value: tool((args) => execute(options, "propose_save_memory", args as JsonRecord), {
        name: "propose_save_memory",
        description: "只在使用者明確要求記住文字時提出保存內容與可見範圍，交由使用者預覽確認。",
        schema: saveMemoryAgentArgumentsSchema
      })
    },
    {
      capability: "save_resource" as const,
      value: tool((args) => execute(options, "propose_save_resource", args as JsonRecord), {
        name: "propose_save_resource",
        description: "提出保存目前明確提供的 HTTPS 投影片或歌譜連結，交由使用者預覽確認。",
        schema: saveResourceAgentArgumentsSchema
      })
    }
  ];
  return [
    ...candidates.flatMap(({ capability, value }) =>
      options.context.profile.enabledFunctions.includes(capability) ? [value] : []
    ),
    ...createCurrentDraftTools(options)
  ];
}

async function execute(
  options: HelperWriteToolsOptions,
  toolName: "propose_save_schedule" | "propose_save_memory" | "propose_save_resource",
  args: JsonRecord
) {
  takeToolCall();
  return options.propose(toolName, args);
}

/** Domain replies can contain source details; only bounded business prompts reach the model. */
export function safeWriteClarification(text: string): string {
  return text.replace(/(?:https?:\/\/|www\.)\S+/giu, "[連結]").slice(0, 2000);
}

function createCurrentDraftTools(options: HelperWriteToolsOptions) {
  if (
    !options.hasCurrentDraft ||
    !options.sessions ||
    !options.authorize ||
    !options.currentPolicyKey ||
    !["save_memory", "save_schedule"].some((name) =>
      options.context.profile.enabledFunctions.includes(name as CapabilityName)
    )
  )
    return [];
  const currentDraft = async () => {
    const draft = await options.sessions!.findActionReview({
      profileName: options.context.profile.name,
      source: options.context.event.source,
      requesterUserId: options.context.event.source.userId
    });
    if (
      !draft ||
      (options.currentPolicyKey !== undefined &&
        draft.policyKey !== (await options.currentPolicyKey())) ||
      new Date(draft.expiresAt).getTime() <= (options.now?.() ?? new Date()).getTime() ||
      !["propose_save_memory", "propose_save_schedule"].includes(draft.toolName)
    )
      return undefined;
    const capability = draft.toolName === "propose_save_memory" ? "save_memory" : "save_schedule";
    if (
      !options.context.profile.enabledFunctions.includes(capability) ||
      !(await options.authorize!(capability))
    )
      return undefined;
    const args = draft.draftArguments;
    if (!args || typeof args.content !== "string") return undefined;
    return {
      review: draft,
      toolName: draft.toolName as "propose_save_memory" | "propose_save_schedule",
      args,
      content: args.content
    };
  };
  return [
    tool(
      async () => {
        takeToolCall();
        try {
          const draft = await currentDraft();
          return draft ? options.propose(draft.toolName, draft.args) : { status: "denied" };
        } catch {
          return { status: "unavailable" };
        }
      },
      {
        name: "preview_current_draft",
        description:
          "重新顯示伺服器保存的完整草稿與新的確認按鈕，包括舊確認已過期但草稿仍有效時。原文無需重新輸入；不會提交。",
        schema: z.object({}).strict()
      }
    ),
    ...(options.jobs && options.beforeCancel
      ? [
          tool(
            async () => {
              takeToolCall();
              try {
                if (!options.beforeCancel!()) return { status: "denied" };
                const draft = await currentDraft();
                if (!draft) return { status: "denied" };
                const claimed = await options.sessions!.takeActionReview({
                  id: draft.review.id,
                  profileName: options.context.profile.name,
                  source: options.context.event.source,
                  requesterUserId: options.context.event.source.userId!
                });
                if (!claimed) return { status: "denied" };
                await options.jobs!.fail(claimed.resultJobId, "review_cancelled");
                return { status: "cancelled" };
              } catch {
                return { status: "unavailable" };
              }
            },
            {
              name: "cancel_current_draft",
              description:
                "只在使用者明確要求放棄或丟棄目前草稿時取消草稿和確認資格；詢問、暫停或先不要保存不代表放棄草稿。不能提交。",
              schema: z.object({}).strict()
            }
          )
        ]
      : []),
    tool(
      async () => {
        takeToolCall();
        try {
          const draft = await currentDraft();
          if (!draft) return { status: "denied" };
          const content = safeWriteClarification(draft.content);
          const projection = {
            status: "draft",
            kind: draft.toolName === "propose_save_memory" ? "memory" : "schedule",
            title: safeWriteClarification(String(draft.args.title ?? "")).slice(0, 120),
            content: content.slice(0, 1600),
            totalCharacters: draft.content.length,
            truncated: content.length > 1600 || draft.content.length > 2000
          };
          while (JSON.stringify(projection).length > 2000) {
            projection.content = projection.content.slice(
              0,
              Math.max(0, projection.content.length - 100)
            );
            projection.truncated = true;
          }
          return projection;
        } catch {
          return { status: "unavailable" };
        }
      },
      {
        name: "get_current_draft",
        description:
          "讀取目前尚未提交的文字記憶或服事表草稿；回傳有界片段，truncated 表示不是全文。摘要遺失原文時先使用本工具；草稿不是已保存內容。",
        schema: z.object({}).strict()
      }
    ),
    tool(
      async ({ oldText, newText }) => {
        takeToolCall();
        try {
          const draft = await currentDraft();
          if (!draft) return { status: "denied" };
          const index = draft.content.indexOf(oldText);
          if (index < 0)
            return { status: "not_found", clarification: "草稿沒有這段原文，請指定要修改的原句。" };
          if (draft.content.indexOf(oldText, index + 1) >= 0)
            return {
              status: "ambiguous",
              clarification: "原文出現多次，請提供包含相鄰文字的唯一片段。"
            };
          return options.propose(draft.toolName, {
            ...draft.args,
            content:
              draft.content.slice(0, index) + newText + draft.content.slice(index + oldText.length)
          });
        } catch {
          return { status: "unavailable" };
        }
      },
      {
        name: "revise_current_draft",
        description:
          "依使用者明確要求，將伺服器目前草稿的一段唯一原文替換成新文字。保留其餘完整內容與設定，重新產生預覽；不能確認或提交。oldText 必須逐字相同且只出現一次。",
        schema: z
          .object({ oldText: z.string().min(1).max(2000), newText: z.string().max(2000) })
          .strict()
      }
    )
  ];
}
