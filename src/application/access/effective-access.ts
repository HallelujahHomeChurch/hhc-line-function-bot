import type { AccessStore } from "../../access/types.js";
import { getFunctionDefinition } from "../../functions/definitions.js";
import type { BotProfileConfig, FunctionName, LineEvent } from "../../types.js";

export interface EffectiveAccessContext {
  profile: BotProfileConfig;
  authorized: boolean;
  requesterIsAdmin: boolean;
  sourceType: "user" | "group" | "room";
}

export async function resolveEffectiveAccessContext(input: {
  profile: BotProfileConfig;
  event: LineEvent;
  accessStore: AccessStore;
  requesterIsAdmin?: boolean;
}): Promise<EffectiveAccessContext> {
  const sourceType = effectiveSourceType(input.event);
  const requesterIsAdmin = input.requesterIsAdmin === true;
  const authorized = await sourceIsAuthorized({ ...input, requesterIsAdmin, sourceType });
  const enabledFunctions = authorized
    ? resolveEffectiveFunctions({ profile: input.profile, requesterIsAdmin })
    : [];

  return {
    profile: { ...input.profile, enabledFunctions },
    authorized,
    requesterIsAdmin,
    sourceType
  };
}

export function isDefaultUserFunctionAvailable(functionName: FunctionName): boolean {
  return getFunctionDefinition(functionName)?.sideEffectLevel === "read";
}

async function sourceIsAuthorized(input: {
  profile: BotProfileConfig;
  event: LineEvent;
  accessStore: AccessStore;
  requesterIsAdmin: boolean;
  sourceType: EffectiveAccessContext["sourceType"];
}): Promise<boolean> {
  if (input.sourceType === "user") {
    const policy = directAccessPolicy(input.profile);
    if (policy === "blocked") return false;
    if (policy === "public") return true;
    const userId = input.event.source.userId;
    return Boolean(
      userId &&
      (input.requesterIsAdmin ||
        (await input.accessStore.hasActivePrincipal(input.profile.name, "user", userId)))
    );
  }

  if (input.sourceType === "group") {
    return Boolean(
      groupAccessPolicy(input.profile) === "managed" &&
      input.event.source.groupId &&
      (await input.accessStore.hasActivePrincipal(
        input.profile.name,
        "group",
        input.event.source.groupId
      ))
    );
  }

  return false;
}

function resolveEffectiveFunctions(input: {
  profile: BotProfileConfig;
  requesterIsAdmin: boolean;
}): FunctionName[] {
  return input.requesterIsAdmin
    ? input.profile.enabledFunctions
    : input.profile.enabledFunctions.filter(isDefaultUserFunctionAvailable);
}

function effectiveSourceType(event: LineEvent): EffectiveAccessContext["sourceType"] {
  if (event.source.type === "user") return "user";
  if (event.source.type === "group") return "group";
  return "room";
}

function directAccessPolicy(profile: BotProfileConfig) {
  return profile.directAccessPolicy ?? (profile.allowDirectUser ? "managed" : "blocked");
}

function groupAccessPolicy(profile: BotProfileConfig) {
  return profile.groupAccessPolicy ?? "blocked";
}
