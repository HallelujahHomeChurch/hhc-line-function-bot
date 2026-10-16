import { describe, expect, it, vi } from "vitest";
import { memberBulletinFixture } from "../testing/member-bulletin-fixture.js";
import { createAccountAdminClient } from "../account/account-admin-client.js";
import {
  completedBulletinButton,
  createBulletinContinuationHandler,
  findBulletinContinuation,
  startBulletinBinding
} from "../account/bulletin-continuation.js";
import { InMemorySessionStore } from "../state/session-store.js";
import { createTestApp } from "../testing/create-test-app.js";
import { createTestFunctionRegistries } from "../testing/create-test-function-registries.js";
import { createMainRuntime } from "../runtime/main-runtime.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { signLineBody } from "../line-signature.js";
import type { QuoteStore } from "../quotes/types.js";
import type { AppConfig, LineEvent, LineReplyClient } from "../types.js";
import type { BotProfileConfig, FunctionHandlerContext, PostbackContext } from "../types.js";

const profile: BotProfileConfig = {
  name: "main",
  webhookPath: "/line/main",
  channelSecret: "test",
  channelAccessToken: "test",
  allowDirectUser: true,
  allowRooms: false,
  allowedMessageTypes: ["text"],
  groupRequireWakeWord: false,
  wakeKeywords: [],
  acceptMention: false,
  enabledFunctions: ["download_weekly_paper"],
  permissionRequiredFunctions: [],
  allowedProviders: [],
  allowSubscriptionProviders: false,
  providerPolicy: {},
  schedulePolicy: { meetingReferences: [], domains: [] },
  accountLink: { displayName: "HHC", lineId: "@hhc", providerId: "provider" }
};
const intentId = "01995fd2-6f6c-7b40-8707-6503edc362c8";
const request = { action: "continue_bulletin", params: { intentId } };

function fixture() {
  let now = new Date("2026-10-17T00:00:00Z");
  const sessions = new InMemorySessionStore({ now: () => now });
  const correlation = {
    intentId,
    generation: "3",
    expiresAt: new Date(now.getTime() + 300_000).toISOString()
  };
  const account = createAccountAdminClient({ baseUrl: "http://account.test", timeoutMs: 100 });
  const create = vi.spyOn(account, "createBinding").mockResolvedValue({
    bindingUrl: "https://account.alive.org.tw/line/link",
    expiresAt: correlation.expiresAt,
    correlation
  });
  const inspect = vi
    .spyOn(account, "inspectBinding")
    .mockResolvedValue({ current: true, status: "completed", correlation });
  const resolve = vi
    .spyOn(account, "resolveLineSubject")
    .mockResolvedValue({ bound: true, active: true, subjectId: "current-subject" });
  const current = vi.fn(async () => true);
  const context: FunctionHandlerContext = {
    profile,
    event: {
      type: "message",
      source: { type: "user", userId: "U1" },
      message: { type: "text", text: "下載第1733期週報" }
    },
    channelId: "channel-1",
    quoteContext: {
      token: {
        threadId: "thread",
        generation: "9",
        chatKey: "chat",
        sourceKeys: ["message-1"],
        eventTimestamp: now.getTime()
      },
      isCurrent: current
    }
  };
  const postback: PostbackContext = { ...context, isContextCurrent: current };
  const fetchImpl = vi.fn<typeof fetch>(async (url) => memberBulletinFixture(url));
  const handler = createBulletinContinuationHandler({ account, sessions, fetchImpl });
  const start = () =>
    startBulletinBinding(
      { issueNumber: 1733, arbitraryReturnURL: "https://evil.test" },
      context,
      account,
      sessions,
      now
    );
  return {
    sessions,
    correlation,
    account,
    create,
    inspect,
    resolve,
    current,
    context,
    postback,
    fetchImpl,
    handler,
    start,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    }
  };
}

describe("exact LINE bulletin continuation", () => {
  it("preserves explicit content language and series across login", async () => {
    const f = fixture();
    await startBulletinBinding(
      { issueNumber: 1733, series: "children", locale: "en" },
      f.context,
      f.account,
      f.sessions,
      new Date("2026-10-17T00:00:00Z")
    );
    expect((await findBulletinContinuation(f.sessions, intentId))?.arguments).toEqual({
      issueNumber: 1733,
      series: "children",
      locale: "en"
    });
    f.fetchImpl.mockImplementation(async (url) => {
      const response = memberBulletinFixture(url);
      const body = await response.json();
      if (String(url).includes("member-access"))
        body.data.editions = [{ series: "children", locale: "en" }];
      else
        body.data.items = [
          {
            issueNumber: 1733,
            series: "children",
            contentLocale: "en",
            pdfPublished: false,
            onlineRevision: 1
          }
        ];
      return Response.json(body);
    });
    const result = await f.handler(request, f.postback);
    const discovery = new URL(String(f.fetchImpl.mock.calls[1]?.[0]));
    expect(discovery.searchParams.get("series")).toBe("children");
    expect(discovery.searchParams.get("locales")).toBe("en");
    expect(discovery.searchParams.get("issueNumber")).toBe("1733");
    const action = result.quickReplies?.[0]?.action;
    expect(action?.type === "uri" && action.uri).toContain("contentLocale=en");
  });
  it("wires a signed request, exact completion and explicit continuation through the production registries", async () => {
    const f = fixture();
    const config: AppConfig = {
      serviceName: "hhc-line-function-bot",
      host: "127.0.0.1",
      port: 3000,
      timeZone: "Asia/Taipei",
      healthPath: "/healthz",
      maxBodyBytes: 32768,
      profiles: [{ ...profile, directAccessPolicy: "public", groupAccessPolicy: "blocked" }]
    };
    vi.spyOn(f.account, "authorizeFunctions").mockResolvedValue({
      bound: false,
      active: false,
      administrator: false,
      allowedFunctions: []
    });
    vi.spyOn(f.account, "finalizeBinding").mockResolvedValue({
      status: "completed",
      correlation: f.correlation
    });
    f.resolve.mockResolvedValueOnce({ bound: false, active: false });
    const registries = createTestFunctionRegistries(config, {
      accountAdminClient: f.account,
      sessionStore: f.sessions,
      fetchImpl: f.fetchImpl,
      now: () => new Date("2026-10-17T00:00:00Z")
    });
    const token = f.context.quoteContext!.token;
    const quoteStore: QuoteStore = {
      begin: vi.fn(async () => ({ token, clearCheckpoint: false })),
      isCurrent: f.current,
      inspect: vi.fn(async () => ({ bot: false })),
      recordReply: vi.fn(),
      acknowledgeClear: vi.fn(),
      reset: vi.fn(),
      unsend: vi.fn(async () => [])
    };
    const jobs = new InMemoryAgentJobStore();
    const completeJob = vi.spyOn(jobs, "complete");
    const replyText = vi.fn<LineReplyClient["replyText"]>().mockResolvedValue(undefined);
    const app = createTestApp(config, {
      accountAdminClient: f.account,
      sessionStore: f.sessions,
      quoteStore,
      postbackHandlers: registries.postbacks,
      agentJobStore: jobs,
      profileRuntime: createMainRuntime({
        handlers: registries.functions,
        sessions: f.sessions,
        jobs
      }),
      createLineReplyClient: () => ({ replyText }),
      createLineIdentityClient: () => ({
        getUserDisplayName: vi.fn(async () => "User"),
        getGroupDisplayName: vi.fn(async () => "Group")
      })
    });
    const send = async (event: LineEvent) => {
      const body = JSON.stringify({ destination: "channel-1", events: [event] });
      return app.inject({
        method: "POST",
        url: "/line/main",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signLineBody(body, "test")
        },
        payload: body
      });
    };
    try {
      expect(
        (
          await send({
            ...f.context.event,
            webhookEventId: "request-event",
            replyToken: "request-reply"
          })
        ).statusCode
      ).toBe(200);
      expect(replyText.mock.calls[0]?.[2]?.quickReplies).toHaveLength(2);
      expect(completeJob).toHaveBeenCalledOnce();
      expect(JSON.stringify(completeJob.mock.calls)).not.toContain("https://account.alive.org.tw");
      expect(completeJob.mock.calls[0]?.[1]?.replyText).toContain("重新提出需求");
      expect(await findBulletinContinuation(f.sessions, intentId)).toBeDefined();
      expect(
        (
          await send({
            type: "message",
            source: { type: "user", userId: "U1" },
            webhookEventId: "complete-event",
            replyToken: "complete-reply",
            message: { type: "text", text: `HHC_ACCOUNT_LINK_V1:${"A".repeat(43)}` }
          })
        ).statusCode
      ).toBe(200);
      expect(replyText.mock.calls[1]?.[2]?.quickReplies).toEqual([
        expect.objectContaining({ label: "繼續查看" })
      ]);
      const button = replyText.mock.calls[1]?.[2]?.quickReplies?.[0]?.action;
      if (button?.type !== "postback") throw new Error("missing continuation");
      expect(
        (
          await send({
            type: "postback",
            source: { type: "user", userId: "U1" },
            webhookEventId: "continue-event",
            replyToken: "continue-reply",
            postback: { data: button.data }
          })
        ).statusCode
      ).toBe(200);
      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
      expect(replyText.mock.calls[2]?.[1]).toContain("1733");
    } finally {
      await app.close();
    }
  });
  it("stores only selectors and consumes a completed current intent once", async () => {
    const f = fixture();
    expect((await f.start()).quickReplies).toHaveLength(2);
    expect(await findBulletinContinuation(f.sessions, intentId)).toMatchObject({
      arguments: { issueNumber: 1733 },
      correlation: f.correlation,
      channelId: "channel-1"
    });
    expect((await findBulletinContinuation(f.sessions, intentId))?.arguments).not.toHaveProperty(
      "arbitraryReturnURL"
    );
    const results = await Promise.all([
      f.handler(request, f.postback),
      f.handler(request, f.postback)
    ]);
    expect(results.filter((result) => result.agentResult?.status === "success")).toHaveLength(1);
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl.mock.calls[1]?.[0]).toContain("issueNumber=1733");
    expect(f.inspect).toHaveBeenCalledWith({
      correlation: f.correlation,
      expectedLineUserId: "U1",
      profileName: "main",
      channelId: "channel-1"
    });
  });
  it.each(["requester", "channel", "profile", "group"])(
    "rejects another %s without consuming the owner's request",
    async (change) => {
      const f = fixture();
      await f.start();
      const foreign: PostbackContext = {
        ...f.postback,
        event: { ...f.postback.event, source: { ...f.postback.event.source } }
      };
      if (change === "requester") foreign.event.source.userId = "U2";
      if (change === "channel") foreign.channelId = "channel-2";
      if (change === "profile") foreign.profile = { ...profile, name: "helper" };
      if (change === "group") foreign.event.source = { type: "group", groupId: "G1", userId: "U1" };
      expect((await f.handler(request, foreign)).replyText).toContain("失效");
      expect(f.inspect).not.toHaveBeenCalled();
      expect(await findBulletinContinuation(f.sessions, intentId)).toBeDefined();
    }
  );
  it("keeps pending login available without extending its original expiry", async () => {
    const f = fixture();
    await f.start();
    f.inspect.mockResolvedValue({
      current: true,
      status: "awaiting_line",
      correlation: f.correlation
    });
    expect((await f.handler(request, f.postback)).replyText).toContain("先完成");
    expect((await findBulletinContinuation(f.sessions, intentId))?.expiresAt).toBe(
      f.correlation.expiresAt
    );
    f.advance(300_001);
    expect((await f.handler(request, f.postback)).replyText).toContain("失效");
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "superseded", "expired", "failed", "conflict"] as const)(
    "never resumes %s",
    async (status) => {
      const f = fixture();
      await f.start();
      f.inspect.mockResolvedValue({ current: true, status, correlation: f.correlation });
      expect((await f.handler(request, f.postback)).replyText).toContain("失效");
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    }
  );
  it.each(["not current", "generation drift", "reset", "missing context"])(
    "rejects %s",
    async (reason) => {
      const f = fixture();
      await f.start();
      if (reason === "not current")
        f.inspect.mockResolvedValue({
          current: false,
          status: "completed",
          correlation: f.correlation
        });
      if (reason === "generation drift")
        f.inspect.mockResolvedValue({
          current: true,
          status: "completed",
          correlation: { ...f.correlation, generation: "4" }
        });
      if (reason === "reset") f.current.mockResolvedValue(false);
      if (reason === "missing context") f.postback.isContextCurrent = undefined;
      expect((await f.handler(request, f.postback)).replyText).toContain("失效");
      expect(f.resolve).not.toHaveBeenCalled();
    }
  );
  it("offers completion only for the matching intent and original source", async () => {
    const f = fixture();
    await f.start();
    const input = {
      sessions: f.sessions,
      account: f.account,
      correlation: f.correlation,
      profileName: "main",
      lineUserId: "U1",
      channelId: "channel-1",
      isContextCurrent: f.current
    };
    expect(await completedBulletinButton(input)).toMatchObject({ label: "繼續查看" });
    expect(await completedBulletinButton({ ...input, lineUserId: "U2" })).toBeUndefined();
    expect(
      await completedBulletinButton({
        ...input,
        correlation: { ...f.correlation, generation: "2" }
      })
    ).toBeUndefined();
    expect(await findBulletinContinuation(f.sessions, intentId)).toBeDefined();
  });
  it("allows old producer login without promising continuation", async () => {
    const f = fixture();
    f.create.mockResolvedValue({
      bindingUrl: "https://account.alive.org.tw/line/link",
      expiresAt: f.correlation.expiresAt
    });
    expect((await f.start()).quickReplies).toHaveLength(1);
    expect(await findBulletinContinuation(f.sessions, intentId)).toBeUndefined();
  });
  it("compares expiry instants across database timestamp serialization", async () => {
    const f = fixture();
    await f.start();
    f.inspect.mockResolvedValue({
      current: true,
      status: "completed",
      correlation: { ...f.correlation, expiresAt: f.correlation.expiresAt.replace(".000Z", "Z") }
    });
    expect((await f.handler(request, f.postback)).agentResult?.status).toBe("success");
  });
  it("fails closed on authority outage without consuming the request", async () => {
    const f = fixture();
    await f.start();
    f.inspect.mockRejectedValue(new Error("offline"));
    expect((await f.handler(request, f.postback)).replyText).toContain("稍後再試");
    expect(await findBulletinContinuation(f.sessions, intentId)).toBeDefined();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
