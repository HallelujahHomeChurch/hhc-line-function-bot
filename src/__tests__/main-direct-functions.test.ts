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
  schedulePolicy: { meetingWindows: [], domains: [] }
};

describe("main provider-free direct functions", () => {
  it("handles Weekly Paper without the semantic agent router", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          issueNumber: 1733,
          locale: "zh-Hant",
          issueDate: "2026-09-01",
          title: "週報",
          subtitle: "",
          downloadUrl: "/assets/0123456789abcdef0123456789abcdef?filename=1733-weekly.pdf",
          downloadFileName: "1733-weekly.pdf",
          publishedAt: "2026-09-01T00:00:00.000Z",
          version: 1
        },
        error: null,
        meta: {}
      })
    );
    const handler = createDownloadWeeklyPaperTextMessageHandler(fetchImpl);

    expect(await handler.matches({ text: "下載第 1733 期週報" }, { profile, event })).toBe(true);
    const weeklyPaperReply = await handler.handle(
      { text: "下載第 1733 期週報" },
      { profile, event, requestId: "weekly" }
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(weeklyPaperReply.ok).toBe(true);
    expect(weeklyPaperReply).toMatchObject({
      executedAction: "download_weekly_paper",
      quickReplies: [expect.objectContaining({ label: "下載週報" })]
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
