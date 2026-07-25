import type { RegistrationInviteCodeStore } from "../../access/registration-invite-code-store.js";
import type { AccessStore } from "../../access/types.js";
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
    accessStore: AccessStore,
    command: string
  ): Promise<boolean>;
  formatAdminHelp(adminHandlers: AdminHandlerRegistry, includeAdvanced: boolean): string;
  directAccessPolicy(profile: BotProfileConfig): string;
  groupAccessPolicy(profile: BotProfileConfig): string;
  isBootstrapSuperAdmin(profile: BotProfileConfig, userId: string | undefined): boolean;
  isAdminUser(
    profile: BotProfileConfig,
    userId: string | undefined,
    accessStore: AccessStore
  ): Promise<boolean>;
  isDirectUserAllowed(
    profile: BotProfileConfig,
    userId: string | undefined,
    accessStore: AccessStore
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
  policies: PublicAccessCommandPolicies;
}): Promise<FunctionExecutionResult | undefined> {
  const parsed = input.policies.parseCommand(input.text);
  if (!parsed) {
    return undefined;
  }
  if (parsed.command === "help") {
    if (parsed.args[0]?.toLowerCase() === "admin") {
      if (
        !(await input.policies.adminAllowed(input.profile, input.event, input.accessStore, "help"))
      ) {
        return { ok: true, replyText: messages.adminUnauthorized };
      }
      return {
        ok: true,
        replyText: input.policies.formatAdminHelp(input.adminHandlers, parsed.args[1] === "all")
      };
    }
    return formatPublicHelp();
  }
  if (parsed.command === "whoami") {
    return handleWhoamiCommand(input);
  }
  if (parsed.command !== "registry") {
    return undefined;
  }
  return handleRegistryCommand(parsed.args, input);
}

function formatPublicHelp(): FunctionExecutionResult {
  return {
    ok: true,
    replyText: [
      "我可以協助你用自然語言查資料，也能依權限記住或更新教會資訊。",
      "直接告訴我名稱、日期、主題或要處理的內容就好。",
      "",
      "可用指令：",
      "/help - 查看我可以協助什麼",
      "/registry <code> - 使用邀請碼開通",
      "/whoami - 查看目前 LINE user/group 資訊",
      "/memories - 列出目前記住的資訊",
      "/forget-memory <id> - 移除一段記憶",
      "/help admin - 管理員指令說明"
    ].join("\n")
  };
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
      `superadmin: ${input.policies.isBootstrapSuperAdmin(input.profile, input.event.source.userId)}`,
      `admin: ${await input.policies.isAdminUser(input.profile, input.event.source.userId, input.accessStore)}`,
      `userAllowed: ${await input.policies.isDirectUserAllowed(input.profile, input.event.source.userId, input.accessStore)}`,
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
      input.accessStore
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
  return { ok: true, replyText: "已開通小哈。" };
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
  return {
    ok: true,
    replyText: `已開通此群組 ${groupId}${displayName ? ` (${displayName})` : ""}`
  };
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
