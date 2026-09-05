import { updateOwnProfileArgumentsSchema } from "../../function-arguments.js";
import { messages } from "../../messages.js";
import type { FunctionHandler } from "../../types.js";
import type { UpdateOwnProfileDependencies } from "./ports.js";

export function createUpdateOwnProfileHandler(
  dependencies: UpdateOwnProfileDependencies
): FunctionHandler {
  return async (rawArguments, context) => {
    const argumentsValue = updateOwnProfileArgumentsSchema.parse(rawArguments);
    if (argumentsValue.cancel) return { ok: true, replyText: "已取消修改姓名。" };
    if (!argumentsValue.firstName || !argumentsValue.lastName) {
      return { ok: true, replyText: "請依序輸入名字與姓氏。" };
    }
    if (context.event.source.type !== "user" || !context.event.source.userId) {
      return { ok: true, replyText: messages.permissionDenied };
    }
    if (!argumentsValue.confirm) {
      return {
        ok: true,
        writePhase: "preview",
        replyText: `請確認要更新姓名：\n姓名：${argumentsValue.firstName} ${argumentsValue.lastName}`,
        quickReplies: [
          { label: "確認", action: { type: "message", label: "確認", text: "確認" } },
          { label: "取消", action: { type: "message", label: "取消", text: "取消" } }
        ]
      };
    }

    const updated = await dependencies.accountClient.updateOwnProfile({
      lineUserId: context.event.source.userId,
      profileName: context.profile.name,
      firstName: argumentsValue.firstName,
      lastName: argumentsValue.lastName
    });
    return {
      ok: true,
      writePhase: "commit",
      replyText: `姓名已更新：${updated.firstName} ${updated.lastName}`,
      agentResult: { status: "success", replyText: "姓名已更新。" }
    };
  };
}
