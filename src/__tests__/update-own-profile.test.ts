import type { CapabilityName } from "../capabilities/names.js";
import { describe, expect, it, vi } from "vitest";

import { getFunctionDefinition } from "../capabilities/catalog.js";
import { createUpdateOwnProfileHandler } from "../capabilities/update-own-profile/handler.js";
import { normalizeFunctionArguments } from "../functions/argument-normalization.js";
import type { BotProfileConfig } from "../types.js";

const action = "update_own_profile" as CapabilityName;

const profile: BotProfileConfig = {
  name: "main",
  webhookPath: "/api/line/webhook/main",
  channelSecret: "secret",
  channelAccessToken: "token",
  allowDirectUser: true,
  allowRooms: false,
  allowedMessageTypes: ["text"],
  groupRequireWakeWord: false,
  wakeKeywords: [],
  acceptMention: false,
  enabledFunctions: [action],
  permissionRequiredFunctions: [action],
  allowedProviders: [],
  allowSubscriptionProviders: false,
  providerPolicy: {},
  schedulePolicy: { meetingReferences: [], domains: [] }
};

describe("update_own_profile capability", () => {
  it("normalizes only the two declared name slots", () => {
    expect(
      normalizeFunctionArguments(
        action,
        { firstName: " Ray ", lastName: " Self ", confirm: true },
        { text: "Self" }
      )
    ).toEqual({ firstName: "Ray", lastName: "Self", confirm: true });
  });

  it("previews normalized names and stores confirmation without mutating Account", async () => {
    const updateOwnProfile = vi.fn();
    const handler = createUpdateOwnProfileHandler({ accountClient: { updateOwnProfile } as never });
    const result = await handler(
      { firstName: " Ray ", lastName: " Self " },
      {
        profile,
        event: {
          type: "message",
          source: { type: "user", userId: `U${"a".repeat(32)}` },
          message: { type: "text", text: "Self" }
        },
        requestId: "preview-profile"
      }
    );

    expect(result).toMatchObject({
      ok: true,
      writePhase: "preview",
      replyText: expect.stringContaining("Ray Self"),
      quickReplies: [
        expect.objectContaining({ label: "確認" }),
        expect.objectContaining({ label: "取消" })
      ]
    });
    expect(updateOwnProfile).not.toHaveBeenCalled();
  });

  it("commits only the linked LINE caller and returns no task or memory payload", async () => {
    const updateOwnProfile = vi.fn().mockResolvedValue({ firstName: "Ray", lastName: "Self" });
    const handler = createUpdateOwnProfileHandler({ accountClient: { updateOwnProfile } as never });
    const result = await handler(
      { firstName: "Ray", lastName: "Self", confirm: true },
      {
        profile,
        event: {
          type: "message",
          source: { type: "user", userId: `U${"a".repeat(32)}` },
          message: { type: "text", text: "確認" }
        },
        requestId: "confirm-profile"
      }
    );

    expect(updateOwnProfile).toHaveBeenCalledWith({
      lineUserId: `U${"a".repeat(32)}`,
      profileName: "main",
      firstName: "Ray",
      lastName: "Self"
    });
    expect(result).toEqual({
      ok: true,
      writePhase: "commit",
      replyText: "姓名已更新：Ray Self",
      agentResult: { status: "success", replyText: "姓名已更新。" }
    });
  });

  it("declares one direct-only bounded write capability", () => {
    expect(getFunctionDefinition(action)).toMatchObject({
      name: action,
      sideEffectLevel: "write",
      allowedSources: ["user"],
      requiredSlots: [{ argument: "firstName" }, { argument: "lastName" }],
      resourcePolicy: { kind: "none", remember: false, alias: false },
      memoryPolicy: { kind: "none" }
    });
  });
});
