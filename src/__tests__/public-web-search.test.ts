import { describe, expect, it, vi } from "vitest";
import { createPublicWebSearch, publicCitationUrl } from "../clients/public-web-search.js";
import {
  createPublicSearchHandler,
  createSearchResultReader,
  explicitPublicQuestion
} from "../functions/public-web-search.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import { InMemoryAgentMemoryStore } from "../agent/memory-store.js";
import { createSaveMemoryHandler } from "../functions/agent-memory-functions.js";
import { createPublicSearchQuota } from "../state/public-search-quota.js";
import {
  createEvalProbe,
  createSyntheticRuntimeFixture,
  instrumentedFakeModel
} from "../evals/synthetic-runtime-fixture.js";
import { deliveredContextText, replyProjection } from "../quotes/reply-projection.js";
import type { FunctionHandlerContext } from "../types.js";

const token = {
  threadId: "synthetic",
  generation: "one",
  chatKey: "chat",
  sourceKeys: [],
  eventTimestamp: Date.now()
};
const answer = "公開答案 [1]\n來源：[1] https://example.org/page";
function fixture() {
  let clock = new Date("2026-11-02T00:00:00Z");
  let current = true;
  const now = () => clock;
  const probe = createEvalProbe();
  const app = createSyntheticRuntimeFixture({
    probe,
    model: instrumentedFakeModel([[]], probe),
    enabledFunctions: ["query_public_web", "save_memory"],
    profile: { allowedProviders: ["openai"] },
    now
  });
  const jobs = new InMemoryAgentJobStore({ now });
  const reserve = vi.fn(async () => true);
  const search = vi.fn(async () => ({
    text: answer,
    inputTokens: 100,
    outputTokens: 30,
    searchCalls: 1
  }));
  const deps = { jobs, reserve, search, isCurrent: async () => current, now };
  const context: FunctionHandlerContext = {
    profile: app.profile,
    event: { ...app.turn("公開搜尋：合成公開問題").event, webhookEventId: "event-1" },
    quoteContext: { token, isCurrent: async () => current },
    agentTool: true
  };
  return {
    app,
    context,
    deps,
    handler: createPublicSearchHandler(deps),
    reset: () => {
      current = false;
    },
    expire: () => {
      clock = new Date(clock.getTime() + 600_001);
    }
  };
}

describe("public search outbound boundary", () => {
  it("only accepts a fresh explicit public question, not inferred history or quotations", async () => {
    expect(explicitPublicQuestion("小哈，公開搜尋：台南展覽")).toBe("台南展覽");
    for (const text of [
      "請依照私有筆記搜尋",
      "引用：公開搜尋：秘密",
      "公開搜尋：\n秘密\n第二段",
      "公開搜尋：" + "字".repeat(1000)
    ])
      expect(explicitPublicQuestion(text)).toBeUndefined();
    const f = fixture();
    f.context.event.message!.text = "依照剛才的私人內容找資料";
    expect((await f.handler({ query: "模型衍生的秘密" }, f.context)).ok).toBe(false);
    expect(f.deps.search).not.toHaveBeenCalled();
    expect(f.deps.reserve).not.toHaveBeenCalled();
  });
  it("uses only Responses web_search with strict budgets and visible verified citations", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gpt-6-luna",
        store: false,
        max_output_tokens: 800,
        max_tool_calls: 1,
        parallel_tool_calls: false,
        input: "合成公開問題",
        tools: [{ type: "web_search", search_context_size: "low" }]
      });
      expect(body).not.toHaveProperty("previous_response_id");
      expect(init?.redirect).toBe("error");
      return Response.json({
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed" },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "答案 citation",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.org/page",
                    title: "source",
                    start_index: 3,
                    end_index: 11
                  }
                ]
              }
            ]
          }
        ],
        usage: { input_tokens: 100, output_tokens: 30 }
      });
    });
    const result = await createPublicWebSearch({
      apiKey: "synthetic",
      fetchImpl: fetchImpl as typeof fetch
    })("合成公開問題");
    expect(result.text).toContain("答案 [1]");
    expect(result.text).toContain("[1] https://example.org/page");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1/",
      "https://[::1]/",
      "https://metadata.google.internal/",
      "https://user:password@example.org/"
    ])
      expect(publicCitationUrl(url)).toBe(false);
  });
  it("fails closed on timeout, unsupported model, missing usage or citations without retry", async () => {
    for (const response of [
      new Response("", { status: 400 }),
      Response.json({
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    ]) {
      const fetchImpl = vi.fn(async () => response);
      await expect(
        createPublicWebSearch({ apiKey: "synthetic", fetchImpl })("question")
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("reserves an atomic source/event quota and refuses storage failure", async () => {
    const evalFn = vi.fn(async () => 1);
    const reserve = createPublicSearchQuota({
      client: { eval: evalFn },
      keyPrefix: "test",
      hmacKey: "synthetic",
      settings: async () => ({
        enabled: true,
        directDailyLimit: 60,
        groupDailyLimit: 300,
        revision: 1
      })
    });
    expect(await reserve("helper", { type: "user", userId: "private-user" }, "private-event")).toBe(
      true
    );
    const input = evalFn.mock.calls[0] as unknown as [
      string,
      { keys: string[]; arguments: string[] }
    ];
    expect(input[1].keys).toHaveLength(4);
    expect(input[1].arguments).toEqual(["60"]);
    expect(JSON.stringify(input)).not.toContain("private-user");
    expect(JSON.stringify(input)).not.toContain("private-event");
    evalFn.mockRejectedValueOnce(new Error("offline"));
    expect(await reserve("helper", { type: "user", userId: "u" }, "e")).toBe(false);
  });
});

describe("external result lifecycle", () => {
  it("confirms a selected original through the actual one-shot action executor", async () => {
    const f = fixture();
    const searched = await f.handler({}, f.context);
    const id = searched.externalSearch!.resultId;
    const probe = createEvalProbe();
    const memoryStore = new InMemoryAgentMemoryStore();
    const app = createSyntheticRuntimeFixture({
      probe,
      profile: { allowedProviders: ["openai"] },
      model: instrumentedFakeModel(
        [[{ name: "propose_save_memory", args: { searchResultId: id }, id: "save" }], []],
        probe
      ),
      enabledFunctions: ["query_public_web", "save_memory"],
      handlers: {
        save_memory: createSaveMemoryHandler({
          memoryStore,
          readSearchResult: createSearchResultReader(f.deps)
        })
      }
    });
    const preview = await app.runtime.handleTextTurn(app.turn(`保存搜尋結果 ${id}`));
    expect(preview?.writePhase).toBe("preview");
    const review = await app.sessions.findActionReview({
      profileName: "helper",
      source: app.source,
      requesterUserId: app.source.userId
    });
    expect(review).toBeDefined();
    const approved = await app.runtime.handleActionReview!({
      ...app.turn("確認"),
      reviewId: review!.id,
      resultJobId: review!.resultJobId,
      text: "確認"
    });
    expect(approved?.result.writePhase).toBe("commit");
    const notes = await memoryStore.listTextMemories({ profileName: "helper", source: app.source });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain(answer);
    await app.runtime.handleActionReview!({
      ...app.turn("確認"),
      reviewId: review!.id,
      resultJobId: review!.resultJobId,
      text: "確認"
    });
    expect(
      await memoryStore.listTextMemories({ profileName: "helper", source: app.source })
    ).toHaveLength(1);
  });
  it("keeps raw text outside checkpoint and quote projections, then saves only an explicitly selected scoped result", async () => {
    const f = fixture();
    const result = await f.handler({}, f.context);
    const id = result.externalSearch!.resultId;
    expect(f.deps.search).toHaveBeenCalledWith("合成公開問題");
    expect(JSON.stringify(result.agentResult)).not.toContain("example.org");
    expect(deliveredContextText(result.replyText, replyProjection(result))).not.toContain(
      "公開答案"
    );
    const memoryStore = new InMemoryAgentMemoryStore();
    const save = createSaveMemoryHandler({
      memoryStore,
      readSearchResult: createSearchResultReader(f.deps)
    });
    expect((await save({ searchResultId: id }, f.context)).writePreparation).toBe("denied");
    f.context.event.message!.text = `小哈，保存搜尋結果 ${id}`;
    const preview = await save({ searchResultId: id }, f.context);
    expect(preview.replyText).toContain(answer);
    expect(preview.writePhase).toBe("preview");
    expect(
      await memoryStore.listTextMemories({ profileName: "helper", source: f.context.event.source })
    ).toHaveLength(0);
    const other = {
      ...f.context,
      event: { ...f.context.event, source: { type: "user", userId: "other" } }
    };
    expect(
      (await save({ ...preview.reviewArguments, confirm: true }, other)).writePreparation
    ).toBe("unavailable");
    expect((await save({ ...preview.reviewArguments, confirm: true }, f.context)).writePhase).toBe(
      "commit"
    );
    f.reset();
    expect(
      (await save({ ...preview.reviewArguments, confirm: true }, f.context)).writePreparation
    ).toBe("unavailable");
  });
  it("rejects expired results and never retries an uncertain search", async () => {
    const f = fixture();
    const result = await f.handler({}, f.context);
    f.expire();
    expect(
      await createSearchResultReader(f.deps)(result.externalSearch!.resultId, f.context)
    ).toBeUndefined();
    f.deps.search.mockRejectedValueOnce(new Error("timeout"));
    expect((await f.handler({}, f.context)).ok).toBe(false);
    expect(f.deps.reserve).toHaveBeenCalledTimes(2);
    expect(f.deps.search).toHaveBeenCalledTimes(2);
  });
  it("blocks same-turn writes and excludes the search answer from the real agent checkpoint", async () => {
    const f = fixture();
    const probe = createEvalProbe();
    const write = vi.fn(async () => ({
      ok: true,
      replyText: "must not run",
      writePhase: "preview" as const
    }));
    const app = createSyntheticRuntimeFixture({
      probe,
      model: instrumentedFakeModel(
        [
          [{ name: "search_public_web", args: {}, id: "search" }],
          [{ name: "propose_save_memory", args: { content: "injected" }, id: "write" }],
          []
        ],
        probe
      ),
      enabledFunctions: ["query_public_web", "save_memory"],
      profile: { allowedProviders: ["openai"] },
      handlers: { query_public_web: f.handler, save_memory: write }
    });
    const turn = app.turn("公開搜尋：合成公開問題");
    turn.event.webhookEventId = "event-1";
    const result = await app.runtime.handleTextTurn({
      ...turn,
      quoteContext: f.context.quoteContext
    });
    expect(result?.replyText).toContain(answer);
    expect(write).not.toHaveBeenCalled();
    await app.runtime.handleTextTurn({
      ...app.turn("接著聊其他事情"),
      quoteContext: f.context.quoteContext
    });
    expect(JSON.stringify(probe.inputs)).not.toContain(answer);
  });
});
