import type { AccessStore } from "../../access/types.js";
import {
  getFunctionDefinition,
  isFunctionGrantableForPrincipal,
  isGrantableFunctionName
} from "../../functions/definitions.js";
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
  const requesterIsAdmin =
    input.requesterIsAdmin ??
    (await isRequesterAdmin(input.profile, input.event.source.userId, input.accessStore));
  const authorized = await sourceIsAuthorized({ ...input, requesterIsAdmin, sourceType });
  const enabledFunctions = authorized
    ? await resolveEffectiveFunctions({ ...input, requesterIsAdmin, sourceType })
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

async function resolveEffectiveFunctions(input: {
  profile: BotProfileConfig;
  event: LineEvent;
  accessStore: AccessStore;
  requesterIsAdmin: boolean;
  sourceType: EffectiveAccessContext["sourceType"];
}): Promise<FunctionName[]> {
  const profileFunctions = input.requesterIsAdmin
    ? input.profile.enabledFunctions
    : input.profile.enabledFunctions.filter(isDefaultUserFunctionAvailable);
  const userFunctions = input.event.source.userId
    ? await functionsForPrincipal(
        input.profile,
        input.accessStore,
        "user",
        input.event.source.userId
      )
    : [];

  if (input.sourceType !== "group" || !input.event.source.groupId) {
    return mergeFunctionNames(profileFunctions, userFunctions);
  }

  const groupFunctions = await functionsForPrincipal(
    input.profile,
    input.accessStore,
    "group",
    input.event.source.groupId
  );
  return mergeFunctionNames(mergeFunctionNames(profileFunctions, groupFunctions), userFunctions);
}

async function functionsForPrincipal(
  profile: BotProfileConfig,
  accessStore: AccessStore,
  principal: "user" | "group",
  principalId: string
): Promise<FunctionName[]> {
  const grants =
    principal === "user"
      ? await accessStore.listUserFunctionGrants(profile.name, principalId)
      : await accessStore.listGroupFunctionGrants(profile.name, principalId);
  const grantFunctions = grants.filter((name) => isFunctionGrantableForPrincipal(name, principal));
  const roleFunctions = capabilitiesToFunctionNames(
    await accessStore.listPrincipalCapabilities(profile.name, principal, principalId),
    principal
  );
  return mergeFunctionNames(grantFunctions, roleFunctions);
}

function capabilitiesToFunctionNames(
  capabilities: string[],
  principal: "user" | "group"
): FunctionName[] {
  return capabilities
    .map((capability) => capability.match(/^function:([^:]+):execute$/u)?.[1])
    .filter(
      (name): name is FunctionName =>
        typeof name === "string" &&
        isGrantableFunctionName(name as FunctionName) &&
        isFunctionGrantableForPrincipal(name as FunctionName, principal)
    );
}

function mergeFunctionNames(left: FunctionName[], right: FunctionName[]): FunctionName[] {
  return Array.from(new Set([...left, ...right]));
}

async function isRequesterAdmin(
  profile: BotProfileConfig,
  userId: string | undefined,
  accessStore: AccessStore
): Promise<boolean> {
  return Boolean(
    userId &&
    (profile.adminUserId === userId ||
      (await accessStore.hasActivePrincipal(profile.name, "admin", userId)))
  );
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
