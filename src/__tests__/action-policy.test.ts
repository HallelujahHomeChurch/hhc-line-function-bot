import { describe, expect, it } from "vitest";

import { getActionDefinition, matchNaturalLanguageSystemActionHint } from "../actions/catalog.js";
import { actionRequiresConfirmation, evaluateActionPolicy } from "../actions/policy.js";
import type { BotProfileConfig } from "../types.js";

function profile(): BotProfileConfig {
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
    permissionRequiredFunctions: [],
    adminUserId: "Uroot",
    adminDirectOnly: true,
    directAccessPolicy: "managed",
    groupAccessPolicy: "managed",
    registration: { enabled: true }
  };
}

describe("action policy", () => {
  it("normalizes exact shared help, login, and whoami aliases without matching embedded or negated text", async () => {
    expect(getActionDefinition("account_login")).toMatchObject({
      kind: "system_action",
      auth: "public",
      sourcePolicy: "direct",
      sideEffect: "security_change",
      naturalLanguage: true
    });
    for (const text of [
      "登入",
      "登入帳戶！",
      "登入 ＨＨＣ 帳戶？",
      "連結帳戶",
      "綁定帳戶",
      "LOGIN."
    ]) {
      expect(matchNaturalLanguageSystemActionHint(text)).toBe("account_login");
    }
    for (const text of ["/help", "幫助！", "說明", "功能", "可以做什麼？"]) {
      expect(matchNaturalLanguageSystemActionHint(text)).toBe("show_help");
    }
    for (const text of ["/whoami", "我是誰？", "我的帳戶", "帳戶資訊", "我的身分！"]) {
      expect(matchNaturalLanguageSystemActionHint(text)).toBe("show_account");
    }
    for (const text of [
      "我想登入帳戶看看",
      "不要登入",
      "先不要幫助",
      "不用說明",
      "不要查我的帳戶",
      "你是誰"
    ]) {
      expect(matchNaturalLanguageSystemActionHint(text)).toBeUndefined();
    }

    await expect(
      evaluateActionPolicy({
        action: "account_login",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "U1" }
      })
    ).resolves.toEqual({ allowed: false, reason: "source_direct_required" });
  });

  it("allows Account-authorized admins to run invite-code creation in direct chat", async () => {
    await expect(
      evaluateActionPolicy({
        action: "invite_code_create",
        profile: profile(),
        source: { type: "user", userId: "Uroot" },
        requesterIsAdmin: true
      })
    ).resolves.toEqual({ allowed: true, reason: "allowed" });
  });

  it("does not trust legacy bootstrap admin configuration", async () => {
    await expect(
      evaluateActionPolicy({
        action: "invite_code_create",
        profile: profile(),
        source: { type: "user", userId: "Uroot" },
        requesterIsAdmin: false
      })
    ).resolves.toEqual({ allowed: false, reason: "admin_required" });
  });

  it("denies direct-only admin actions from groups before execution", async () => {
    await expect(
      evaluateActionPolicy({
        action: "invite_code_create",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "Uroot" },
        requesterIsAdmin: true
      })
    ).resolves.toEqual({ allowed: false, reason: "source_direct_required" });
  });

  it("checks profile-effective user function enablement without changing profile scope semantics", async () => {
    await expect(
      evaluateActionPolicy({
        action: "find_ppt_slides",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "U1" },
        effectiveFunctions: ["find_ppt_slides"]
      })
    ).resolves.toEqual({ allowed: true, reason: "allowed" });

    await expect(
      evaluateActionPolicy({
        action: "query_schedule",
        profile: profile(),
        source: { type: "group", groupId: "C1", userId: "U1" },
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
