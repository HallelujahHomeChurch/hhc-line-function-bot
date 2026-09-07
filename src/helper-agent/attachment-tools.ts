import { tool } from "langchain";
import type { z } from "zod";
import { attachmentDraftArgumentsSchema } from "../function-arguments.js";

import type { FunctionExecutionResult, FunctionHandlerContext } from "../types.js";
import { takeToolCall } from "./budget.js";

export type AttachmentDraftHandler = (
  args: z.infer<typeof attachmentDraftArgumentsSchema>,
  context: FunctionHandlerContext
) => Promise<FunctionExecutionResult>;

export function createHelperAttachmentTools(options: {
  context: FunctionHandlerContext;
  updateDraft?: AttachmentDraftHandler;
  authorize: () => Promise<boolean>;
  onResult?: (result: FunctionExecutionResult) => void;
}) {
  if (
    !options.updateDraft ||
    options.context.profile.name !== "helper" ||
    !options.context.profile.enabledFunctions.includes("save_resource") ||
    !options.context.event.source.userId ||
    !["user", "group"].includes(options.context.event.source.type)
  )
    return [];
  return [
    tool(
      async (args) => {
        takeToolCall();
        try {
          if (!(await options.authorize())) return { status: "denied" };
          const result = await options.updateDraft!(args, options.context);
          options.onResult?.(result);
          return {
            status:
              result.writePreparation ??
              result.writePhase ??
              (result.ok ? "success" : "unavailable"),
            summary: result.replyText
              .split("\n")
              .filter((line) => !/^(檔名|大小|來源)：/u.test(line))
              .join("\n")
              .replace(/https?:\/\/\S+/giu, "[連結省略]")
              .slice(0, 2000)
          };
        } catch {
          return { status: "unavailable" };
        }
      },
      {
        name: "update_attachment_draft",
        description:
          "讀取目前附件草稿（空參數），或依使用者明確提供的用途／名稱更新草稿；不把問題或其他查詢當名稱。必須先明確同意保存附件。只管理草稿，不會下載、確認或發布；完成預覽後請使用者按保存附件。",
        schema: attachmentDraftArgumentsSchema
      }
    )
  ];
}
