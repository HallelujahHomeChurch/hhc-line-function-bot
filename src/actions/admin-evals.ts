import { matchesNaturalLanguageAdminActionHint } from "./catalog.js";
import type { AdminActionName } from "../types.js";

export type AdminActionEvalExpected = AdminActionName | "deny";

export interface AdminActionEvalCase {
  text: string;
  action: AdminActionEvalExpected;
}

const ADMIN_ACTION_EVAL_CASES: AdminActionEvalCase[] = [
  { text: "幫我產生邀請碼", action: "invite_code_create" },
  { text: "開一組註冊碼", action: "invite_code_create" },
  { text: "create an invite code", action: "invite_code_create" },
  { text: "幫我讓新人可以進來", action: "deny" },
  { text: "刪除這個群組", action: "deny" }
];

export function getAdminActionEvalCases(): AdminActionEvalCase[] {
  return [...ADMIN_ACTION_EVAL_CASES];
}

export function evaluateAdminActionTextForEval(text: string): AdminActionEvalExpected {
  return matchesNaturalLanguageAdminActionHint(text) ? "invite_code_create" : "deny";
}
