import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { createMainRuntime } from "../runtime/main-runtime.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type { BotProfileConfig, FunctionHandler, LineEvent } from "../types.js";

const source = { type: "user" as const, userId: "U1" };
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

function input(text: string) {
  const event: LineEvent = { type: "message", source, message: { type: "text", text } };
  return {
    profile,
    event,
    requestId: "request-1",
    configuredFunctions: [...profile.enabledFunctions],
    authorizeFunctions: vi.fn(async () => ["update_own_profile" as const])
  };
}

describe("main runtime", () => {
  it("serves only its two provider-free capabilities", async () => {
    const weekly = vi.fn<FunctionHandler>(async () => ({
      ok: true,
      replyText: "週報",
      executedAction: "download_weekly_paper"
    }));
    const update = vi.fn<FunctionHandler>();
    const querySchedule = vi.fn<FunctionHandler>();
    const runtime = createMainRuntime({
      handlers: {
        download_weekly_paper: weekly,
        update_own_profile: update,
        query_schedule: querySchedule
      },
      sessions: new InMemorySessionStore(),
      jobs: new InMemoryAgentJobStore()
    });

    await expect(runtime.handleTextTurn(input("下載週報"))).resolves.toMatchObject({
      ok: true,
      executedAction: "download_weekly_paper"
    });
    await expect(runtime.handleTextTurn(input("查服事表"))).resolves.toMatchObject({
      ok: true
    });
    expect(weekly).toHaveBeenCalledOnce();
    expect(querySchedule).not.toHaveBeenCalled();
  });

  it("collects name slots before creating a reviewed update", async () => {
    const sessions = new InMemorySessionStore();
    const jobs = new InMemoryAgentJobStore();
    const weekly = vi.fn<FunctionHandler>(async () => ({
      ok: true,
      replyText: "週報",
      executedAction: "download_weekly_paper"
    }));
    const update = vi.fn<FunctionHandler>(async (args) => ({
      ok: true,
      replyText:
        args.confirm === true
          ? `姓名已更新：${String(args.firstName)} ${String(args.lastName)}`
          : `請確認要更新姓名：\n姓名：${String(args.firstName)} ${String(args.lastName)}`,
      writePhase: args.confirm === true ? "commit" : "preview"
    }));
    const runtime = createMainRuntime({
      handlers: { download_weekly_paper: weekly, update_own_profile: update },
      sessions,
      jobs,
      idFactory: () => "review-1"
    });

    await expect(runtime.handleTextTurn(input("修改姓名"))).resolves.toMatchObject({
      replyText: expect.stringContaining("名字")
    });
    await expect(runtime.handleTextTurn(input("家睿"))).resolves.toMatchObject({
      replyText: expect.stringContaining("姓氏")
    });
    await expect(runtime.handleTextTurn(input("王"))).resolves.toMatchObject({
      writePhase: "preview",
      replyText: expect.stringContaining("家睿 王")
    });
    const review = await sessions.findActionReview({
      profileName: "main",
      source,
      requesterUserId: source.userId
    });
    expect(review).toMatchObject({
      id: "review-1",
      toolName: "update_own_profile",
      argumentsHash: expect.any(String)
    });
    expect(JSON.stringify(review)).not.toContain("家睿");
    if (!review) throw new Error("missing review");
    await expect(
      runtime.handleActionReview?.({
        ...input("確認"),
        reviewId: review.id,
        resultJobId: review.resultJobId,
        text: "確認"
      })
    ).resolves.toMatchObject({
      result: { writePhase: "commit", replyText: "姓名已更新：家睿 王" },
      freshExecution: true
    });
    expect(update).toHaveBeenLastCalledWith(
      { firstName: "家睿", lastName: "王", confirm: true },
      expect.objectContaining({ agentTool: true, requestId: "review-1" })
    );
  });

  it("abandons a stale profile review when the user explicitly requests Weekly Paper", async () => {
    const sessions = new InMemorySessionStore();
    const jobs = new InMemoryAgentJobStore();
    const update = vi.fn<FunctionHandler>(async (args) => ({
      ok: true,
      replyText: args.confirm === true ? "updated" : "preview",
      writePhase: args.confirm === true ? "commit" : "preview"
    }));
    const weekly = vi.fn<FunctionHandler>(async () => ({
      ok: true,
      replyText: "最新週報",
      executedAction: "download_weekly_paper"
    }));
    const runtime = createMainRuntime({
      handlers: { download_weekly_paper: weekly, update_own_profile: update },
      sessions,
      jobs,
      idFactory: () => "stale-review"
    });

    await runtime.handleTextTurn(input("修改姓名"));
    await runtime.handleTextTurn(input("家睿"));
    await runtime.handleTextTurn(input("王"));
    const review = await sessions.findActionReview({
      profileName: "main",
      source,
      requesterUserId: source.userId
    });
    if (!review?.threadId) throw new Error("missing linked review");

    await expect(runtime.handleTextTurn(input("下載最新週報"))).resolves.toMatchObject({
      replyText: "最新週報"
    });
    await expect(
      sessions.findActionReview({
        profileName: "main",
        source,
        requesterUserId: source.userId
      })
    ).resolves.toBeUndefined();
    await expect(sessions.get(review.threadId)).resolves.toBeUndefined();
    await expect(runtime.handleTextTurn(input("確認"))).resolves.toMatchObject({
      replyText: "目前不支援這個請求。"
    });
    expect(weekly).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });
});
