import type { AccessStore } from "../access/types.js";
import type { RegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import {
  InMemoryConfirmationStore,
  type ConfirmationStore
} from "./confirmation-store.js";
import type {
  AdminActionName,
  BotProfileConfig,
  FunctionExecutionResult,
  LineEvent
} from "../types.js";
import { evaluateActionPolicy } from "./policy.js";

export interface AdminActionRegistryOptions {
  accessStore: AccessStore;
  registrationInviteCodeStore: RegistrationInviteCodeStore;
  registrationInviteCodeTtlMinutes: number;
  confirmationStore?: ConfirmationStore;
  confirmationTtlMinutes?: number;
}

export interface AdminActionExecutionInput {
  action: AdminActionName;
  profile: BotProfileConfig;
  event: LineEvent;
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
            ? "管理操作請到個人對話使用。"
            : "你沒有權限使用 admin 指令。"
      };
    }

    if (input.action === "invite_code_create") {
      return this.createInviteCode(input.profile, input.event.source.userId);
    }

    return {
      ok: true,
      replyText: "我目前只能協助產生註冊邀請碼，請改用 /invite-code-create 或 /help admin。"
    };
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
      return { ok: true, replyText: "確認碼無效或已過期。" };
    }
    return this.execute({
      action: request.action,
      profile: input.profile,
      event: input.event,
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
        "註冊邀請碼已建立",
        `有效期限：${this.options.registrationInviteCodeTtlMinutes} 分鐘`,
        `到期時間：${invite.expiresAt}`,
        "",
        "請把下面這行傳給要註冊的使用者或群組：",
        `/registry ${invite.code}`
      ].join("\n")
    };
  }
}
