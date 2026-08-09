import { getFunctionDefinitions } from "../functions/definitions.js";
import { matchExactWholeMessageIntent } from "../agent/plan-evidence.js";
import {
  FUNCTION_NAMES,
  type ActionName,
  type AdminActionName,
  type FunctionName,
  type SystemActionName
} from "../types.js";

export type ActionKind = "user_function" | "admin_action" | "system_action";
export type ActionAuth = "public" | "registered" | "admin";
export type ActionSourcePolicy = "direct" | "group" | "direct_or_group";
export type ActionSideEffect = "read_only" | "state_change" | "security_change" | "destructive";

export interface ActionDefinition<Name extends ActionName = ActionName> {
  name: Name;
  kind: ActionKind;
  auth: ActionAuth;
  sourcePolicy: ActionSourcePolicy;
  sideEffect: ActionSideEffect;
  naturalLanguage: boolean;
  auditAction?: string;
  description: string;
  naturalLanguageHints?: string[];
  groupNaturalLanguage?: boolean;
}

const userFunctionActions: ActionDefinition<FunctionName>[] = getFunctionDefinitions([
  ...FUNCTION_NAMES
]).map((definition) => ({
  name: definition.name,
  kind: "user_function",
  auth: "registered",
  sourcePolicy: "direct_or_group",
  sideEffect: actionSideEffectForFunction(definition.sideEffectLevel),
  naturalLanguage: true,
  description: definition.description
}));

function actionSideEffectForFunction(sideEffectLevel: string): ActionSideEffect {
  switch (sideEffectLevel) {
    case "read":
      return "read_only";
    case "destructive":
      return "destructive";
    case "write":
    case "admin":
    default:
      return "state_change";
  }
}

const systemActions: ActionDefinition<SystemActionName>[] = [
  {
    name: "introduce_bot",
    kind: "system_action",
    auth: "public",
    sourcePolicy: "direct_or_group",
    sideEffect: "read_only",
    naturalLanguage: true,
    description: "Controlled system response."
  },
  {
    name: "small_talk",
    kind: "system_action",
    auth: "public",
    sourcePolicy: "direct_or_group",
    sideEffect: "read_only",
    naturalLanguage: true,
    description: "Controlled system response."
  },
  {
    name: "show_help",
    kind: "system_action",
    auth: "public",
    sourcePolicy: "direct_or_group",
    sideEffect: "read_only",
    naturalLanguage: true,
    description: "Show source-safe enabled capabilities.",
    naturalLanguageHints: ["/help", "幫助", "說明", "功能", "可以做什麼"]
  },
  {
    name: "account_login",
    kind: "system_action",
    auth: "public",
    sourcePolicy: "direct",
    sideEffect: "security_change",
    naturalLanguage: true,
    description: "Start native LINE account linking for the current direct user.",
    naturalLanguageHints: ["登入", "登入帳戶", "登入 hhc 帳戶", "連結帳戶", "綁定帳戶", "login"]
  },
  {
    name: "show_account",
    kind: "system_action",
    auth: "public",
    sourcePolicy: "direct",
    sideEffect: "read_only",
    naturalLanguage: true,
    description: "Show a safe summary of the linked HHC account.",
    naturalLanguageHints: ["/whoami", "我是誰", "我的帳戶", "帳戶資訊", "我的身分"]
  }
];

const adminActions: ActionDefinition<AdminActionName>[] = [
  {
    name: "invite_code_create",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "security_change",
    naturalLanguage: true,
    auditAction: "invite_code.create",
    description:
      "Create a one-time registration invite code for opening a direct user or current group.",
    naturalLanguageHints: [
      "invite code",
      "registration code",
      "registry code",
      "create code",
      "產生邀請碼",
      "建立邀請碼",
      "註冊碼",
      "邀請碼"
    ]
  },
  {
    name: "knowledge_source_add",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "state_change",
    naturalLanguage: true,
    auditAction: "knowledge.source.add",
    description:
      "Register and immediately synchronize an internal knowledge source. Arguments: url, displayName, optional aliases, topics, sampleQueries, expiresAt (ISO date).",
    naturalLanguageHints: ["加入知識來源", "新增知識來源", "加入 notion 頁面", "新增 notion 頁面"]
  },
  {
    name: "knowledge_source_list",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "read_only",
    naturalLanguage: true,
    description: "List knowledge sources and their responsibility metadata for this profile.",
    naturalLanguageHints: ["知識來源列表", "列出知識來源", "有哪些知識來源"]
  },
  {
    name: "knowledge_source_sync",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "state_change",
    naturalLanguage: true,
    auditAction: "knowledge.source.sync",
    description: "Synchronize one knowledge source. Arguments: sourceKey.",
    naturalLanguageHints: ["同步知識來源", "更新知識來源"]
  },
  {
    name: "knowledge_source_enable",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "state_change",
    naturalLanguage: true,
    auditAction: "knowledge.source.enable",
    description: "Enable one knowledge source. Arguments: sourceKey.",
    naturalLanguageHints: ["啟用知識來源", "恢復知識來源"]
  },
  {
    name: "knowledge_source_disable",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "state_change",
    naturalLanguage: true,
    auditAction: "knowledge.source.disable",
    description: "Disable one knowledge source. Arguments: sourceKey.",
    naturalLanguageHints: ["停用知識來源", "關閉知識來源"]
  },
  {
    name: "knowledge_source_remove",
    kind: "admin_action",
    auth: "admin",
    sourcePolicy: "direct",
    sideEffect: "destructive",
    naturalLanguage: true,
    auditAction: "knowledge.source.remove",
    description: "Permanently remove one knowledge source. Arguments: sourceKey.",
    naturalLanguageHints: ["刪除知識來源", "移除知識來源"]
  }
];

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  ...userFunctionActions,
  ...systemActions,
  ...adminActions
];

export function getActionDefinition(name: ActionName): ActionDefinition | undefined {
  return ACTION_DEFINITIONS.find((definition) => definition.name === name);
}

export function matchNaturalLanguageSystemActionHint(text: string): SystemActionName | undefined {
  return systemActions.find((definition) =>
    matchExactWholeMessageIntent(text, definition.naturalLanguageHints ?? [])
  )?.name;
}

export function getNaturalLanguageAdminActions(): ActionDefinition<AdminActionName>[] {
  return adminActions.filter((definition) => definition.naturalLanguage);
}

export function enabledNaturalLanguageAdminActionNames(): AdminActionName[] {
  return getNaturalLanguageAdminActions().map((definition) => definition.name);
}

export function matchesNaturalLanguageAdminActionHint(text: string): boolean {
  return Boolean(matchNaturalLanguageAdminActionHint(text));
}

export function matchesGroupScopedNaturalLanguageAdminActionHint(text: string): boolean {
  const matched = matchNaturalLanguageAdminActionHint(text);
  return Boolean(
    matched &&
    getNaturalLanguageAdminActions().find((definition) => definition.name === matched)
      ?.groupNaturalLanguage
  );
}

export function matchNaturalLanguageAdminActionHint(text: string): AdminActionName | undefined {
  const normalized = text.normalize("NFKC").toLowerCase();
  let best: { name: AdminActionName; length: number } | undefined;
  for (const definition of getNaturalLanguageAdminActions()) {
    for (const hint of definition.naturalLanguageHints ?? []) {
      const normalizedHint = hint.toLowerCase();
      if (normalized.includes(normalizedHint) && normalizedHint.length > (best?.length ?? 0)) {
        best = { name: definition.name, length: normalizedHint.length };
      }
    }
  }
  return best?.name;
}
