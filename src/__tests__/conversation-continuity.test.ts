import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, FakeToolCallingModel, ToolMessage, type BaseMessage } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentJobStore, buildAgentJobScope } from "../agent/jobs.js";
import { createHelperRuntime } from "../helper-agent/runtime.js";
import { conversationStateReply } from "../helper-agent/conversation-tools.js";
import { createHelperAgentState } from "../helper-agent/state.js";
import type { QuoteContext } from "../quotes/types.js";
import type { AppConfig, BotProfileConfig, FunctionRegistry, LineSource } from "../types.js";
import { createTestApp } from "../testing/create-test-app.js";
import { InMemoryAccessStore } from "../access/memory-access-store.js";
import { signLineBody } from "../line-signature.js";

const source: LineSource = { type: "group", groupId: "synthetic-group", userId: "synthetic-user" };
const profile: BotProfileConfig = {
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
  enabledFunctions: ["query_schedule", "find_ppt_slides"],
  permissionRequiredFunctions: [],
  agent: { personaPrompt: "Synthetic policy", memoryPolicyPrompt: "Synthetic context only" }
};
const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `synthetic-${name}`, type: "tool_call" }]
  });

function fixture(outputs: AIMessage[], handlers: FunctionRegistry = {}) {
  const model = new FakeToolCallingModel({ toolCalls: [[]] });
  vi.spyOn(model, "bindTools").mockReturnValue(model);
  let index = 0;
  const inputs: BaseMessage[][] = [];
  const generate = vi.spyOn(model, "_generate").mockImplementation(async (messages) => {
    inputs.push([...messages]);
    const message = outputs[index++];
    if (!message) throw new Error("unexpected synthetic model request");
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  });
  const checkpointer = new MemorySaver();
  const state = createHelperAgentState({ checkpointer, hmacKey: "synthetic-continuity" });
  const jobs = new InMemoryAgentJobStore();
  const runtime = createHelperRuntime({ model, summaryModel: model, state, handlers, jobs });
  const isCurrent = vi.fn(async () => true);
  const threadId = state.threadId({ profileName: "helper", source })!;
  let sequence = 0;
  const turn = (text: string) => {
    const id = `turn-${++sequence}`;
    const quoteContext: QuoteContext = {
      token: {
        threadId,
        generation: "synthetic-generation",
        chatKey: "synthetic-chat",
        sourceKeys: [],
        eventTimestamp: Date.now(),
        turnId: id
      },
      isCurrent
    };
    return {
      profile,
      event: { type: "message", source, message: { type: "text", text } },
      requestId: id,
      quoteContext
    };
  };
  const history = async () =>
    (await checkpointer.getTuple({ configurable: { thread_id: threadId } }))?.checkpoint
      .channel_values.messages as BaseMessage[] | undefined;
  return { runtime, state, jobs, checkpointer, model, generate, inputs, turn, history, isCurrent };
}

describe("conversation continuity across real runtime boundaries", () => {
  it("accepts a same-requester supplement before the first LINE reply while ignoring another member", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const texts: string[] = [];
    const config: AppConfig = {
      serviceName: "synthetic",
      host: "127.0.0.1",
      port: 3000,
      timeZone: "Asia/Taipei",
      healthPath: "/healthz",
      maxBodyBytes: 32768,
      profiles: [{ ...profile, generalAgent: { enabled: true, conversationWindowSeconds: 60 } }],
      llm: {
        deepseekBaseUrl: "https://api.invalid",
        deepseekModel: "synthetic",
        deepseekTimeoutMs: 8000
      }
    };
    const app = createTestApp(config, {
      accessStore: new InMemoryAccessStore({
        principals: [
          {
            id: "synthetic",
            profileName: "helper",
            type: "group",
            principalId: "synthetic-group",
            createdAt: new Date().toISOString(),
            createdBy: "synthetic"
          }
        ]
      }),
      profileRuntime: {
        async handleTextTurn(input) {
          texts.push(input.event.message!.text!);
          await waiting;
          return { ok: true, replyText: "synthetic complete", resultAuthority: { kind: "public" } };
        }
      },
      createLineIdentityClient: () => ({
        getUserDisplayName: async () => "synthetic",
        getGroupDisplayName: async () => "synthetic"
      }),
      createLineReplyClient: () => ({ replyText: async () => undefined })
    });
    let sequence = 0;
    const send = (text: string, userId = "synthetic-user") => {
      const id = `synthetic-${++sequence}`;
      const payload = JSON.stringify({
        destination: "synthetic",
        events: [
          {
            type: "message",
            replyToken: id,
            webhookEventId: id,
            timestamp: Date.now(),
            source: { ...source, userId },
            message: { type: "text", text, id }
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
    try {
      const first = send("小哈，幫我查服事表").then((response) => response);
      await vi.waitFor(() => expect(texts).toHaveLength(1));
      const second = send("小哈，下週兒主的").then((response) => response);
      await vi.waitFor(() => expect(texts).toHaveLength(2));
      const other = await send("我在跟別人說話", "synthetic-other");
      expect(other.json()).toMatchObject({ ignored: true, reason: "wake_word_missing" });
      release();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect(texts).toEqual(["小哈，幫我查服事表", "小哈，下週兒主的"]);
    } finally {
      release();
      await app.close();
    }
  });

  it("preserves text, button result and next text in one context generation", async () => {
    const app = fixture([new AIMessage("了解"), new AIMessage("接續處理")]);
    const first = app.turn("請先保留這個合成需求 ALPHA_MARKER");
    await app.runtime.handleTextTurn(first);
    const button = { ...app.turn(""), event: { type: "postback", source } };
    await app.runtime.recordExternalResult!(button, {
      ok: true,
      executedAction: "query_schedule",
      replyText: "BUTTON_RESULT_MARKER",
      agentResult: {
        status: "success",
        replyData: { kind: "schedule", fields: { description: "BUTTON_RESULT_MARKER" } }
      }
    });
    await app.runtime.handleTextTurn(app.turn("接著處理"));
    const content = JSON.stringify(await app.history());
    expect(content).toContain("ALPHA_MARKER");
    expect(content).toContain("BUTTON_RESULT_MARKER");
  });

  it("checkpoints the visible authoritative selection instead of a different model answer", async () => {
    const app = fixture(
      [
        toolCall("find_presentation", { query: "synthetic" }),
        new AIMessage("錯誤模型清單：合成丙")
      ],
      {
        find_ppt_slides: async () => ({
          ok: true,
          replyText: "1. 合成甲\n2. 合成乙",
          quickReplies: [
            { label: "合成乙", action: { type: "message", label: "合成乙", text: "2" } }
          ],
          agentResult: {
            status: "success",
            replyData: { kind: "presentations", fields: { description: "合成甲、合成乙" } }
          }
        })
      }
    );
    const turn = app.turn("找 synthetic 投影片");
    const result = await app.runtime.handleTextTurn(turn);
    expect(result?.replyText).toBe("1. 合成甲\n2. 合成乙");
    expect((await app.history())?.at(-1)?.text).toContain("2. 合成乙");
    expect((await app.history())?.at(-1)?.text).not.toContain("合成丙");
    expect(result?.contextReference).toEqual({
      capability: "find_ppt_slides",
      arguments: { query: "synthetic" }
    });
    await app.runtime.recordDeliveredReply!({
      scope: { profileName: "helper", source },
      quoteContext: turn.quoteContext,
      messages: [{ id: "accepted", text: "1. 合成甲\n2. 合成乙\nhttps://synthetic.invalid/link" }]
    });
    const delivered = (await app.history())!.filter(
      (message) => message.id === `line-delivery:${turn.quoteContext.token.turnId}`
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.additional_kwargs.line_delivery).toBe("confirmed");
    expect(delivered[0]?.text).toContain("2. 合成乙");
    expect(delivered[0]?.text).not.toContain("https://");
    expect(delivered[0]?.text).not.toContain("尚未確認送達");
  });

  it("does not accept an invented official answer without a current read", async () => {
    const lookup = vi.fn();
    const app = fixture([new AIMessage("這週服事人員是合成甲。")], { query_schedule: lookup });
    const result = await app.runtime.handleTextTurn(app.turn("查本週服事表"));
    expect(lookup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, writePreparation: "needs_input" });
    expect(result?.replyText).not.toContain("合成甲");
    expect((await app.history())?.at(-1)?.text).not.toContain("合成甲");
  });

  it("does not invent completion when the model skips the current-state tool", async () => {
    const app = fixture([new AIMessage("30 張照片都已完成了。")]);
    const result = await app.runtime.handleTextTurn(app.turn("照片好了嗎"));
    expect(result?.ok).toBe(false);
    expect(result?.replyText).not.toContain("30 張照片都已完成");
  });

  it("does not publish a lookup locator containing a URL", async () => {
    const app = fixture(
      [
        toolCall("find_presentation", { query: "https://synthetic.invalid/private" }),
        new AIMessage("沒有更多")
      ],
      {
        find_ppt_slides: async () => ({
          ok: true,
          replyText: "合成結果",
          agentResult: {
            status: "success",
            replyData: { kind: "presentations", fields: { description: "合成結果" } }
          }
        })
      }
    );
    const result = await app.runtime.handleTextTurn(app.turn("找投影片"));
    expect(result?.contextReference).toBeUndefined();
  });

  it("keeps ordinary conversation available without a data tool", async () => {
    const app = fixture([new AIMessage("聽起來今天很累，先休息一下。")]);
    expect(await app.runtime.handleTextTurn(app.turn("今天覺得很累"))).toMatchObject({
      ok: true,
      replyText: "聽起來今天很累，先休息一下。"
    });
  });

  it("requires a fresh read for current-state follow-up and retires previous tool evidence", async () => {
    const app = fixture(
      [
        toolCall("get_official_schedule", { query: "本週服事表" }),
        new AIMessage("合成甲負責。"),
        new AIMessage("現在仍是合成甲。")
      ],
      {
        query_schedule: async () => ({
          ok: true,
          replyText: "合成甲負責。",
          agentResult: {
            status: "success",
            replyData: { kind: "schedule", fields: { description: "OLD_EVIDENCE_MARKER" } }
          }
        })
      }
    );
    await app.runtime.handleTextTurn(app.turn("查本週服事表"));
    const result = await app.runtime.handleTextTurn(app.turn("那現在還是他嗎？"));
    expect(result?.ok).toBe(false);
    expect(result?.replyText).not.toContain("合成甲");
    const oldTools = app.inputs.at(-1)?.filter(ToolMessage.isInstance);
    expect(oldTools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(oldTools)).not.toContain("OLD_EVIDENCE_MARKER");
  });

  it("rechecks a public group lookup under the new requester instead of treating the old answer as current", async () => {
    const lookup = vi.fn(async () => ({
      ok: true,
      replyText: "目前是合成乙。",
      agentResult: {
        status: "success" as const,
        replyData: { kind: "schedule", fields: { description: "目前是合成乙" } }
      }
    }));
    const app = fixture([new AIMessage("目前是合成乙。")], { query_schedule: lookup });
    const turn = app.turn("現在呢？");
    turn.quoteContext.quoted = {
      status: "resolved",
      author: "bot",
      kind: "public_lookup",
      text: "群組公開查詢",
      lookup: { capability: "query_schedule", arguments: { query: "本週服事表" } }
    };
    expect(await app.runtime.handleTextTurn(turn)).toMatchObject({
      ok: true,
      replyText: "目前是合成乙。"
    });
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ query: "本週服事表" }),
      expect.objectContaining({ event: expect.objectContaining({ source }) })
    );
  });

  it("does not run or reveal a quoted capability unavailable to this requester", async () => {
    const lookup = vi.fn();
    const app = fixture([], { query_schedule: lookup });
    const turn = { ...app.turn("繼續"), profile: { ...profile, enabledFunctions: [] } };
    turn.quoteContext.quoted = {
      status: "resolved",
      author: "bot",
      kind: "public_lookup",
      text: "old",
      lookup: { capability: "query_schedule", arguments: { query: "synthetic" } }
    };
    expect((await app.runtime.handleTextTurn(turn))?.replyText).toContain("目前無法讀取");
    expect(lookup).not.toHaveBeenCalled();
    expect(app.generate).not.toHaveBeenCalled();
  });

  it("reports an uncertain prior job from scoped state even if the model claims completion", async () => {
    const app = fixture([toolCall("get_conversation_state"), new AIMessage("已全部完成！")]);
    const scope = buildAgentJobScope("helper", source)!;
    const previous = await app.jobs.createPending({ scope, label: "synthetic", ttlMs: 60_000 });
    await app.jobs.fail(previous.id, "execution_uncertain");
    const current = await app.jobs.createPending({ scope, label: "current", ttlMs: 60_000 });
    const result = await app.runtime.handleTextTurn({
      ...app.turn("剛剛處理好了嗎？"),
      operationId: current.id
    });
    expect(result?.replyText).toContain("尚未確認");
    expect(result?.replyText).not.toContain("已全部完成");
  });

  it("keeps the explicitly quoted public list distinct from a fresh reordered list", async () => {
    const lookup = vi.fn(async () => ({
      ok: true,
      replyText: "1. 合成乙\n2. 合成甲",
      agentResult: {
        status: "success" as const,
        replyData: { kind: "schedule", fields: { description: "CURRENT_ORDER: 合成乙、合成甲" } }
      }
    }));
    const app = fixture([new AIMessage("你引用的第二個是合成乙，重新查詢後仍可取得。")], {
      query_schedule: lookup
    });
    const turn = app.turn("第二個現在還有嗎？");
    turn.quoteContext.quoted = {
      status: "resolved",
      author: "bot",
      kind: "public_lookup",
      text: "ORIGINAL_ORDER: 1. 合成甲、2. 合成乙",
      lookup: { capability: "query_schedule", arguments: { query: "合成清單" } }
    };
    await app.runtime.handleTextTurn(turn);
    const input = app.inputs[0]!.map((message) => message.text).join("\n");
    expect(input).toContain("ORIGINAL_ORDER: 1. 合成甲、2. 合成乙");
    expect(input).toContain("CURRENT_ORDER: 合成乙、合成甲");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not endorse a quoted member's factual claim without a current read", async () => {
    const app = fixture([new AIMessage("對，合成甲這週帶敬拜。")]);
    const turn = app.turn("他說的對嗎？");
    turn.quoteContext.quoted = {
      status: "resolved",
      author: "user",
      otherMember: true,
      kind: "message_text",
      text: "本週服事表：合成甲帶敬拜。"
    };
    const result = await app.runtime.handleTextTurn(turn);
    expect(result?.ok).toBe(false);
    expect(result?.replyText).not.toContain("合成甲");
    expect(app.inputs[0]!.map((message) => message.text).join("\n")).toContain(
      '"otherMember":true'
    );
  });

  it("does not report a durably stored failed result as successful completion", async () => {
    const app = fixture([toolCall("get_conversation_state"), new AIMessage("已完成")]);
    const scope = buildAgentJobScope("helper", source)!;
    const previous = await app.jobs.createPending({ scope, label: "synthetic", ttlMs: 60_000 });
    await app.jobs.complete(previous.id, {
      ok: false,
      replyText: "目前無法查詢",
      resultAuthority: { kind: "public" }
    });
    const current = await app.jobs.createPending({ scope, label: "current", ttlMs: 60_000 });
    const result = await app.runtime.handleTextTurn({
      ...app.turn("剛剛處理好了嗎？"),
      operationId: current.id
    });
    expect(result?.replyText).toContain("最近一次任務未完成");
    expect(result?.replyText).not.toContain("任務已完成");
    expect((await app.jobs.get(previous.id, scope))?.status).toBe("completed");
  });

  it("does not confuse a completed preview turn with a saved draft", () => {
    const result = conversationStateReply({
      asOf: new Date().toISOString(),
      draft: { status: "awaiting_confirmation", action: "propose_save_memory" },
      attachment: null,
      task: { status: "completed", createdAt: new Date().toISOString() }
    });
    expect(result.replyText).toContain("尚未保存");
    expect(result.replyText).not.toContain("任務已完成");
  });

  it("does not index another requester's latest job", async () => {
    const jobs = new InMemoryAgentJobStore();
    const scope = buildAgentJobScope("helper", source)!;
    await jobs.createPending({ scope, label: "private", ttlMs: 60_000 });
    expect(await jobs.latest({ ...scope, requesterUserId: "synthetic-other" })).toBeUndefined();
    expect(await jobs.latest({ ...scope, sourceKey: "group:other" })).toBeUndefined();
  });

  it("does not append a late delivery after reset or withdrawal", async () => {
    const app = fixture([new AIMessage("原回覆")]);
    const turn = app.turn("synthetic");
    await app.runtime.handleTextTurn(turn);
    const before = JSON.stringify(await app.history());
    app.isCurrent.mockResolvedValue(false);
    await app.runtime.recordDeliveredReply!({
      scope: { profileName: "helper", source },
      quoteContext: turn.quoteContext,
      messages: [{ id: "late", text: "WITHDRAWN_MARKER" }]
    });
    expect(JSON.stringify(await app.history())).toBe(before);
  });

  it("projects exact media counts and coverage instead of trusting a model completion claim", async () => {
    const app = fixture([toolCall("get_conversation_state"), new AIMessage("30 張都完成了")]);
    const runtime = createHelperRuntime({
      model: app.model,
      summaryModel: app.model,
      state: app.state,
      handlers: {},
      jobs: app.jobs,
      readMediaState: async () => ({
        state: "active",
        from: "2026-10-17T00:00:00.000Z",
        until: "2026-10-17T00:15:00.000Z",
        totalReceived: 5,
        counts: { published: 1, processing: 2, cancelled: 1, tombstoned: 1 }
      })
    });
    const result = await runtime.handleTextTurn(app.turn("剛剛同步好了嗎？"));
    expect(result?.replyText).toContain("收到 5 筆");
    expect(result?.replyText).toContain("已發布 1 筆");
    expect(result?.replyText).toContain("處理中 2 筆");
    expect(result?.replyText).toContain("已取消 1 筆；已撤回 1 筆");
    expect(result?.replyText).toContain("2026-10-17T00:00:00.000Z");
    expect(result?.replyText).not.toContain("30 張都完成");
  });
});
