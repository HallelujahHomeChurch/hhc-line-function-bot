import { updateOwnProfileArgumentsSchema } from "../../function-arguments.js";
import type { FunctionDefinition } from "../catalog.js";

export const updateOwnProfileDefinition: FunctionDefinition = {
  name: "update_own_profile",
  displayName: "修改姓名",
  shortDescription: "修改目前連結 HHC 帳戶的姓名。",
  examples: ["/profile", "修改個人資料", "修改姓名", "更新姓名"],
  requires: ["session"],
  scope: "profile",
  sideEffectLevel: "write",
  agentCapability: {
    intents: ["/profile", "修改個人資料", "修改姓名", "更新姓名"],
    exactIntents: true,
    semanticDescription: "修改目前已連結 HHC 帳戶的名字與姓氏。",
    operations: []
  },
  allowedSources: ["user"],
  requiredSlots: [
    {
      name: "first_name",
      argument: "firstName",
      missingWhen: "blank",
      genericRequest: {
        phrases: ["/profile", "修改個人資料", "修改姓名", "更新姓名"],
        clearArguments: ["firstName", "lastName", "confirm", "cancel"]
      },
      prompt: "請輸入名字（First name）。"
    },
    {
      name: "last_name",
      argument: "lastName",
      missingWhen: "blank",
      prompt: "請輸入姓氏（Last name）。"
    }
  ],
  resourcePolicy: { kind: "none", remember: false, alias: false },
  memoryPolicy: { kind: "none" },
  clarificationPrompt: "請依序輸入名字與姓氏。",
  description:
    '- update_own_profile: update only the linked caller\'s first and last name after preview and explicit confirmation. Arguments: {"firstName":"given name","lastName":"family name"}.',
  argumentSchema: updateOwnProfileArgumentsSchema,
  quickReply: { label: "修改姓名", command: "/profile" },
  helpText: "修改已連結 HHC 帳戶的姓名，預覽確認後才會更新。"
};
