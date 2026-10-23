import { describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { createHelperAgentState } from "../helper-agent/state.js";
import { prepareQuoteContext } from "../transport/line/quote-context.js";
import { safeQuoteText } from "../quotes/postgres-store.js";
import type { QuoteStore, QuoteTurn } from "../quotes/types.js";

const scope = { profileName: "helper", source: { type: "user", userId: "synthetic-user" } };
const turn: QuoteTurn = {
  token: {
    threadId: "thread",
    generation: "generation",
    chatKey: "chat",
    sourceKeys: [],
    eventTimestamp: Date.now()
  },
  clearCheckpoint: false
};
function fakeStore(): QuoteStore {
  return {
    inspect: vi.fn(async () => ({ bot: true })),
    begin: vi.fn(async () => turn),
    recordReply: vi.fn(async () => undefined),
    isCurrent: vi.fn(async () => true),
    reset: vi.fn(async () => undefined),
    unsend: vi.fn(async () => []),
    acknowledgeClear: vi.fn(async () => undefined)
  };
}
describe("quote context boundary", () => {
  it("defers request text until a generation-bound admission succeeds", async () => {
    const store = fakeStore();
    const event = {
      type: "message",
      source: scope.source,
      timestamp: Date.now(),
      message: {
        id: "synthetic-request",
        type: "text",
        text: "合成追問",
        quotedMessageId: "synthetic-reference"
      }
    };
    const prepared = await prepareQuoteContext({
      store,
      scope,
      event,
      deferRequest: true,
      runtime: { handleTextTurn: async () => undefined },
      line: { replyText: async () => undefined }
    });
    expect(store.begin).toHaveBeenCalledWith(
      expect.objectContaining({ deferRequest: true, text: undefined })
    );
    expect(await prepared!.context.admitRequest!()).toBe(true);
    expect(store.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "合成追問", expectedGeneration: "generation" })
    );
  });

  it("does not admit an invalidated candidate", async () => {
    const store = fakeStore();
    const prepared = await prepareQuoteContext({
      store,
      scope,
      deferRequest: true,
      event: {
        type: "message",
        source: scope.source,
        timestamp: Date.now(),
        message: { type: "text", text: "合成追問" }
      },
      runtime: { handleTextTurn: async () => undefined },
      line: { replyText: async () => undefined }
    });
    vi.mocked(store.isCurrent).mockResolvedValue(false);
    expect(await prepared!.context.admitRequest!()).toBe(false);
    expect(store.begin).toHaveBeenCalledOnce();
  });

  it("keeps credentials, URLs and commands out of retained text", () => {
    for (const text of [
      "https://example.test/private",
      "/confirm test",
      "token=synthetic",
      "密碼：synthetic",
      "Bearer synthetic"
    ])
      expect(safeQuoteText(text)).toBeNull();
    expect(safeQuoteText("請查下週服事\n表")).toBe("請查下週服事 表");
    expect(safeQuoteText("a".repeat(2000))).toHaveLength(1000);
  });
  it("never retries an accepted reply when indexing fails", async () => {
    const store = fakeStore();
    vi.mocked(store.recordReply).mockRejectedValue(new Error("db unavailable"));
    const replyText = vi.fn(async () => ({
      sentMessages: [
        { id: "reply-one", text: "result" },
        { id: "reply-two", text: "part two" }
      ]
    }));
    const prepared = await prepareQuoteContext({
      store,
      scope,
      runtime: { handleTextTurn: async () => undefined },
      event: {
        type: "message",
        source: scope.source,
        timestamp: Date.now(),
        message: { type: "text", text: "request" }
      },
      line: { replyText }
    });
    await prepared!.line.replyText("synthetic", "result");
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(store.recordReply).toHaveBeenCalledWith(
      turn,
      [
        { id: "reply-one", text: "result" },
        { id: "reply-two", text: "part two" }
      ],
      { kind: "conversation" }
    );
    vi.mocked(store.isCurrent).mockResolvedValue(false);
    await prepared!.line.replyText("synthetic", "stale");
    expect(replyText).toHaveBeenCalledTimes(1);
  });
  it("does not delay an accepted waiting reply behind the running agent checkpoint lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordDeliveredReply = vi.fn(async () => gate);
    const replyText = vi.fn(async () => ({ sentMessages: [{ id: "waiting", text: "處理中" }] }));
    const prepared = await prepareQuoteContext({
      store: fakeStore(),
      scope,
      runtime: { handleTextTurn: async () => undefined, recordDeliveredReply },
      event: {
        type: "message",
        source: scope.source,
        timestamp: Date.now(),
        message: { type: "text", text: "查詢" }
      },
      line: { replyText }
    });
    try {
      const outcome = await Promise.race([
        prepared!.line.replyText("synthetic", "處理中").then(() => "accepted"),
        new Promise<string>((resolve) => setImmediate(() => resolve("blocked")))
      ]);
      expect(outcome).toBe("accepted");
      expect(recordDeliveredReply).toHaveBeenCalledTimes(1);
      expect(replyText).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it("persists reset before clearing and does not acknowledge a failed clear", async () => {
    const order: string[] = [];
    const store = fakeStore();
    vi.mocked(store.reset).mockImplementation(async () => {
      order.push("reset");
    });
    vi.mocked(store.begin).mockImplementation(async () => {
      order.push("begin");
      return { ...turn, clearCheckpoint: true };
    });
    await expect(
      prepareQuoteContext({
        store,
        scope,
        runtime: {
          handleTextTurn: async () => undefined,
          clearContext: async () => {
            order.push("clear");
            throw new Error("unavailable");
          }
        },
        event: {
          type: "message",
          source: scope.source,
          timestamp: Date.now(),
          message: { type: "text", text: "/reset" }
        },
        line: { replyText: async () => undefined }
      })
    ).rejects.toThrow("unavailable");
    expect(order).toEqual(["reset", "begin", "clear"]);
    expect(store.acknowledgeClear).not.toHaveBeenCalled();
  });
  it("removes a checkpoint written by an invalidated in-flight task and skips stale queued work", async () => {
    const checkpointer = new MemorySaver();
    const deleted = vi.spyOn(checkpointer, "deleteThread");
    const state = createHelperAgentState({ checkpointer, hmacKey: "synthetic-key-for-test" });
    let current = true;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      threadId: "thread",
      source: scope.source,
      policyKey: "read",
      isCurrent: async () => current
    };
    const running = state.run({
      ...input,
      task: async () => {
        entered();
        await gate;
        return "old";
      }
    });
    await started;
    current = false;
    release();
    await expect(running).rejects.toThrow("context_invalidated");
    expect(deleted).toHaveBeenCalledTimes(1);
    const task = vi.fn();
    await expect(state.run({ ...input, task })).rejects.toThrow("context_invalidated");
    expect(task).not.toHaveBeenCalled();
    expect(deleted).toHaveBeenCalledTimes(1);
  });
});
