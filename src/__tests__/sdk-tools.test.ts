import { describe, expect, it, vi } from "vitest";

import { createSdkFunctionTools } from "../agent/sdk-tools.js";
import type { BotProfileConfig, FunctionHandlerContext, FunctionRegistry } from "../types.js";

function context(
  source: FunctionHandlerContext["event"]["source"] = {
    type: "user",
    userId: "U1"
  }
): FunctionHandlerContext {
  return {
    profile: profile(),
    event: {
      type: "message",
      source,
      message: { type: "text", text: "查服事表" }
    }
  };
}

function profile(): BotProfileConfig {
  return {
    name: "helper",
    webhookPath: "/api/line/webhook/helper",
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: true,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["query_schedule"],
    permissionRequiredFunctions: [],
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    controlledAgent: { maxCandidates: 3, minPlannerConfidence: 0.65 },
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function profileWith(enabledFunctions: BotProfileConfig["enabledFunctions"]): BotProfileConfig {
  return { ...profile(), enabledFunctions };
}

describe("SDK function tools", () => {
  it("exposes only configured, enabled functions", () => {
    const registry: FunctionRegistry = {
      query_schedule: vi.fn(),
      save_memory: vi.fn()
    };

    const tools = createSdkFunctionTools({
      context: context(),
      functionRegistry: registry
    });

    expect(tools.map(({ name }) => name)).toEqual(["query_schedule"]);
  });

  it("does not create group tools without a requester identity", () => {
    const tools = createSdkFunctionTools({
      context: context({ type: "group", groupId: "G1" }),
      functionRegistry: { query_schedule: vi.fn() }
    });

    expect(tools).toEqual([]);
  });

  it("rechecks live authorization before calling a handler", async () => {
    const handler = vi.fn();
    const [querySchedule] = createSdkFunctionTools({
      authorize: async () => false,
      context: context(),
      functionRegistry: { query_schedule: handler }
    });

    await expect(querySchedule?.invoke({ query: "2026-09-06" })).resolves.toEqual({
      status: "denied",
      reason: "authorization_changed"
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps raw handler replies out of checkpointed tool output", async () => {
    const onResult = vi.fn();
    const result = {
      ok: true,
      replyText: "https://temporary.example.test/private",
      writePhase: "preview" as const
    };
    const [querySchedule] = createSdkFunctionTools({
      context: context(),
      functionRegistry: { query_schedule: vi.fn(async () => result) },
      onResult
    });

    await expect(querySchedule?.invoke({ query: "2026-09-06" })).resolves.toEqual({
      status: "success",
      writePhase: "preview"
    });
    expect(onResult).toHaveBeenCalledWith("query_schedule", result);
  });

  it("rejects model-only confirmation fields through the function schema", async () => {
    const handler = vi.fn();
    const [querySchedule] = createSdkFunctionTools({
      context: context(),
      functionRegistry: { query_schedule: handler }
    });

    await expect(querySchedule?.invoke({ query: "2026-09-06", confirm: true })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("never exposes confirmation as a model-controlled write argument", async () => {
    const saveMemory = vi.fn(async () => ({
      ok: true,
      replyText: "preview",
      writePhase: "preview" as const
    }));
    const toolContext = context();
    toolContext.profile = profileWith(["save_memory"]);
    const [writeTool] = createSdkFunctionTools({
      context: toolContext,
      functionRegistry: { save_memory: saveMemory }
    });

    await expect(writeTool?.invoke({ content: "待確認資訊", confirm: true })).rejects.toThrow();
    expect(saveMemory).not.toHaveBeenCalled();

    await expect(writeTool?.invoke({ content: "待確認資訊" })).resolves.toEqual({
      status: "success",
      writePhase: "preview"
    });
    expect(saveMemory).toHaveBeenCalledWith(
      { content: "待確認資訊" },
      expect.objectContaining({ agentTool: true })
    );
  });

  it("combines visible memory and knowledge behind one information tool", async () => {
    const queryKnowledge = vi.fn(async () => ({
      ok: true,
      replyText: "knowledge",
      agentResult: {
        status: "success" as const,
        entities: [],
        anchors: {},
        supportedOperations: [],
        reply: { mode: "focused" as const, fields: {} }
      }
    }));
    const retrieveMemory = vi.fn(async () => ({
      ok: true,
      replyText: "memory",
      agentResult: {
        status: "success" as const,
        entities: [],
        anchors: {},
        supportedOperations: [],
        reply: { mode: "focused" as const, fields: {} }
      }
    }));
    const toolContext = context();
    toolContext.profile = profileWith(["query_knowledge", "retrieve_memory"]);

    const tools = createSdkFunctionTools({
      context: toolContext,
      functionRegistry: {
        query_knowledge: queryKnowledge,
        retrieve_memory: retrieveMemory
      }
    });

    expect(tools.map(({ name }) => name)).toEqual(["search_information"]);
    await tools[0]?.invoke({ query: "服事安排" });
    expect(queryKnowledge).toHaveBeenCalledWith(
      { query: "服事安排" },
      expect.objectContaining({ agentTool: true })
    );
    expect(retrieveMemory).toHaveBeenCalledWith(
      { query: "服事安排" },
      expect.objectContaining({ agentTool: true })
    );
  });

  it("passes bounded information evidence to the model", async () => {
    const toolContext = context();
    toolContext.profile = profileWith(["retrieve_memory"]);
    const [searchInformation] = createSdkFunctionTools({
      context: toolContext,
      functionRegistry: {
        retrieve_memory: vi.fn(async () => ({
          ok: true,
          replyText: "raw reply",
          responseData: {
            kind: "memory_evidence",
            fields: {},
            records: [{ sourceKind: "visible_note", excerpt: "待確認服事" }]
          }
        }))
      }
    });

    await expect(searchInformation?.invoke({ query: "服事" })).resolves.toEqual({
      status: "complete",
      results: [
        {
          capability: "retrieve_memory",
          status: "success",
          data: {
            kind: "memory_evidence",
            fields: {},
            records: [{ sourceKind: "visible_note", excerpt: "待確認服事" }]
          }
        }
      ]
    });
  });

  it("combines catalog-backed file lookups behind one typed file tool", async () => {
    const findSlides = vi.fn(async () => ({ ok: true, replyText: "slides" }));
    const findMusic = vi.fn(async () => ({ ok: true, replyText: "music" }));
    const toolContext = context();
    toolContext.profile = profileWith(["find_ppt_slides", "find_sheet_music"]);
    const tools = createSdkFunctionTools({
      context: toolContext,
      functionRegistry: {
        find_ppt_slides: findSlides,
        find_sheet_music: findMusic
      }
    });

    expect(tools.map(({ name }) => name)).toEqual(["search_files"]);
    await tools[0]?.invoke({ query: "奇異恩典", kind: "sheet_music" });
    expect(findMusic).toHaveBeenCalledOnce();
    expect(findSlides).not.toHaveBeenCalled();
  });

  it("never builds SDK tools for the provider-free main profile", () => {
    const toolContext = context();
    toolContext.profile = {
      ...profileWith(["query_schedule"]),
      name: "main",
      allowedProviders: []
    };

    expect(
      createSdkFunctionTools({
        context: toolContext,
        functionRegistry: { query_schedule: vi.fn() }
      })
    ).toEqual([]);
  });

  it("exposes iterative public search and page reading only after consent", async () => {
    const search = vi.fn(async () => [
      {
        title: "Lyrics page",
        snippet: "lyrics only",
        url: "https://public.example.test/lyrics"
      }
    ]);
    const read = vi.fn(async () => ({
      kind: "html" as const,
      text: "This page contains lyrics only.",
      links: [
        {
          title: "Choir score",
          url: "https://public.example.test/score.pdf"
        }
      ]
    }));

    const toolContext = context();
    toolContext.profile = profileWith(["find_sheet_music"]);
    const functionRegistry = { find_sheet_music: vi.fn() };
    expect(
      createSdkFunctionTools({
        context: toolContext,
        externalSheetMusicSearch: { allowed: false, pageReader: { read }, webSearch: { search } },
        functionRegistry
      }).map(({ name }) => name)
    ).not.toContain("search_sheet_music_web");

    const tools = createSdkFunctionTools({
      context: toolContext,
      externalSheetMusicSearch: { allowed: true, pageReader: { read }, webSearch: { search } },
      functionRegistry
    });
    const searchTool = tools.find(({ name }) => name === "search_sheet_music_web");
    const readTool = tools.find(({ name }) => name === "read_sheet_music_page");
    const searchResult = (await searchTool?.invoke({ query: "合成曲目 歌譜" })) as {
      results: Array<{ ref: string; url?: string }>;
    };
    expect(searchResult.results[0]).toEqual(expect.objectContaining({ ref: expect.any(String) }));
    expect(searchResult.results[0]).not.toHaveProperty("url");

    const page = await readTool?.invoke({ ref: searchResult.results[0]!.ref });
    expect(read).toHaveBeenCalledWith("https://public.example.test/lyrics");
    expect(page).toEqual(
      expect.objectContaining({
        kind: "html",
        links: [expect.objectContaining({ ref: expect.any(String) })]
      })
    );
    expect(JSON.stringify(page)).not.toContain("https://");
  });

  it("reauthorizes consented public search before each call", async () => {
    const search = vi.fn();
    const toolContext = context();
    toolContext.profile = profileWith(["find_sheet_music"]);
    const tools = createSdkFunctionTools({
      authorize: async () => false,
      context: toolContext,
      externalSheetMusicSearch: {
        allowed: true,
        pageReader: { read: vi.fn() },
        webSearch: { search }
      },
      functionRegistry: { find_sheet_music: vi.fn() }
    });

    await expect(
      tools.find(({ name }) => name === "search_sheet_music_web")?.invoke({ query: "合唱譜" })
    ).resolves.toEqual({ status: "denied", reason: "authorization_changed" });
    expect(search).not.toHaveBeenCalled();
  });
});
