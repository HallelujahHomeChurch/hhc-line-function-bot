import { matchNaturalLanguageAdminActionHint } from "./catalog.js";
import type { AdminActionName } from "../types.js";

export type AdminActionEvalExpected = AdminActionName | "deny";

export interface AdminActionEvalCase {
  text: string;
  action: AdminActionEvalExpected;
}

const ADMIN_ACTION_EVAL_CASES: AdminActionEvalCase[] = [
  { text: "幫我產生邀請碼", action: "invite_code_create" },
  { text: "建立一組註冊碼", action: "invite_code_create" },
  { text: "create an invite code", action: "invite_code_create" },
  { text: "enable function find_ppt_slides for this group", action: "deny" },
  { text: "disable function find_ppt_slides for this group", action: "deny" },
  { text: "這個群組能用哪些功能", action: "deny" },
  {
    text: "加入知識來源 https://www.notion.so/example 名稱聚會SOP",
    action: "knowledge_source_add"
  },
  { text: "列出知識來源", action: "knowledge_source_list" },
  { text: "同步知識來源 meeting-sop", action: "knowledge_source_sync" },
  { text: "啟用知識來源 meeting-sop", action: "knowledge_source_enable" },
  { text: "停用知識來源 meeting-sop", action: "knowledge_source_disable" },
  { text: "刪除知識來源 meeting-sop", action: "knowledge_source_remove" },
  { text: "請刪掉所有使用者", action: "deny" },
  { text: "把系統全部重設", action: "deny" }
];

export function getAdminActionEvalCases(): AdminActionEvalCase[] {
  return [...ADMIN_ACTION_EVAL_CASES];
}

export function evaluateAdminActionTextForEval(text: string): AdminActionEvalExpected {
  return matchNaturalLanguageAdminActionHint(text) ?? "deny";
}
