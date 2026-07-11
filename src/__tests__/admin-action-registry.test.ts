import { describe, expect, it } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { InMemoryConfirmationStore } from "../actions/confirmation-store.js";
import { createAdminActionRegistry } from "../actions/admin-registry.js";
import type { BotProfileConfig } from "../types.js";

function profile(registrationEnabled = true): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["find_ppt_slides"],
    adminUserId: "Uroot",
    adminDirectOnly: true,
    directAccessPolicy: "managed",
    groupAccessPolicy: "managed",
    registration: { enabled: registrationEnabled }
  };
}

describe("admin action registry", () => {
  it("creates copyable invite codes and records audit events", async () => {
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "ADMINCODE"
    });
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore,
      registrationInviteCodeTtlMinutes: 60
    });

    const result = await registry.execute({
      action: "invite_code_create",
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uroot" }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("/registry ADMINCODE");
    expect(result.replyText.split("\n")).toContain("/registry ADMINCODE");
    await expect(registrationInviteCodeStore.consume("helper", "ADMINCODE")).resolves.toBe(true);
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "invite_code.create",
          actorUserId: "Uroot",
          metadata: { ttlMinutes: 60 }
        })
      ])
    );
  });

  it("does not create invite codes when registration is disabled", async () => {
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "DISABLED"
    });
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore,
      registrationInviteCodeTtlMinutes: 60
    });

    const result = await registry.execute({
      action: "invite_code_create",
      profile: profile(false),
      event: {
        type: "message",
        source: { type: "user", userId: "Uroot" }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.replyText).toContain("沒有啟用註冊邀請碼");
    await expect(registrationInviteCodeStore.consume("helper", "DISABLED")).resolves.toBe(false);
    expect(accessStore.audit).toEqual([]);
  });

  it("does not require confirmation for invite code creation", async () => {
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "ADMINCODE"
    });
    const confirmationStore = new InMemoryConfirmationStore({
      idFactory: () => {
        throw new Error("confirmation should not be created");
      }
    });
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore,
      registrationInviteCodeTtlMinutes: 60,
      confirmationStore
    });

    const result = await registry.execute({
      action: "invite_code_create",
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uroot" }
      }
    });

    expect(result.replyText).toContain("/registry ADMINCODE");
  });

  it("grants and revokes current-group function scopes from routed arguments", async () => {
    const accessStore = new InMemoryAccessStore();
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60
    });
    const groupEvent = {
      type: "message" as const,
      source: { type: "group" as const, groupId: "Cmain", userId: "Uroot" }
    };

    const grant = await registry.execute({
      action: "function_scope_grant",
      profile: profile(),
      event: groupEvent,
      arguments: { functionName: "find_sheet_music" }
    });
    const list = await registry.execute({
      action: "function_scope_list",
      profile: profile(),
      event: groupEvent
    });
    const revoke = await registry.execute({
      action: "function_scope_revoke",
      profile: profile(),
      event: groupEvent,
      arguments: { functionName: "find_sheet_music" }
    });

    await expect(accessStore.listGroupFunctionGrants("helper", "Cmain")).resolves.toEqual([]);
    expect(grant.replyText).toContain("find_sheet_music");
    expect(list.replyText).toContain("group-grants: find_sheet_music");
    expect(revoke.replyText).toContain("find_sheet_music");
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "access.function.grant",
          targetId: "Cmain",
          metadata: { functionName: "find_sheet_music" }
        }),
        expect.objectContaining({
          action: "access.function.revoke",
          targetId: "Cmain",
          metadata: { functionName: "find_sheet_music" }
        })
      ])
    );
  });

  it("grants and revokes user function scopes from routed arguments", async () => {
    const accessStore = new InMemoryAccessStore();
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore: new InMemoryRegistrationInviteCodeStore(),
      registrationInviteCodeTtlMinutes: 60
    });
    const directEvent = {
      type: "message" as const,
      source: { type: "user" as const, userId: "Uroot" }
    };

    const grant = await registry.execute({
      action: "function_scope_grant",
      profile: profile(),
      event: directEvent,
      arguments: {
        targetType: "user",
        userId: "Uwriter",
        functionName: "save_schedule"
      }
    });
    const list = await registry.execute({
      action: "function_scope_list",
      profile: profile(),
      event: directEvent,
      arguments: { targetType: "user", userId: "Uwriter" }
    });
    const revoke = await registry.execute({
      action: "function_scope_revoke",
      profile: profile(),
      event: directEvent,
      arguments: {
        targetType: "user",
        userId: "Uwriter",
        functionName: "save_schedule"
      }
    });

    await expect(accessStore.listUserFunctionGrants("helper", "Uwriter")).resolves.toEqual([]);
    expect(grant.replyText).toContain("save_schedule");
    expect(grant.replyText).toContain("user: Uwriter");
    expect(list.replyText).toContain("user-grants: save_schedule");
    expect(revoke.replyText).toContain("save_schedule");
    expect(accessStore.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "access.function.user.grant",
          targetType: "user",
          targetId: "Uwriter",
          metadata: { functionName: "save_schedule" }
        }),
        expect.objectContaining({
          action: "access.function.user.revoke",
          targetType: "user",
          targetId: "Uwriter",
          metadata: { functionName: "save_schedule" }
        })
      ])
    );
  });

  it("confirms a stored admin action only once", async () => {
    const accessStore = new InMemoryAccessStore();
    const registrationInviteCodeStore = new InMemoryRegistrationInviteCodeStore({
      codeFactory: () => "ADMINCODE"
    });
    const confirmationStore = new InMemoryConfirmationStore({
      idFactory: () => "CONFIRM1",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });
    await confirmationStore.create({
      profileName: "helper",
      actorUserId: "Uroot",
      action: "invite_code_create",
      ttlMinutes: 5
    });
    const registry = createAdminActionRegistry({
      accessStore,
      registrationInviteCodeStore,
      registrationInviteCodeTtlMinutes: 60,
      confirmationStore
    });

    const first = await registry.confirm({
      code: "CONFIRM1",
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uroot" }
      }
    });
    const second = await registry.confirm({
      code: "CONFIRM1",
      profile: profile(),
      event: {
        type: "message",
        source: { type: "user", userId: "Uroot" }
      }
    });

    expect(first.replyText).toContain("/registry ADMINCODE");
    expect(second.replyText).toContain("確認碼不存在");
  });
});
