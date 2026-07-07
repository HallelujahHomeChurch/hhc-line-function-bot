import type { AccessStore } from "../access/types.js";
import type { RegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
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
}

export interface AdminActionExecutionInput {
  action: AdminActionName;
  profile: BotProfileConfig;
  event: LineEvent;
  confirmed?: boolean;
}

export interface AdminActionRegistry {
  execute(input: AdminActionExecutionInput): Promise<FunctionExecutionResult>;
}

export function createAdminActionRegistry(
  options: AdminActionRegistryOptions
): AdminActionRegistry {
  return new DefaultAdminActionRegistry(options);
}

class DefaultAdminActionRegistry implements AdminActionRegistry {
  constructor(private readonly options: AdminActionRegistryOptions) {}

  async execute(input: AdminActionExecutionInput): Promise<FunctionExecutionResult> {
    const policy = await evaluateActionPolicy({
      action: input.action,
      profile: input.profile,
      source: input.event.source,
      accessStore: this.options.accessStore,
      confirmed: input.confirmed
    });
    if (!policy.allowed) {
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
