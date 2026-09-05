import type { CapabilityName } from "../capabilities/names.js";
import { getActionDefinition, type ActionSideEffect } from "./catalog.js";
import {
  isCapabilityName,
  type ActionName,
  type BotProfileConfig,
  type LineSource
} from "../types.js";

export interface ActionPolicyInput {
  action: ActionName;
  profile: BotProfileConfig;
  source: LineSource;
  requesterIsAdmin?: boolean;
  effectiveFunctions?: CapabilityName[];
  confirmed?: boolean;
}

export interface ActionPolicyDecision {
  allowed: boolean;
  reason: string;
  requiresConfirmation?: boolean;
}

export async function evaluateActionPolicy(
  input: ActionPolicyInput
): Promise<ActionPolicyDecision> {
  const definition = getActionDefinition(input.action);
  if (!definition) {
    return { allowed: false, reason: "unknown_action" };
  }

  if (actionRequiresConfirmation(definition, Boolean(input.confirmed))) {
    return { allowed: false, reason: "confirmation_required", requiresConfirmation: true };
  }

  if (definition.sourcePolicy === "direct" && input.source.type !== "user") {
    return { allowed: false, reason: "source_direct_required" };
  }
  if (definition.sourcePolicy === "group" && input.source.type !== "group") {
    return { allowed: false, reason: "source_group_required" };
  }

  if (definition.auth === "admin" && input.requesterIsAdmin !== true) {
    return { allowed: false, reason: "admin_required" };
  }
  if (definition.kind === "user_function" && isCapabilityName(input.action)) {
    const enabledFunctions = input.effectiveFunctions ?? input.profile.enabledFunctions;
    if (!enabledFunctions.includes(input.action)) {
      return { allowed: false, reason: "function_disabled" };
    }
  }

  return { allowed: true, reason: "allowed" };
}

export function actionRequiresConfirmation(
  input: { sideEffect: ActionSideEffect },
  confirmed = false
): boolean {
  return input.sideEffect === "destructive" && !confirmed;
}
