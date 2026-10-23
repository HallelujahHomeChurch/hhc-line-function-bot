import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, FakeToolCallingModel, type BaseMessage } from "langchain";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { InMemoryConversationWindowStore } from "../agent/context-manager.js";
import { buildAgentJobScope, InMemoryAgentJobStore } from "../agent/jobs.js";
import { createHelperRuntime } from "../helper-agent/runtime.js";
import { createHelperAgentState } from "../helper-agent/state.js";
import { signLineBody } from "../line-signature.js";
import type { QuotedText, QuoteStore } from "../quotes/types.js";
import { createTestApp } from "../testing/create-test-app.js";
import type { AppConfig, FunctionRegistry } from "../types.js";

const source = { type: "group", groupId: "synthetic-group", userId: "synthetic-user" };
const scope = {
  profileName: "helper",
  sourceKey: "group:synthetic-group",
  requesterUserId: source.userId
};
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `synthetic-${name}`, type: "tool_call" }]
  });
const decision = (value: "engage" | "ignore") =>
  call("decide_quoted_continuation", { decision: value });

async function fixture(
  outputs: Array<AIMessage | (() => Promise<AIMessage>)>,
  options: {
    quoted?: QuotedText;
    knownBot?: boolean;
    active?: boolean;
    handlers?: FunctionRegistry;
    inlineTimeout?: number;
  } = {}
) {
  const config: AppConfig = {
    serviceName: "synthetic",
    host: "127.0.0.1",
    port: 3000,
    timeZone: "Asia/Taipei",
    healthPath: "/healthz",
    maxBodyBytes: 32768,
    profiles: [
      {
        name: "helper",
        webhookPath: "/api/line/webhook/helper",
        channelSecret: "synthetic",
        channelAccessToken: "synthetic",
        allowDirectUser: true,
        allowRooms: false,
        directAccessPolicy: "managed",
        groupAccessPolicy: "managed",
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_schedule"],
        permissionRequiredFunctions: [],
        agent: { personaPrompt: "Synthetic policy", memoryPolicyPrompt: "Synthetic context only" },
        generalAgent: { enabled: true, conversationWindowSeconds: 60 },
        longRunningJobs: {
          enabled: true,
          inlineReplyTimeoutMs: options.inlineTimeout ?? 4000,
          resultTtlMinutes: 30
        }
      }
    ],
    llm: {
      deepseekBaseUrl: "https://api.invalid",
      deepseekModel: "synthetic",
      deepseekTimeoutMs: 8000
    }
  };
  let clock = Date.now();
  const windows = new InMemoryConversationWindowStore({ now: () => new Date(clock) });
  if (options.active !== false)
    await windows.recordTurn({ scope, role: "assistant", text: "[reply]", ttlMs: 60000 });
  const recordTurn = vi.spyOn(windows, "recordTurn");
  const model = new FakeToolCallingModel({ toolCalls: [[]] });
  const bind = vi.spyOn(model, "bindTools").mockReturnValue(model);
  let index = 0;
  const inputs: BaseMessage[][] = [];
  const generate = vi.spyOn(model, "_generate").mockImplementation(async (messages) => {
    inputs.push([...messages]);
    const output = outputs[index++];
    if (!output) throw new Error("unexpected synthetic model request");
    const message = typeof output === "function" ? await output() : output;
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  });
  const checkpointer = new MemorySaver();
  const state = createHelperAgentState({ checkpointer, hmacKey: "synthetic-continuation" });
  const jobs = new InMemoryAgentJobStore();
  const createJob = vi.spyOn(jobs, "createPending");
  const runtime = createHelperRuntime({
    model,
    summaryModel: model,
    state,
    handlers: options.handlers ?? {},
    jobs
  });
  const store: QuoteStore = {
    inspect: vi.fn(async () => ({ bot: options.knownBot ?? false })),
    begin: vi.fn(async (input) => ({
      token: {
        threadId: "synthetic-thread",
        generation: "synthetic-generation",
        chatKey: "synthetic-chat",
        sourceKeys: [],
        eventTimestamp: input.timestamp!,
        turnId: input.messageId
      },
      clearCheckpoint: false,
      requestText: input.text,
      ...(input.quotedMessageId
        ? { quoted: options.quoted ?? { status: "unavailable" as const } }
        : {})
    })),
    recordReply: vi.fn(async () => undefined),
    isCurrent: vi.fn(async () => true),
    acknowledgeClear: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    unsend: vi.fn(async () => [])
  };
  const replies: string[] = [];
  const app = createTestApp(config, {
    quoteStore: store,
    profileRuntime: runtime,
    conversationWindowStore: windows,
    agentJobStore: jobs,
    accessStore: new InMemoryAccessStore({
      principals: [
        {
          id: "synthetic",
          profileName: "helper",
          type: "group",
          principalId: source.groupId,
          createdAt: new Date().toISOString(),
          createdBy: "synthetic"
        }
      ]
    }),
    createLineIdentityClient: () => ({
      getUserDisplayName: async () => undefined,
      getGroupDisplayName: async () => undefined
    }),
    createLineReplyClient: () => ({
      replyText: async (_token, text) => {
        replies.push(text);
        return { sentMessages: [{ id: `synthetic-reply-${replies.length}`, text }] };
      }
    })
  });
  let sequence = 0;
  const send = (text: string, opts: { quote?: boolean; userId?: string } = {}) => {
    const id = `synthetic-event-${++sequence}`;
    const payload = JSON.stringify({
      events: [
        {
          type: "message",
          timestamp: Date.now(),
          webhookEventId: id,
          replyToken: id,
          source: { ...source, userId: opts.userId ?? source.userId },
          message: {
            type: "text",
            text,
            id,
            ...(opts.quote !== false ? { quotedMessageId: "synthetic-quote" } : {})
          }
        }
      ]
    });
    return app.inject({
      method: "POST",
      url: "/api/line/webhook/helper",
      headers: {
        "content-type": "application/json",
        "x-line-signature": signLineBody(Buffer.from(payload), "synthetic")
      },
      payload
    });
  };
  const history = async () =>
    (
      await checkpointer.getTuple({
        configurable: { thread_id: state.threadId({ profileName: "helper", source })! }
      })
    )?.checkpoint.channel_values.messages as BaseMessage[] | undefined;
  return {
    app,
    send,
    replies,
    store,
    generate,
    bind,
    inputs,
    history,
    jobs,
    createJob,
    recordTurn,
    windows,
    advance: (ms: number) => {
      clock += ms;
    },
    config
  };
}

describe("quoted helper group continuations", () => {
  it("silently ignores member chatter without retaining it or extending the window", async () => {
    const f = await fixture([decision("ignore")]);
    try {
      expect((await f.send("CHATTER_MARKER 哈哈對啊")).statusCode).toBe(200);
      expect(f.replies).toEqual([]);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.recordTurn).not.toHaveBeenCalled();
      expect(f.createJob).not.toHaveBeenCalled();
      expect(f.store.begin).toHaveBeenCalledWith(expect.objectContaining({ text: undefined }));
      expect(f.store.begin).toHaveBeenCalledOnce();
      expect(JSON.stringify(await f.history())).not.toContain("CHATTER_MARKER");
      f.advance(60001);
      await f.send("另一段群聊");
      expect(f.generate).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it.each([false, true])(
    "continues an answer to the Bot using a safe member quote (otherMember=%s)",
    async (otherMember) => {
      const f = await fixture(
        [
          new AIMessage("請問要整理哪一段？"),
          decision("engage"),
          new AIMessage("這段的合成摘要。")
        ],
        {
          active: false,
          quoted: {
            status: "resolved",
            author: "user",
            kind: "message_text",
            text: "SYNTHETIC_MEMBER_CONTENT",
            ...(otherMember ? { otherMember: true as const } : {})
          }
        }
      );
      try {
        await f.send("小哈，幫我整理一段文字", { quote: false });
        await f.send("這段");
        expect(f.replies).toEqual(["請問要整理哪一段？", "這段的合成摘要。"]);
        expect(JSON.stringify(f.inputs[1])).toContain("請問要整理哪一段？");
        expect(JSON.stringify(f.inputs[2])).toContain("SYNTHETIC_MEMBER_CONTENT");
        expect(f.store.begin).toHaveBeenCalledWith(
          expect.objectContaining({ text: "這段", expectedGeneration: "synthetic-generation" })
        );
        const names = (index: number) => f.bind.mock.calls[index]![0].map((entry) => entry.name);
        expect(names(1)).toEqual(["decide_quoted_continuation"]);
        expect(names(2)).toContain("get_conversation_state");
        expect(names(2)).not.toContain("decide_quoted_continuation");
      } finally {
        await f.app.close();
      }
    }
  );

  it("uses fresh authorized tools when the new request is sufficient despite an unavailable quote", async () => {
    const lookup = vi.fn(async () => ({
      ok: true,
      replyText: "本次合成服事表",
      agentResult: {
        status: "success" as const,
        replyData: { kind: "schedule" as const, fields: { description: "合成服事表" } }
      }
    }));
    const f = await fixture(
      [
        decision("engage"),
        call("get_official_schedule", { query: "下週服事表" }),
        new AIMessage("本次合成服事表")
      ],
      { handlers: { query_schedule: lookup } }
    );
    try {
      await f.send("幫我查下週服事表");
      expect(f.replies).toEqual(["本次合成服事表"]);
      expect(lookup).toHaveBeenCalledOnce();
      expect(f.createJob).toHaveBeenCalledBefore(lookup);
      expect(f.store.begin).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.inputs.at(-1))).toContain("引用內容不可取得");
    } finally {
      await f.app.close();
    }
  });

  it.each(["unavailable", "other_requester"] as const)(
    "asks only for missing content after engaging an unreadable quote (%s)",
    async (status) => {
      const f = await fixture([decision("engage"), new AIMessage("請把要我整理的內容貼上來。")], {
        quoted: { status }
      });
      try {
        await f.send("這段也幫我整理");
        expect(f.replies).toEqual(["請把要我整理的內容貼上來。"]);
        expect(f.replies.join()).not.toContain("原發話者");
      } finally {
        await f.app.close();
      }
    }
  );

  it.each([
    { name: "explicit wake", text: "小哈，這段幫我整理", active: false, knownBot: false },
    { name: "known Bot quote", text: "繼續處理", active: false, knownBot: true }
  ])("keeps $name on the normal reply path", async ({ text, active, knownBot }) => {
    const f = await fixture([new AIMessage("請把內容貼上來。")], { active, knownBot });
    try {
      await f.send(text);
      expect(f.replies).toEqual(["請把內容貼上來。"]);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.bind.mock.calls[0]![0].map((entry) => entry.name)).not.toContain(
        "decide_quoted_continuation"
      );
    } finally {
      await f.app.close();
    }
  });

  it("does not wake on member quotes outside the requester's continuation window", async () => {
    const f = await fixture([], { active: false });
    try {
      await f.send("這段我也覺得可以");
      expect(f.replies).toEqual([]);
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.store.begin).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it("does not inherit another requester's active continuation", async () => {
    const f = await fixture([]);
    try {
      await f.send("這段", { userId: "synthetic-other" });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.replies).toEqual([]);
    } finally {
      await f.app.close();
    }
  });

  it.each([
    new AIMessage("UNAPPROVED_REPLY_MARKER"),
    call("decide_quoted_continuation", { decision: "engage", extra: true }),
    call("get_official_schedule", { query: "合成" }),
    new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "decide_quoted_continuation",
          args: { decision: "engage" },
          id: "synthetic-a",
          type: "tool_call"
        },
        {
          name: "get_official_schedule",
          args: { query: "合成" },
          id: "synthetic-b",
          type: "tool_call"
        }
      ]
    })
  ])(
    "fails closed before tools or replies when the admission decision is invalid (%#)",
    async (output) => {
      const lookup = vi.fn();
      const f = await fixture([output], { handlers: { query_schedule: lookup } });
      try {
        await f.send("INVALID_TURN_MARKER");
        expect(f.replies).toEqual([]);
        expect(lookup).not.toHaveBeenCalled();
        expect(f.createJob).not.toHaveBeenCalled();
        expect(JSON.stringify(await f.history())).not.toContain("INVALID_TURN_MARKER");
      } finally {
        await f.app.close();
      }
    }
  );

  it("does not show provider errors or retain ignored text before admission", async () => {
    const f = await fixture([
      async () => {
        throw new Error("synthetic provider failure");
      }
    ]);
    try {
      await f.send("FAILED_CANDIDATE_MARKER");
      expect(f.replies).toEqual([]);
      expect(f.recordTurn).not.toHaveBeenCalled();
      expect(f.createJob).not.toHaveBeenCalled();
      expect(JSON.stringify(await f.history())).not.toContain("FAILED_CANDIDATE_MARKER");
    } finally {
      await f.app.close();
    }
  });

  it("stays silent when the quote generation cannot be admitted", async () => {
    const f = await fixture([decision("engage")]);
    const begin = vi.mocked(f.store.begin);
    const prepare = begin.getMockImplementation()!;
    begin.mockImplementation(async (input) =>
      input.expectedGeneration ? undefined : prepare(input)
    );
    try {
      await f.send("幫我處理這段");
      expect(f.replies).toEqual([]);
      expect(f.recordTurn).not.toHaveBeenCalled();
      expect(f.createJob).not.toHaveBeenCalled();
      expect(f.generate).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });

  it.each(["確認", "取消"])(
    "does not turn a member's quoted %s into approval or an unsolicited reply",
    async (text) => {
      const f = await fixture([]);
      try {
        await f.send(text);
        expect(f.replies).toEqual([]);
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.recordTurn).not.toHaveBeenCalled();
        expect(f.createJob).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    }
  );

  it("preserves the prior requester context after ignoring a quote", async () => {
    const f = await fixture([
      new AIMessage("PRIOR_REPLY_MARKER"),
      decision("ignore"),
      new AIMessage("接續原本內容")
    ]);
    try {
      await f.send("小哈，先記住這段對話的 PRIOR_REQUEST_MARKER", { quote: false });
      await f.send("IGNORED_MEMBER_CHAT_MARKER");
      await f.send("繼續", { quote: false });
      expect(f.replies).toEqual(["PRIOR_REPLY_MARKER", "接續原本內容"]);
      expect(JSON.stringify(f.inputs.at(-1))).toContain("PRIOR_REQUEST_MARKER");
      expect(JSON.stringify(f.inputs.at(-1))).not.toContain("IGNORED_MEMBER_CHAT_MARKER");
    } finally {
      await f.app.close();
    }
  });

  it("suppresses the slow-operation handoff while the admission decision is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      [
        async () => {
          await pending;
          return decision("ignore");
        }
      ],
      { inlineTimeout: 10 }
    );
    try {
      const response = f.send("這段是群友聊天").then((result) => result);
      await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(f.replies).toEqual([]);
      expect(f.createJob).not.toHaveBeenCalled();
      release();
      expect((await response).statusCode).toBe(200);
      expect(f.replies).toEqual([]);
    } finally {
      release();
      await f.app.close();
    }
  });

  it("preserves the slow-operation result button after an accepted continuation", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      [
        decision("engage"),
        async () => {
          await pending;
          return new AIMessage("合成結果");
        }
      ],
      { inlineTimeout: 10 }
    );
    try {
      expect((await f.send("繼續處理這段")).statusCode).toBe(200);
      expect(f.replies).toHaveLength(1);
      expect(f.replies[0]).toContain("查看結果");
      release();
      const scope = buildAgentJobScope("helper", source)!;
      await vi.waitFor(async () => expect((await f.jobs.latest(scope))?.status).toBe("completed"));
      expect((await f.jobs.latest(scope))?.result?.replyText).toBe("合成結果");
    } finally {
      release();
      await f.app.close();
    }
  });
});
