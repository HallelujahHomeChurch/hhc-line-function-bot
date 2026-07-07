import { describe, expect, it } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { actionRequiresConfirmation, evaluateActionPolicy } from "../actions/policy.js";
import type { BotProfileConfig } from "../types.js";

function profile(): BotProfileConfig {
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
    registration: { enabled: true }
  };
}

describe("action policy", () => {
  it("allows bootstrap admins to run invite-code creation in direct chat", async () => {
    await expect(
      evaluateActionPolicy({
        action: "invite_code_create",
        profile: profile(),
        source: { type: "user", userId: "Uroot" },
        accessStore: new InMemoryAccessStore()
      })
    ).resolves.toEqual({ allowed: true, reason: "allowed" });
  });

  it("denies admin actions for non-admin direct users", async () => {
    await expect(
      evaluateActionPolicy({
        action: "invite_code_create",
        profile: profile(),
        source: { type: "user", userId: "Uguest" },
        accessStore: new InMemoryAccessStore()
      })
    ).resolves.toEqual({ allowed: false, reason: "admin_required" });
  });

  it("denies direct-only admin actions from groups before execution", async () => {
    await expect(
      evaluateActionPolicy({
        action: "invite_code_create",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "Uroot" },
        accessStore: new InMemoryAccessStore()
      })
    ).resolves.toEqual({ allowed: false, reason: "source_direct_required" });
  });

  it("checks profile-effective user function enablement without changing profile scope semantics", async () => {
    const accessStore = new InMemoryAccessStore();

    await expect(
      evaluateActionPolicy({
        action: "find_ppt_slides",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "U1" },
        accessStore,
        effectiveFunctions: ["find_ppt_slides"]
      })
    ).resolves.toEqual({ allowed: true, reason: "allowed" });

    await expect(
      evaluateActionPolicy({
        action: "query_service_schedule",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "U1" },
        accessStore,
        effectiveFunctions: ["find_ppt_slides"]
      })
    ).resolves.toEqual({ allowed: false, reason: "function_disabled" });
  });

  it("requires confirmation for destructive action metadata", () => {
    expect(actionRequiresConfirmation({ sideEffect: "destructive" }, false)).toBe(true);
    expect(actionRequiresConfirmation({ sideEffect: "destructive" }, true)).toBe(false);
    expect(actionRequiresConfirmation({ sideEffect: "security_change" }, false)).toBe(false);
  });
});
