import type { RegistrationInviteCodeStore } from "../../access/registration-invite-code-store.js";
import type { AccessStore } from "../../access/types.js";
import type { EffectiveAccessContext } from "../../application/access/effective-access.js";
import {
  renderCapabilityHelp,
  renderRegistrationCompletion
} from "../../application/capabilities/capability-presenters.js";
import { projectEffectiveCapabilities } from "../../application/capabilities/effective-capability-projection.js";
import { messages } from "../../messages.js";
import { emitProductEvent } from "../../observability/product-events.js";
import type {
  AdminHandlerRegistry,
  BotProfileConfig,
  FunctionExecutionResult,
  LineEvent,
  LineIdentityClient,
  RouteObserver
} from "../../types.js";

interface ParsedCommand {
  command: string;
  args: string[];
}

export interface PublicAccessCommandPolicies {
  parseCommand(text: string | undefined): ParsedCommand | undefined;
  adminAllowed(
    profile: BotProfileConfig,
    event: LineEvent,
    requesterIsAdmin: boolean,
    command: string
  ): Promise<boolean>;
  formatAdminHelp(adminHandlers: AdminHandlerRegistry, includeAdvanced: boolean): string;
  directAccessPolicy(profile: BotProfileConfig): string;
  groupAccessPolicy(profile: BotProfileConfig): string;
  isDirectUserAllowed(
    profile: BotProfileConfig,
    userId: string | undefined,
    accessStore: AccessStore,
    requesterIsAdmin: boolean
  ): Promise<boolean>;
  isGroupAllowed(
    profile: BotProfileConfig,
    groupId: string | undefined,
    accessStore: AccessStore
  ): Promise<boolean>;
}

export interface ProductEventContext {
  routeObserver?: RouteObserver;
  requestId: string;
  hmacKey?: string;
}

export async function handlePublicAccessCommand(input: {
  text: string;
  profile: BotProfileConfig;
  event: LineEvent;
  accessStore: AccessStore;
  registrationInviteCodeStore: RegistrationInviteCodeStore;
  lineIdentity: LineIdentityClient;
  adminHandlers: AdminHandlerRegistry;
  productContext: ProductEventContext;
  requesterIsAdmin: boolean;
  policies: PublicAccessCommandPolicies;
  resolveCurrentAccess(): Promise<EffectiveAccessContext>;
}): Promise<FunctionExecutionResult | undefined> {
  const parsed = input.policies.parseCommand(input.text);
  if (!parsed) {
    return undefined;
  }
  if (parsed.command === "help") {
    if (parsed.args[0]?.toLowerCase() === "admin") {
      if (
        !(await input.policies.adminAllowed(
          input.profile,
          input.event,
          input.requesterIsAdmin,
          "help"
        ))
      ) {
        return { ok: true, replyText: messages.adminUnauthorized };
      }
      return {
        ok: true,
        replyText: input.policies.formatAdminHelp(input.adminHandlers, parsed.args[1] === "all")
      };
    }
    const context = await input.resolveCurrentAccess();
    return context.authorized
      ? renderCapabilityHelp(projectEffectiveCapabilities({ context }), "help")
      : { ok: true, replyText: registrationPrompt(input.profile, input.event) };
  }
  if (parsed.command === "whoami") {
    return handleWhoamiCommand(input);
  }
  if (parsed.command !== "registry") {
    return undefined;
  }
  return handleRegistryCommand(parsed.args, input);
}

async function handleWhoamiCommand(
  input: Parameters<typeof handlePublicAccessCommand>[0]
): Promise<FunctionExecutionResult> {
  const userId = input.event.source.userId ?? "(none)";
  const groupId = input.event.source.groupId ?? "(none)";
  return {
    ok: true,
    replyText: [
      "Who am I",
      `profile: ${input.profile.name}`,
      `source: ${input.event.source.type}`,
      `userId: ${userId}`,
      `groupId: ${groupId}`,
      `directPolicy: ${input.policies.directAccessPolicy(input.profile)}`,
      `groupPolicy: ${input.policies.groupAccessPolicy(input.profile)}`,
      `admin: ${input.requesterIsAdmin}`,
      `userAllowed: ${await input.policies.isDirectUserAllowed(input.profile, input.event.source.userId, input.accessStore, input.requesterIsAdmin)}`,
      `groupAllowed: ${await input.policies.isGroupAllowed(input.profile, input.event.source.groupId, input.accessStore)}`
    ].join("\n")
  };
}

async function handleRegistryCommand(
  args: string[],
  input: Parameters<typeof handlePublicAccessCommand>[0]
): Promise<FunctionExecutionResult> {
  if (!input.profile.registration?.enabled) {
    return { ok: true, replyText: "這個 bot 目前沒有開放邀請碼註冊。" };
  }
  const code = args[0]?.trim();
  if (!code) {
    return { ok: true, replyText: "請輸入 /registry <code>。" };
  }

  if (input.event.source.type === "group") {
    return handleGroupRegistryCommand(code, input);
  }

  if (input.event.source.type !== "user" || !input.event.source.userId) {
    return { ok: true, replyText: "請在個人聊天室或群組裡使用 /registry <code>。" };
  }

  if (
    await input.policies.isDirectUserAllowed(
      input.profile,
      input.event.source.userId,
      input.accessStore,
      input.requesterIsAdmin
    )
  ) {
    return { ok: true, replyText: "你已經可以使用小哈。" };
  }
  if (!(await input.registrationInviteCodeStore.consume(input.profile.name, code))) {
    return { ok: true, replyText: "邀請碼無效或已過期，請向管理員索取新的邀請碼。" };
  }
  const displayName = await resolveUserRegistrationDisplayName(
    input.lineIdentity,
    input.event.source.userId
  );
  await input.accessStore.addPrincipal({
    profileName: input.profile.name,
    type: "user",
    principalId: input.event.source.userId,
    displayName,
    createdBy: input.event.source.userId
  });
  await input.accessStore.recordAudit({
    profileName: input.profile.name,
    actorUserId: input.event.source.userId,
    action: "access.user.registry",
    targetType: "user",
    targetId: input.event.source.userId
  });
  await emitProductEvent(input.productContext.routeObserver, {
    eventName: "registration_completed",
    requestId: input.productContext.requestId,
    profileName: input.profile.name,
    source: input.event.source,
    hmacKey: input.productContext.hmacKey,
    resultClass: "success"
  });
  return renderPostCommitRegistration(input);
}

async function handleGroupRegistryCommand(
  code: string,
  input: Parameters<typeof handlePublicAccessCommand>[0]
): Promise<FunctionExecutionResult> {
  const groupId = input.event.source.groupId;
  const actorUserId = input.event.source.userId;
  if (!groupId || !actorUserId) {
    return { ok: true, replyText: "無法取得群組或申請人資訊。" };
  }
  if (await input.policies.isGroupAllowed(input.profile, groupId, input.accessStore)) {
    return { ok: true, replyText: "這個群組已經可以使用小哈。" };
  }
  if (!(await input.registrationInviteCodeStore.consume(input.profile.name, code))) {
    return { ok: true, replyText: "邀請碼無效或已過期，請向管理員索取新的邀請碼。" };
  }
  const displayName = await resolveGroupRegistrationDisplayName(input.lineIdentity, groupId);
  await input.accessStore.addPrincipal({
    profileName: input.profile.name,
    type: "group",
    principalId: groupId,
    displayName,
    createdBy: actorUserId
  });
  await input.accessStore.recordAudit({
    profileName: input.profile.name,
    actorUserId,
    action: "access.group.registry",
    targetType: "group",
    targetId: groupId
  });
  await emitProductEvent(input.productContext.routeObserver, {
    eventName: "registration_completed",
    requestId: input.productContext.requestId,
    profileName: input.profile.name,
    source: input.event.source,
    hmacKey: input.productContext.hmacKey,
    resultClass: "success"
  });
  return renderPostCommitRegistration(input);
}

async function renderPostCommitRegistration(
  input: Parameters<typeof handlePublicAccessCommand>[0]
): Promise<FunctionExecutionResult> {
  try {
    const current = await input.resolveCurrentAccess();
    return renderRegistrationCompletion(projectEffectiveCapabilities({ context: current }));
  } catch {
    return { ok: true, replyText: "已開通，你現在可以使用小哈。" };
  }
}

export function registrationPrompt(profile: BotProfileConfig, event: LineEvent): string {
  if (profile.registration?.enabled) {
    if (event.source.type === "group") {
      return "這個群組還沒有開通小哈，請先找管理員協助註冊。";
    }
    return "你尚未開通小哈，請先找管理員協助註冊。";
  }
  return "你尚未開通小哈，請聯絡管理同工協助。";
}

async function resolveUserRegistrationDisplayName(
  lineIdentity: LineIdentityClient,
  userId: string
): Promise<string | undefined> {
  try {
    return nonBlank(await lineIdentity.getUserDisplayName(userId));
  } catch {
    return undefined;
  }
}

async function resolveGroupRegistrationDisplayName(
  lineIdentity: LineIdentityClient,
  groupId: string
): Promise<string | undefined> {
  try {
    return nonBlank(await lineIdentity.getGroupDisplayName(groupId));
  } catch {
    return undefined;
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
