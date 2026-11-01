import { InMemorySessionStore } from "../state/session-store.js";
import type { LineReplyOptions } from "../types.js";
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
  const sessions = new InMemorySessionStore();
  const createJob = vi.spyOn(jobs, "createPending");
  const runtime = createHelperRuntime({
    model,
    summaryModel: model,
    state,
    handlers: options.handlers ?? {},
    sessions,
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
  const replyOptions: Array<LineReplyOptions | undefined> = [];
  const app = createTestApp(config, {
    quoteStore: store,
    sessionStore: sessions,
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
      replyText: async (_token, text, options) => {
        replyOptions.push(options);
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
  const click = (data: string, userId = source.userId) => {
    const payload = JSON.stringify({
      events: [
        {
          type: "postback",
          timestamp: Date.now(),
          webhookEventId: `synthetic-click-${++sequence}`,
          replyToken: `reply-${sequence}`,
          source: { ...source, userId },
          postback: { data }
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
    replyOptions,
    click,
    store,
    generate,
    bind,
    inputs,
    history,
    jobs,
    sessions,
    createJob,
    recordTurn,
    windows,
    advance: (ms: number) => {
      clock += ms;
    },
    config
  };
}

describe("explicit helper group admission", () => {
  it.each([true, false])("ignores ambient text with active=%s", async (active) => {
    const f = await fixture([], { active });
    try {
      for (const text of [
        "阿明，明天你幾點到？",
        "小哈今天又亂回",
        "你問小哈看看",
        "下週",
        "1",
        "確認",
        "取消",
        "使用說明",
        "忘記這段對話"
      ]) {
        await f.send(text, { quote: false });
        await f.send(text);
      }
      expect(f.replies).toEqual([]);
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.createJob).not.toHaveBeenCalled();
      expect(f.recordTurn).not.toHaveBeenCalled();
      expect(f.store.begin).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it("preserves requester context across ignored chatter and explicit resumption", async () => {
    const f = await fixture([new AIMessage("PRIOR_REPLY"), new AIMessage("接續原本內容")]);
    try {
      await f.send("小哈，先記住 PRIOR_REQUEST", { quote: false });
      await f.send("IGNORED_MEMBER_CHAT");
      await f.send("小哈，繼續", { quote: false });
      expect(f.replies).toEqual(["PRIOR_REPLY", "接續原本內容"]);
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.inputs.at(-1))).toContain("PRIOR_REQUEST");
      expect(JSON.stringify(f.inputs.at(-1))).not.toContain("IGNORED_MEMBER_CHAT");
    } finally {
      await f.app.close();
    }
  });

  it.each(["小哈，幫我找資料", "小哈，昨天討論什麼？"])(
    "accepts explicit invocation %s",
    async (text) => {
      const f = await fixture([new AIMessage("合成回覆")]);
      try {
        await f.send(text, { quote: false });
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.replies).toHaveLength(1);
      } finally {
        await f.app.close();
      }
    }
  );

  it.each(["確認", "取消"])("a known Bot quote never approves %s", async (text) => {
    const f = await fixture([], { knownBot: true });
    try {
      await f.send(text);
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.replies[0]).toContain("引用訊息不會確認或取消操作");
    } finally {
      await f.app.close();
    }
  });

  it("preserves safe known Bot quote admission", async () => {
    const f = await fixture([new AIMessage("合成回覆")], { knownBot: true });
    try {
      await f.send("繼續");
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.replies).toEqual(["合成回覆"]);
    } finally {
      await f.app.close();
    }
  });

  it("keeps the slow-operation result button for an explicit request", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      [
        async () => {
          await pending;
          return new AIMessage("合成結果");
        }
      ],
      { inlineTimeout: 10 }
    );
    try {
      await f.send("小哈，繼續處理", { quote: false });
      expect(f.replies[0]).toContain("查看結果");
      release();
      await vi.waitFor(async () =>
        expect((await f.jobs.latest(buildAgentJobScope("helper", source)!))?.status).toBe(
          "completed"
        )
      );
    } finally {
      release();
      await f.app.close();
    }
  });
});

describe("group follow-up experience", () => {
  it("accepts a bounded greeting before the Bot name", async () => {
    const f = await fixture([new AIMessage("你好")]);
    try {
      await f.send("Hi 小哈", { quote: false });
      expect(f.replies).toEqual(["我是小哈，家教會的小幫手。"]);
      expect(f.generate).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it.each([
    "小哈 可以做什麼",
    "小哈 你能夠做什麼",
    "小哈，你能做什麼？",
    "小哈可以幹嘛",
    "小哈可以做什麼"
  ])("renders the deterministic capability menu for %s", async (text) => {
    const f = await fixture([]);
    try {
      await f.send(text, { quote: false });
      expect(f.replies[0]).toContain("查服事表");
      expect(f.generate).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("resets an explicitly addressed conversation without calling the model", async () => {
    const f = await fixture([new AIMessage("先前答案"), new AIMessage("不應呼叫")]);
    try {
      await f.send("小哈，記住 SYNTHETIC_PRIOR", { quote: false });
      await f.send("小哈，忘記這段對話", { quote: false });
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.replies.at(-1)).toContain("已清除");
      expect(f.store.reset).toHaveBeenCalledOnce();
    } finally {
      await f.app.close();
    }
  });
});

it("gives a free-text group question an explicit continuation instruction without admitting bare replies", async () => {
  const f = await fixture([new AIMessage("你想查哪一天？"), new AIMessage("已接續")], {
    knownBot: true
  });
  try {
    await f.send("小哈，幫我查資料", { quote: false });
    expect(f.replies[0]).toContain("請引用回覆這則訊息");
    await f.send("明天", { quote: false });
    expect(f.generate).toHaveBeenCalledTimes(1);
    await f.send("明天");
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.replies.at(-1)).toBe("已接續");
  } finally {
    await f.app.close();
  }
});

it("completes a capability-menu journey with an owner-only one-shot button", async () => {
  const f = await fixture([new AIMessage("需要哪一天？")]);
  try {
    await f.send("小哈 你能夠做什麼", { quote: false });
    expect(f.generate).not.toHaveBeenCalled();
    const action = f.replyOptions[0]?.quickReplies?.find(
      (item) => item.label === "查服事表"
    )?.action;
    expect(action?.type).toBe("postback");
    if (action?.type !== "postback") throw new Error("missing scoped menu action");
    await f.click(action.data, "other-requester");
    expect(f.generate).not.toHaveBeenCalled();
    await f.click(action.data);
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.replies.at(-1)).toContain("引用回覆");
    await f.click(action.data);
    expect(f.generate).toHaveBeenCalledOnce();
    await f.send("阿明，明天你幾點到？", { quote: false });
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.replies).toHaveLength(2);
  } finally {
    await f.app.close();
  }
});
it.each(["Hi 大家，小哈今天又亂回", "Hi 小哈今天又亂回", "你問小哈看看", "阿明，明天你幾點到？"])(
  "does not expand greeting admission to %s",
  async (text) => {
    const f = await fixture([]);
    try {
      await f.send(text, { quote: false });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.replies).toEqual([]);
      expect(f.createJob).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  }
);

it("keeps bare retired research choices silent without waking the model", async () => {
  const f = await fixture([], { active: true, knownBot: false });
  try {
    await f.send("上網找", { quote: false });
    await f.send("保存", { quote: false });
    await f.send("上網找", { quote: false, userId: "other" });
    expect(f.replies).toEqual([]);
    expect(f.generate).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});
