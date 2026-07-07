import { getFunctionDefinitions } from "../functions/definitions.js";
import {
  FUNCTION_NAMES,
  SYSTEM_ACTION_NAMES,
  type ActionName,
  type AdminActionName,
  type FunctionName,
  type SystemActionName
} from "../types.js";

export type ActionKind = "user_function" | "admin_action" | "system_action";
export type ActionAuth = "public" | "registered" | "admin" | "superadmin";
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
}

const userFunctionActions: ActionDefinition<FunctionName>[] = getFunctionDefinitions([
  ...FUNCTION_NAMES
]).map((definition) => ({
  name: definition.name,
  kind: "user_function",
  auth: "registered",
  sourcePolicy: "direct_or_group",
  sideEffect: "read_only",
  naturalLanguage: true,
  description: definition.description
}));

const systemActions: ActionDefinition<SystemActionName>[] = [...SYSTEM_ACTION_NAMES].map(
  (name) => ({
    name,
    kind: "system_action",
    auth: "public",
    sourcePolicy: "direct_or_group",
    sideEffect: "read_only",
    naturalLanguage: true,
    description: "Controlled system response."
  })
);

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
      "註冊碼",
      "邀請碼",
      "開通碼",
      "產生碼"
    ]
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

export function getNaturalLanguageAdminActions(): ActionDefinition<AdminActionName>[] {
  return adminActions.filter((definition) => definition.naturalLanguage);
}

export function enabledNaturalLanguageAdminActionNames(): AdminActionName[] {
  return getNaturalLanguageAdminActions().map((definition) => definition.name);
}

export function matchesNaturalLanguageAdminActionHint(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return getNaturalLanguageAdminActions().some((definition) =>
    definition.naturalLanguageHints?.some((hint) => normalized.includes(hint.toLowerCase()))
  );
}
