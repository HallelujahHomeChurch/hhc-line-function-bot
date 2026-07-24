import type { AccessStore } from "../access/types.js";
import type { RegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { InMemoryConfirmationStore, type ConfirmationStore } from "./confirmation-store.js";
import {
  getFunctionDefinition,
  isFunctionGrantableForPrincipal,
  isGrantableFunctionName,
  userFacingFunctionNames
} from "../functions/definitions.js";
import {
  isFunctionName,
  type AdminActionName,
  type BotProfileConfig,
  type FunctionExecutionResult,
  type FunctionName,
  type JsonRecord,
  type LineEvent
} from "../types.js";
import { evaluateActionPolicy } from "./policy.js";
import type { EmbeddingClient } from "../clients/embedding.js";
import { parseNotionRootId, type NotionKnowledgeClient } from "../clients/notion-knowledge.js";
import type { KnowledgeSourceRecord, KnowledgeStore } from "../knowledge/store.js";
import { markKnowledgeSyncFailure, syncKnowledgeSource } from "../knowledge/sync-service.js";

export interface AdminActionRegistryOptions {
  accessStore: AccessStore;
  registrationInviteCodeStore: RegistrationInviteCodeStore;
  registrationInviteCodeTtlMinutes: number;
  confirmationStore?: ConfirmationStore;
  confirmationTtlMinutes?: number;
  knowledgeStore?: KnowledgeStore;
  notionKnowledge?: NotionKnowledgeClient;
  knowledgeEmbedding?: EmbeddingClient;
  knowledgeEmbeddingBatchSize?: number;
}

export interface AdminActionExecutionInput {
  action: AdminActionName;
  profile: BotProfileConfig;
  event: LineEvent;
  arguments?: JsonRecord;
  confirmed?: boolean;
}

export interface AdminActionRegistry {
  execute(input: AdminActionExecutionInput): Promise<FunctionExecutionResult>;
  confirm(input: {
    code: string;
    profile: BotProfileConfig;
    event: LineEvent;
  }): Promise<FunctionExecutionResult>;
}

export function createAdminActionRegistry(
  options: AdminActionRegistryOptions
): AdminActionRegistry {
  return new DefaultAdminActionRegistry(options);
}

class DefaultAdminActionRegistry implements AdminActionRegistry {
  private readonly confirmationStore: ConfirmationStore;
  private readonly confirmationTtlMinutes: number;

  constructor(private readonly options: AdminActionRegistryOptions) {
    this.confirmationStore = options.confirmationStore ?? new InMemoryConfirmationStore();
    this.confirmationTtlMinutes = options.confirmationTtlMinutes ?? 5;
  }

  async execute(input: AdminActionExecutionInput): Promise<FunctionExecutionResult> {
    const policy = await evaluateActionPolicy({
      action: input.action,
      profile: input.profile,
      source: input.event.source,
      accessStore: this.options.accessStore,
      confirmed: input.confirmed
    });
    if (!policy.allowed) {
      if (policy.requiresConfirmation) {
        return this.createConfirmation(input);
      }
      return {
        ok: true,
        replyText:
          policy.reason === "source_direct_required"
            ? "請在 1 對 1 對話中使用這個 admin 操作。"
            : "你沒有權限使用 admin 指令。"
      };
    }

    switch (input.action) {
      case "invite_code_create":
        return this.createInviteCode(input.profile, input.event.source.userId);
      case "function_scope_grant":
        return this.grantFunctionScope(input);
      case "function_scope_revoke":
        return this.revokeFunctionScope(input);
      case "function_scope_list":
        return this.listFunctionScope(input);
      case "knowledge_source_add":
        return this.addKnowledgeSource(input);
      case "knowledge_source_list":
        return this.listKnowledgeSources(input);
      case "knowledge_source_sync":
        return this.syncKnowledgeSource(input);
      case "knowledge_source_enable":
        return this.setKnowledgeSourceEnabled(input, true);
      case "knowledge_source_disable":
        return this.setKnowledgeSourceEnabled(input, false);
      case "knowledge_source_remove":
        return this.removeKnowledgeSource(input);
    }
  }

  async confirm(input: {
    code: string;
    profile: BotProfileConfig;
    event: LineEvent;
  }): Promise<FunctionExecutionResult> {
    const actorUserId = input.event.source.userId;
    if (!actorUserId) {
      return { ok: true, replyText: "你沒有權限使用 admin 指令。" };
    }
    const request = await this.confirmationStore.consume(
      input.code,
      actorUserId,
      input.profile.name
    );
    if (!request) {
      return { ok: true, replyText: "確認碼不存在、已使用或已過期。" };
    }
    return this.execute({
      action: request.action,
      profile: input.profile,
      event: input.event,
      arguments: request.args,
      confirmed: true
    });
  }

  private async createConfirmation(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const actorUserId = input.event.source.userId;
    if (!actorUserId) {
      return { ok: true, replyText: "你沒有權限使用 admin 指令。" };
    }
    const request = await this.confirmationStore.create({
      profileName: input.profile.name,
      actorUserId,
      action: input.action,
      args: input.arguments,
      ttlMinutes: this.confirmationTtlMinutes
    });
    return {
      ok: true,
      replyText: [
        "這個操作需要再次確認。",
        `請在 ${this.confirmationTtlMinutes} 分鐘內回覆：`,
        `/confirm ${request.id}`
      ].join("\n")
    };
  }

  private async createInviteCode(
    profile: BotProfileConfig,
    actorUserId: string | undefined
  ): Promise<FunctionExecutionResult> {
    if (!actorUserId) {
      return { ok: true, replyText: "你沒有權限使用 admin 指令。" };
    }
    if (!profile.registration?.enabled) {
      return { ok: true, replyText: "這個 profile 沒有啟用註冊邀請碼。" };
    }
    const invite = await this.options.registrationInviteCodeStore.create({
      profileName: profile.name,
      createdBy: actorUserId,
      ttlMinutes: this.options.registrationInviteCodeTtlMinutes
    });
    await this.options.accessStore.recordAudit({
      profileName: profile.name,
      actorUserId,
      action: "invite_code.create",
      metadata: { ttlMinutes: this.options.registrationInviteCodeTtlMinutes }
    });
    return {
      ok: true,
      replyText: [
        "已建立一次性註冊邀請碼。",
        `有效時間：${this.options.registrationInviteCodeTtlMinutes} 分鐘`,
        `到期時間：${invite.expiresAt}`,
        "",
        "請複製下面這一行給要開通的使用者或群組：",
        `/registry ${invite.code}`
      ].join("\n")
    };
  }

  private async grantFunctionScope(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const parsed = parseFunctionScopeArgs(input);
    if (!parsed.ok) {
      return { ok: true, replyText: parsed.replyText };
    }
    if (parsed.target.type === "user") {
      if (!isFunctionGrantableForPrincipal(parsed.functionName, "user")) {
        return { ok: true, replyText: `${parsed.functionName} 不支援使用者授權。` };
      }
      await this.options.accessStore.addUserFunctionGrant({
        profileName: input.profile.name,
        userId: parsed.target.userId,
        functionName: parsed.functionName,
        createdBy: parsed.actorUserId
      });
      await this.options.accessStore.recordAudit({
        profileName: input.profile.name,
        actorUserId: parsed.actorUserId,
        action: "access.function.user.grant",
        targetType: "user",
        targetId: parsed.target.userId,
        metadata: { functionName: parsed.functionName }
      });
      return {
        ok: true,
        replyText: [
          "Function scope granted",
          `profile: ${input.profile.name}`,
          `user: ${parsed.target.userId}`,
          `function: ${parsed.functionName}`
        ].join("\n")
      };
    }
    if (!isFunctionGrantableForPrincipal(parsed.functionName, "group")) {
      return {
        ok: true,
        replyText: `${parsed.functionName} 只能開放給指定使用者。`
      };
    }
    await this.options.accessStore.addGroupFunctionGrant({
      profileName: input.profile.name,
      groupId: parsed.target.groupId,
      functionName: parsed.functionName,
      createdBy: parsed.actorUserId
    });
    await this.options.accessStore.recordAudit({
      profileName: input.profile.name,
      actorUserId: parsed.actorUserId,
      action: "access.function.grant",
      targetType: "group",
      targetId: parsed.target.groupId,
      metadata: { functionName: parsed.functionName }
    });
    return {
      ok: true,
      replyText: [
        "Function scope granted",
        `profile: ${input.profile.name}`,
        `group: ${parsed.target.groupId}`,
        `function: ${parsed.functionName}`
      ].join("\n")
    };
  }

  private async revokeFunctionScope(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const parsed = parseFunctionScopeArgs(input);
    if (!parsed.ok) {
      return { ok: true, replyText: parsed.replyText };
    }
    if (parsed.target.type === "user") {
      const revoked = await this.options.accessStore.disableUserFunctionGrant({
        profileName: input.profile.name,
        userId: parsed.target.userId,
        functionName: parsed.functionName,
        disabledBy: parsed.actorUserId
      });
      if (revoked) {
        await this.options.accessStore.recordAudit({
          profileName: input.profile.name,
          actorUserId: parsed.actorUserId,
          action: "access.function.user.revoke",
          targetType: "user",
          targetId: parsed.target.userId,
          metadata: { functionName: parsed.functionName }
        });
      }
      return {
        ok: true,
        replyText: revoked
          ? [
              "Function scope revoked",
              `profile: ${input.profile.name}`,
              `user: ${parsed.target.userId}`,
              `function: ${parsed.functionName}`
            ].join("\n")
          : "Function scope grant not found."
      };
    }
    const revoked = await this.options.accessStore.disableGroupFunctionGrant({
      profileName: input.profile.name,
      groupId: parsed.target.groupId,
      functionName: parsed.functionName,
      disabledBy: parsed.actorUserId
    });
    if (revoked) {
      await this.options.accessStore.recordAudit({
        profileName: input.profile.name,
        actorUserId: parsed.actorUserId,
        action: "access.function.revoke",
        targetType: "group",
        targetId: parsed.target.groupId,
        metadata: { functionName: parsed.functionName }
      });
    }
    return {
      ok: true,
      replyText: revoked
        ? [
            "Function scope revoked",
            `profile: ${input.profile.name}`,
            `group: ${parsed.target.groupId}`,
            `function: ${parsed.functionName}`
          ].join("\n")
        : "Function scope grant not found."
    };
  }

  private async listFunctionScope(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const actorUserId = input.event.source.userId;
    if (!actorUserId) {
      return { ok: true, replyText: "你沒有權限使用 admin 指令。" };
    }
    const target = readFunctionScopeTarget(input.arguments, input.event);
    if (!target) {
      return { ok: true, replyText: "請提供 groupId 或 userId。" };
    }
    if (target.type === "user") {
      const userGrants = (
        await this.options.accessStore.listUserFunctionGrants(input.profile.name, target.userId)
      ).filter((name) => isFunctionGrantableForPrincipal(name, "user"));
      const profileDefaults = input.profile.enabledFunctions.filter(isDefaultUserFunctionAvailable);
      const effectiveFunctions = mergeFunctionNames(profileDefaults, userGrants);
      return {
        ok: true,
        replyText: [
          "Function scopes",
          `profile: ${input.profile.name}`,
          `user: ${target.userId}`,
          `profile-default: ${profileDefaults.join(", ") || "(none)"}`,
          `user-grants: ${userGrants.join(", ") || "(none)"}`,
          `effective: ${effectiveFunctions.join(", ") || "(none)"}`
        ].join("\n")
      };
    }
    const groupGrants = (
      await this.options.accessStore.listGroupFunctionGrants(input.profile.name, target.groupId)
    ).filter((name) => isFunctionGrantableForPrincipal(name, "group"));
    const profileDefaults = input.profile.enabledFunctions.filter(isDefaultUserFunctionAvailable);
    const effectiveFunctions = mergeFunctionNames(profileDefaults, groupGrants);
    return {
      ok: true,
      replyText: [
        "Function scopes",
        `profile: ${input.profile.name}`,
        `group: ${target.groupId}`,
        `profile-global: ${input.profile.enabledFunctions.join(", ") || "(none)"}`,
        `profile-default: ${profileDefaults.join(", ") || "(none)"}`,
        `group-grants: ${groupGrants.join(", ") || "(none)"}`,
        `effective: ${effectiveFunctions.join(", ") || "(none)"}`
      ].join("\n")
    };
  }

  private knowledgeDependencies():
    { store: KnowledgeStore; notion: NotionKnowledgeClient } | undefined {
    return this.options.knowledgeStore && this.options.notionKnowledge
      ? { store: this.options.knowledgeStore, notion: this.options.notionKnowledge }
      : undefined;
  }

  private async addKnowledgeSource(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const dependencies = this.knowledgeDependencies();
    if (!dependencies) return { ok: true, replyText: "知識來源服務尚未設定完成。" };
    const url = readStringArg(input.arguments, ["url", "notionUrl", "pageUrl"]);
    const displayName = readStringArg(input.arguments, ["displayName", "name", "title"]);
    if (!url || !displayName) return { ok: true, replyText: "請提供頁面網址與顯示名稱。" };
    let externalRootId: string;
    try {
      externalRootId = parseNotionRootId(url);
    } catch {
      return { ok: true, replyText: "頁面網址格式不正確。" };
    }
    const expiresAt = readStringArg(input.arguments, ["expiresAt", "expiry", "expiration"]);
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(expiresAt))
      return { ok: true, replyText: "到期日請使用 YYYY-MM-DD。" };
    const sourceKey = sourceKeyFor(displayName, externalRootId);
    let source: KnowledgeSourceRecord | undefined;
    let synced: Awaited<ReturnType<typeof syncKnowledgeSource>>;
    try {
      source = await dependencies.store.upsertSource({
        profileName: input.profile.name,
        sourceKey,
        displayName,
        adapterType: "notion",
        externalRootId,
        rootUrl: url,
        enabled: true,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        aliases: readStringArrayArg(input.arguments, ["aliases", "alias"]),
        topics: readStringArrayArg(input.arguments, ["topics", "topic"]),
        sampleQueries: readStringArrayArg(input.arguments, [
          "sampleQueries",
          "sample_queries",
          "examples"
        ])
      });
      synced = await syncKnowledgeSource({
        source,
        store: dependencies.store,
        notion: dependencies.notion,
        embedding: this.options.knowledgeEmbedding,
        batchSize: this.options.knowledgeEmbeddingBatchSize
      });
    } catch {
      const outcome = source
        ? await markKnowledgeSyncFailure({
            source,
            store: dependencies.store,
            syncErrorCode: "source_unavailable"
          })
        : "not_found";
      const stale = outcome === "stale";
      await this.auditKnowledge(
        input,
        "knowledge.source.add",
        sourceKey,
        stale
          ? { outcome: "stale", errorCode: "staging_changed" }
          : { outcome: "failed", errorCode: "source_unavailable" }
      );
      if (stale) return { ok: true, replyText: "較新的知識來源版本已完成同步。" };
      return { ok: true, replyText: "無法讀取該頁面，請確認已分享給系統使用的整合服務。" };
    }
    await this.auditKnowledge(input, "knowledge.source.add", sourceKey, { outcome: "success" });
    return {
      ok: true,
      replyText: [
        `已加入知識來源：${displayName}`,
        `識別碼：${sourceKey}`,
        `文件：${synced.documents}，片段：${synced.chunks}`,
        synced.status === "embedding_pending" ? "語意索引待補，文字查詢已可使用。" : "同步完成。"
      ].join("\n")
    };
  }

  private async listKnowledgeSources(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const store = this.options.knowledgeStore;
    if (!store) return { ok: true, replyText: "知識來源服務尚未設定完成。" };
    const sources = await store.listSources({
      profileName: input.profile.name,
      includeDisabled: true
    });
    return {
      ok: true,
      replyText: sources.length
        ? [
            "知識來源：",
            ...sources.map(
              (source) =>
                `- ${source.sourceKey}｜${source.displayName}｜${source.enabled ? "啟用" : "停用"}｜${source.syncStatus ?? "pending"}${source.expiresAt ? `｜到期 ${source.expiresAt.slice(0, 10)}` : "｜永久"}｜別名 ${source.adminAliases.length}｜主題 ${source.adminTopics.length}｜範例問題 ${source.adminSampleQueries.length}`
            )
          ].join("\n")
        : "目前沒有知識來源。"
    };
  }

  private async syncKnowledgeSource(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const dependencies = this.knowledgeDependencies();
    const sourceKey = knowledgeSourceKey(input.arguments);
    if (!dependencies) return { ok: true, replyText: "知識來源服務尚未設定完成。" };
    if (!sourceKey) return { ok: true, replyText: "請提供知識來源識別碼。" };
    const source = (
      await dependencies.store.listSources({
        profileName: input.profile.name,
        includeDisabled: true
      })
    ).find((item) => item.sourceKey === sourceKey);
    if (!source) return { ok: true, replyText: "找不到這個知識來源。" };
    let synced: Awaited<ReturnType<typeof syncKnowledgeSource>>;
    try {
      synced = await syncKnowledgeSource({
        source,
        store: dependencies.store,
        notion: dependencies.notion,
        embedding: this.options.knowledgeEmbedding,
        batchSize: this.options.knowledgeEmbeddingBatchSize
      });
    } catch {
      const outcome = await markKnowledgeSyncFailure({
        source,
        store: dependencies.store,
        syncErrorCode: "source_unavailable"
      });
      const stale = outcome === "stale";
      await this.auditKnowledge(
        input,
        "knowledge.source.sync",
        sourceKey,
        stale
          ? { outcome: "stale", errorCode: "staging_changed" }
          : { outcome: "failed", errorCode: "source_unavailable" }
      );
      if (stale) return { ok: true, replyText: "較新的知識來源版本已完成同步。" };
      return { ok: true, replyText: "同步失敗，舊版有效內容仍會保留。" };
    }
    await this.auditKnowledge(input, "knowledge.source.sync", sourceKey, { outcome: "success" });
    return {
      ok: true,
      replyText: `同步完成：${synced.documents} 份文件、${synced.chunks} 個片段。`
    };
  }

  private async setKnowledgeSourceEnabled(
    input: AdminActionExecutionInput,
    enabled: boolean
  ): Promise<FunctionExecutionResult> {
    const sourceKey = knowledgeSourceKey(input.arguments);
    if (!this.options.knowledgeStore) return { ok: true, replyText: "知識來源服務尚未設定完成。" };
    if (!sourceKey) return { ok: true, replyText: "請提供知識來源識別碼。" };
    const source = await this.options.knowledgeStore.updateSource({
      profileName: input.profile.name,
      sourceKey,
      enabled
    });
    if (!source) return { ok: true, replyText: "找不到這個知識來源。" };
    await this.auditKnowledge(
      input,
      enabled ? "knowledge.source.enable" : "knowledge.source.disable",
      sourceKey
    );
    return { ok: true, replyText: `已${enabled ? "啟用" : "停用"}知識來源：${source.displayName}` };
  }

  private async removeKnowledgeSource(
    input: AdminActionExecutionInput
  ): Promise<FunctionExecutionResult> {
    const sourceKey = knowledgeSourceKey(input.arguments);
    if (!this.options.knowledgeStore) return { ok: true, replyText: "知識來源服務尚未設定完成。" };
    if (!sourceKey) return { ok: true, replyText: "請提供知識來源識別碼。" };
    const removed = await this.options.knowledgeStore.removeSource({
      profileName: input.profile.name,
      sourceKey
    });
    if (removed) await this.auditKnowledge(input, "knowledge.source.remove", sourceKey);
    return {
      ok: true,
      replyText: removed ? `已永久移除知識來源：${sourceKey}` : "找不到這個知識來源。"
    };
  }

  private async auditKnowledge(
    input: AdminActionExecutionInput,
    action: string,
    sourceKey: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const actorUserId = input.event.source.userId;
    if (!actorUserId) return;
    await this.options.accessStore.recordAudit({
      profileName: input.profile.name,
      actorUserId,
      action,
      targetType: "knowledge_source",
      targetId: sourceKey,
      metadata
    });
  }
}

function knowledgeSourceKey(args: JsonRecord | undefined): string | undefined {
  return readStringArg(args, ["sourceKey", "source", "key"]);
}
function sourceKeyFor(name: string, externalId: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40);
  return `${slug || "knowledge"}-${externalId.replaceAll("-", "").slice(-8)}`;
}

function parseFunctionScopeArgs(input: AdminActionExecutionInput):
  | {
      ok: true;
      actorUserId: string;
      target: FunctionScopeTarget;
      functionName: FunctionName;
    }
  | { ok: false; replyText: string } {
  const actorUserId = input.event.source.userId;
  if (!actorUserId) {
    return { ok: false, replyText: "你沒有權限使用 admin 指令。" };
  }
  const functionName = readFunctionName(input.arguments);
  if (!functionName) {
    return {
      ok: false,
      replyText: `請提供 functionName，可用功能：${userFacingFunctionNames().join(", ")}`
    };
  }
  const target = readFunctionScopeTarget(input.arguments, input.event);
  if (!target) {
    return { ok: false, replyText: "請提供 groupId 或 userId。" };
  }
  return { ok: true, actorUserId, target, functionName };
}

type FunctionScopeTarget = { type: "group"; groupId: string } | { type: "user"; userId: string };

function readFunctionName(args: JsonRecord | undefined): FunctionName | undefined {
  const value = readStringArg(args, ["functionName", "function", "function_name", "name"]);
  return value && isFunctionName(value) && isGrantableFunctionName(value) ? value : undefined;
}

function readTargetGroupId(args: JsonRecord | undefined, event: LineEvent): string | undefined {
  return (
    readStringArg(args, ["groupId", "group", "targetGroupId", "target_group_id"]) ??
    (event.source.type === "group" ? event.source.groupId : undefined)
  );
}

function readTargetUserId(args: JsonRecord | undefined): string | undefined {
  return readStringArg(args, ["userId", "user", "targetUserId", "target_user_id"]);
}

function readFunctionScopeTarget(
  args: JsonRecord | undefined,
  event: LineEvent
): FunctionScopeTarget | undefined {
  const targetType = readStringArg(args, ["targetType", "target_type", "type"])?.toLowerCase();
  const userId = readTargetUserId(args);
  if (targetType === "user" || userId) {
    return userId ? { type: "user", userId } : undefined;
  }
  const groupId = readTargetGroupId(args, event);
  return groupId ? { type: "group", groupId } : undefined;
}

function readStringArg(args: JsonRecord | undefined, keys: string[]): string | undefined {
  if (!args) {
    return undefined;
  }
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readStringArrayArg(args: JsonRecord | undefined, keys: string[]): string[] {
  if (!args) return [];
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (typeof value === "string") {
      return value
        .split(/[,，\n]/u)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function mergeFunctionNames(left: FunctionName[], right: FunctionName[]): FunctionName[] {
  return Array.from(new Set([...left, ...right]));
}

function isDefaultUserFunctionAvailable(functionName: FunctionName): boolean {
  return getFunctionDefinition(functionName)?.sideEffectLevel === "read";
}
