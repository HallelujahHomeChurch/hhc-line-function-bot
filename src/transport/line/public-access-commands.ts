import type { RegistrationInviteCodeStore } from "../../access/registration-invite-code-store.js";
import type { AccessStore } from "../../access/types.js";
import type { EffectiveAccessContext } from "../../application/access/effective-access.js";
import {
  type AccountSurfacePresentation,
  renderAccountIdentity,
  renderCapabilityHelp,
  renderRegistrationCompletion
} from "../../application/capabilities/capability-presenters.js";
import { projectEffectiveCapabilities } from "../../application/capabilities/effective-capability-projection.js";
import { messages } from "../../messages.js";
import { emitProductEvent } from "../../observability/product-events.js";
import { matchNaturalLanguageSystemActionHint } from "../../actions/catalog.js";
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
  lineIdentity?: LineIdentityClient;
  adminHandlers: AdminHandlerRegistry;
  productContext: ProductEventContext;
  requesterIsAdmin: boolean;
  account?: AccountSurfacePresentation;
  accountAllowedFunctions?: BotProfileConfig["enabledFunctions"];
  startAccountLogin?(): Promise<{ bindingUrl: string }>;
  policies: PublicAccessCommandPolicies;
  resolveCurrentAccess(): Promise<EffectiveAccessContext>;
}): Promise<FunctionExecutionResult | undefined> {
  const parsed = input.policies.parseCommand(input.text);
  const systemAction = matchNaturalLanguageSystemActionHint(input.text);
  if (systemAction === "show_help" || parsed?.command === "help") {
    if (parsed?.args[0]?.toLowerCase() === "admin") {
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
    const help = renderCapabilityHelp(
      projectEffectiveCapabilities({ context }),
      "help",
      input.profile,
      input.event.source.type === "user" ? input.account : undefined,
      { sourceType: context.sourceType, authorized: context.authorized }
    );
    return context.authorized
      ? help
      : {
          ...help,
          replyText: [registrationPrompt(input.profile, input.event), "", help.replyText].join("\n")
        };
  }
  if (systemAction === "show_account" || parsed?.command === "whoami") {
    return handleWhoamiCommand(input);
  }
  if (systemAction === "account_login") {
    return handleLoginCommand(input);
  }
  if (!parsed) return undefined;
  if (parsed.command !== "registry") {
    return undefined;
  }
  return handleRegistryCommand(parsed.args, input);
}

async function handleWhoamiCommand(
  input: Parameters<typeof handlePublicAccessCommand>[0]
): Promise<FunctionExecutionResult> {
  if (input.event.source.type !== "user") {
    return { ok: true, replyText: "請在 1 對 1 對話中查看 HHC 帳戶資訊。" };
  }
  const account = input.account ?? { status: "disabled" as const };
  const context = await input.resolveCurrentAccess();
  return renderAccountIdentity(
    account,
    projectEffectiveCapabilities({
      context: {
        ...context,
        authorized: true,
        profile: { ...context.profile, enabledFunctions: input.accountAllowedFunctions ?? [] }
      }
    })
  );
}

async function handleLoginCommand(
  input: Parameters<typeof handlePublicAccessCommand>[0]
): Promise<FunctionExecutionResult> {
  if (input.event.source.type !== "user") {
    return { ok: true, replyText: "請在 1 對 1 對話中登入 HHC 帳戶。" };
  }
  switch (input.account?.status) {
    case "active":
      return { ok: true, replyText: "你的 HHC 帳戶已連結。傳送「我是誰」查看帳戶資訊。" };
    case "inactive":
      return { ok: true, replyText: "你的 HHC 帳戶目前無法使用，請聯絡管理同工協助。" };
    case "unavailable":
      return { ok: true, replyText: "目前無法確認帳戶狀態，請稍後再試。" };
    case "disabled":
    case undefined:
      return { ok: true, replyText: "這個 bot 目前沒有開放 HHC 帳戶登入。" };
    case "unbound":
      break;
  }
  try {
    const binding = await input.startAccountLogin?.();
    return binding
      ? { ok: true, replyText: `登入／綁定 HHC 帳戶：\n${binding.bindingUrl}` }
      : { ok: false, replyText: "目前無法開始帳戶登入／綁定，請稍後再試。" };
  } catch {
    return { ok: false, replyText: "目前無法開始帳戶登入／綁定，請稍後再試。" };
  }
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
  lineIdentity: LineIdentityClient | undefined,
  userId: string
): Promise<string | undefined> {
  if (!lineIdentity) return undefined;
  try {
    return nonBlank(await lineIdentity.getUserDisplayName(userId));
  } catch {
    return undefined;
  }
}

async function resolveGroupRegistrationDisplayName(
  lineIdentity: LineIdentityClient | undefined,
  groupId: string
): Promise<string | undefined> {
  if (!lineIdentity) return undefined;
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
