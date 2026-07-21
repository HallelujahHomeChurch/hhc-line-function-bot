import { describe, expect, it, vi } from "vitest";

import { createPendingResolutionTextMessageHandler } from "../functions/pending-resolution.js";
import { messages } from "../messages.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { FunctionHandler } from "../types.js";

describe("pending resolver choice", () => {
  it("resumes grounded arguments without rerunning planning", async () => {
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "resolution-1",
      type: "pending_resolution",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "G1", userId: "U1" },
      capability: "query_schedule",
      groundedArguments: { query: "", specificDate: "2026-07-21" },
      candidates: [
        { id: "media", domainKey: "media_team_service", displayName: "影視團隊服事" },
        { id: "family", domainKey: "morning_prayer_family", displayName: "晨更家族服事" }
      ],
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const query = vi.fn<FunctionHandler>().mockResolvedValue({ ok: true, replyText: "資恆" });
    const handler = createPendingResolutionTextMessageHandler({
      sessionStore: sessions,
      functions: { query_schedule: query }
    });
    const context = {
      profile: {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text" as const],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_schedule" as const]
      },
      event: {
        type: "message" as const,
        source: { type: "group" as const, groupId: "G1", userId: "U1" },
        message: { type: "text" as const, text: "影視團隊服事" }
      },
      requestId: "answer-1"
    };

    await expect(handler.handle({ text: "影視團隊服事" }, context)).resolves.toMatchObject({
      replyText: "資恆",
      executedAction: "query_schedule"
    });
    expect(query).toHaveBeenCalledWith(
      { query: "", specificDate: "2026-07-21", domainKey: "media_team_service" },
      expect.objectContaining({ requestId: "answer-1" })
    );
  });

  it("revalidates the capability before resuming a stored resolver choice", async () => {
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "resolution-disabled",
      type: "pending_resolution",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      capability: "query_schedule",
      groundedArguments: { query: "", specificDate: "2026-07-21" },
      candidates: [{ id: "media", domainKey: "media_team_service", displayName: "影視團隊服事" }],
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const query = vi.fn<FunctionHandler>();
    const handler = createPendingResolutionTextMessageHandler({
      sessionStore: sessions,
      functions: { query_schedule: query }
    });
    const context = {
      profile: {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text" as const],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: []
      },
      event: {
        type: "message" as const,
        source: { type: "user" as const, userId: "U1" },
        message: { type: "text" as const, text: "影視團隊服事" }
      },
      requestId: "answer-disabled"
    };

    await expect(handler.handle({ text: "影視團隊服事" }, context)).resolves.toMatchObject({
      ok: true,
      replyText: messages.functionNotConfigured
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a one-based numeric reply for the displayed choices", async () => {
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "resolution-number",
      type: "pending_resolution",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "group", groupId: "G1", userId: "U1" },
      capability: "query_schedule",
      groundedArguments: { query: "" },
      candidates: [
        { id: "media", domainKey: "media_team_service", displayName: "影視團隊服事" },
        { id: "family", domainKey: "morning_prayer_family", displayName: "晨更家族服事" }
      ],
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const query = vi.fn<FunctionHandler>().mockResolvedValue({ ok: true, replyText: "已選擇" });
    const handler = createPendingResolutionTextMessageHandler({
      sessionStore: sessions,
      functions: { query_schedule: query }
    });
    const context = {
      profile: {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text" as const],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_schedule" as const]
      },
      event: {
        type: "message" as const,
        source: { type: "group" as const, groupId: "G1", userId: "U1" },
        message: { type: "text" as const, text: "2" }
      },
      requestId: "answer-number"
    };

    await expect(handler.handle({ text: "2" }, context)).resolves.toMatchObject({
      replyText: "已選擇",
      executedAction: "query_schedule"
    });
    expect(query).toHaveBeenCalledWith(
      { query: "", domainKey: "morning_prayer_family" },
      expect.any(Object)
    );
  });
});
