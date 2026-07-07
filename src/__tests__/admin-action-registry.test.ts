import { describe, expect, it } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryRegistrationInviteCodeStore } from "../access/registration-invite-code-store.js";
import { createAdminActionRegistry } from "../actions/admin-registry.js";
import type { BotProfileConfig } from "../types.js";

function profile(registrationEnabled = true): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/line/helper/webhook",
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
});
