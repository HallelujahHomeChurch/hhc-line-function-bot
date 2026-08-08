import { describe, expect, it, vi } from "vitest";

import { buildCapabilityCandidates } from "../agent/capability-candidates.js";
import { validateAgentPlan } from "../agent/plan-validator.js";
import { getFunctionDefinition } from "../functions/definitions.js";
import { FUNCTION_MODULES } from "../functions/modules.js";
import { normalizeFunctionArguments } from "../functions/argument-normalization.js";
import { createPendingFunctionTextMessageHandler } from "../functions/pending-function.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { FunctionName } from "../types.js";
import { createTestRuntime } from "../testing/create-test-runtime.js";
import type { AppConfig, BotProfileConfig } from "../types.js";

const action = "update_own_profile" as FunctionName;

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
  controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
  schedulePolicy: { meetingWindows: [], domains: [] }
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

  it("registers one shared module", () => {
    expect(FUNCTION_MODULES.filter(({ name }) => name === action)).toHaveLength(1);
  });

  it("previews normalized names and stores confirmation without mutating Account", async () => {
    const sessionStore = createTestRuntime().stores.session;
    const updateOwnProfile = vi.fn();
    const module = FUNCTION_MODULES.find(({ name }) => name === action)!;
    const handler = module.register({
      config: {} as AppConfig,
      clients: { sessionStore, accountAdminClient: { updateOwnProfile } }
    } as never).functions?.[action];

    expect(handler).toBeTypeOf("function");
    if (!handler) return;
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
    await expect(
      sessionStore.findPendingFunction({
        profileName: "main",
        source: { type: "user", userId: `U${"a".repeat(32)}` },
        requesterUserId: `U${"a".repeat(32)}`
      })
    ).resolves.toMatchObject({
      action,
      arguments: { firstName: "Ray", lastName: "Self", confirm: true }
    });
  });

  it("commits only the linked LINE caller and returns no task or memory payload", async () => {
    const sessionStore = createTestRuntime().stores.session;
    const updateOwnProfile = vi.fn().mockResolvedValue({ firstName: "Ray", lastName: "Self" });
    const module = FUNCTION_MODULES.find(({ name }) => name === action)!;
    const handler = module.register({
      config: {} as AppConfig,
      clients: { sessionStore, accountAdminClient: { updateOwnProfile } }
    } as never).functions?.[action];

    expect(handler).toBeTypeOf("function");
    if (!handler) return;
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

  it("cancels fresh confirmation state and ignores stale confirmation state", async () => {
    const now = () => new Date("2026-08-09T12:00:00.000Z");
    const sessionStore = new InMemorySessionStore({ now });
    const updateOwnProfile = vi.fn();
    const handler = FUNCTION_MODULES.find(({ name }) => name === action)!.register({
      config: {} as AppConfig,
      clients: { sessionStore, accountAdminClient: { updateOwnProfile } }
    } as never).functions?.[action];
    expect(handler).toBeDefined();
    if (!handler) return;
    const pending = createPendingFunctionTextMessageHandler({
      sessionStore,
      functions: { update_own_profile: handler }
    });
    const source = { type: "user" as const, userId: `U${"a".repeat(32)}` };
    const context = {
      profile,
      event: {
        type: "message" as const,
        source,
        message: { type: "text" as const, text: "取消" }
      },
      requestId: "cancel-profile"
    };
    await sessionStore.set({
      id: "fresh-profile",
      type: "pending_function",
      action,
      profileName: "main",
      requesterUserId: source.userId,
      source,
      arguments: { firstName: "Ray", lastName: "Self", confirm: true },
      expiresAt: "2026-08-09T12:01:00.000Z"
    });

    await expect(pending.matches({ text: "取消" }, context)).resolves.toBe(true);
    await expect(pending.handle({ text: "取消" }, context)).resolves.toMatchObject({
      replyText: "已取消這次操作。"
    });
    expect(updateOwnProfile).not.toHaveBeenCalled();

    await sessionStore.set({
      id: "stale-profile",
      type: "pending_function",
      action,
      profileName: "main",
      requesterUserId: source.userId,
      source,
      arguments: { firstName: "Ray", lastName: "Self", confirm: true },
      expiresAt: "2026-08-09T11:59:59.000Z"
    });
    await expect(pending.matches({ text: "確認" }, context)).resolves.toBe(false);
    expect(updateOwnProfile).not.toHaveBeenCalled();
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

  it.each(["/profile", "修改個人資料", "修改姓名", "更新姓名"])(
    "offers the shared capability for one exact intent: %s",
    (text) => {
      expect(
        buildCapabilityCandidates({
          text,
          enabledFunctions: [action],
          knowledgeSources: [],
          maxCandidates: 3,
          source: "user"
        }).map(({ capability }) => capability)
      ).toEqual([action]);
    }
  );

  it.each([
    "profile",
    "修改姓名！",
    "修改 姓名",
    "不要修改姓名",
    "請先修改姓名再下載週報",
    "他說修改姓名",
    "修改姓名或更新帳戶"
  ])("does not offer the write capability for negated, embedded, or ambiguous text: %s", (text) => {
    expect(
      buildCapabilityCandidates({
        text,
        enabledFunctions: [action],
        knowledgeSources: [],
        maxCandidates: 3,
        source: "user"
      })
    ).toEqual([]);
  });

  it("collects the first name without a provider and never executes the write directly", () => {
    expect(
      validateAgentPlan({
        text: "/profile",
        enabledFunctions: [action],
        candidates: [{ capability: action, reason: "explicit_intent", score: 400 }],
        proposal: { status: "no_plan", reasonCode: "providers_disabled" },
        minConfidence: 0.65,
        sourceType: "user"
      })
    ).toEqual({
      disposition: "collect",
      capability: action,
      arguments: {},
      missingSlot: "firstName",
      reasonCode: "missing_required_slot"
    });
  });
});
