import { describe, expect, it, vi } from "vitest";

import { createDownloadWeeklyPaperTextMessageHandler } from "../capabilities/download-weekly-paper.js";
import { createUpdateOwnProfileHandler } from "../capabilities/update-own-profile/handler.js";
import type { BotProfileConfig, LineEvent } from "../types.js";

const userId = `U${"a".repeat(32)}`;
const event: LineEvent = {
  type: "message",
  source: { type: "user", userId },
  message: { type: "text", text: "" }
};
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
  enabledFunctions: ["download_weekly_paper", "update_own_profile"],
  permissionRequiredFunctions: ["update_own_profile"],
  allowedProviders: [],
  allowSubscriptionProviders: false,
  providerPolicy: {},
  schedulePolicy: { meetingReferences: [], domains: [] }
};

describe("main provider-free direct functions", () => {
  it.each(["下載最新週報", "下載第 1733 期週報"])(
    "blocks %s for an unbound LINE user",
    async (text) => {
      const fetchImpl = vi.fn();
      const handler = createDownloadWeeklyPaperTextMessageHandler(fetchImpl, {
        resolveLineSubject: vi.fn().mockResolvedValue({ bound: false, active: false })
      });
      const result = await handler.handle({ text }, { profile, event, requestId: "disabled" });
      expect(result.replyText).toBe("請先輸入「登入」連結 HHC 帳號，再查看會員週報。");
      expect(result.quickReplies).toBeUndefined();
      expect(result.agentResult).toMatchObject({ status: "unavailable" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("handles Weekly Paper without the semantic agent router", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          items: [{ issueNumber: 1733, locale: "zh-Hant" }]
        },
        error: null,
        meta: {}
      })
    );
    const handler = createDownloadWeeklyPaperTextMessageHandler(fetchImpl, {
      resolveLineSubject: vi.fn().mockResolvedValue({
        bound: true,
        active: true,
        subjectId: "018f0c1f-18d0-7e81-9f6f-69c456db7003"
      })
    });

    expect(await handler.matches({ text: "下載第 1733 期週報" }, { profile, event })).toBe(true);
    const weeklyPaperReply = await handler.handle(
      { text: "下載第 1733 期週報" },
      { profile, event, requestId: "weekly" }
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(weeklyPaperReply.ok).toBe(true);
    expect(weeklyPaperReply).toMatchObject({
      executedAction: "download_weekly_paper",
      quickReplies: [expect.objectContaining({ label: "查看會員週報" })]
    });
  });

  it("keeps own-profile updates in preview until the caller confirms", async () => {
    const handler = createUpdateOwnProfileHandler({
      accountClient: { updateOwnProfile: vi.fn() } as never
    });

    const profilePreview = await handler(
      { firstName: "家睿", lastName: "王" },
      { profile, event, requestId: "profile-preview" }
    );

    expect(profilePreview.writePhase).toBe("preview");
  });
});
