import type { CapabilityName } from "../capabilities/names.js";
import { MemorySaver } from "@langchain/langgraph";
import { FakeToolCallingModel, ToolMessage } from "langchain";
import { countTokensApproximately } from "langchain";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAgentTraceStore } from "../agent/trace-store.js";
import { InMemoryAgentJobStore } from "../agent/jobs.js";
import type { ResourceMemoryObserver } from "../agent/resource-memory.js";
import { createFindPopSheetMusicHandler } from "../functions/find-pop-sheet-music.js";
import { createHelperReadTools } from "../helper-agent/read-tools.js";
import {
  createHelperModels,
  createHelperRuntime,
  helperPolicyKey,
  helperSystemPrompt
} from "../helper-agent/runtime.js";
import { createHelperAgentState, type HelperAgentState } from "../helper-agent/state.js";
import { InMemorySessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionHandlerContext,
  FunctionRegistry,
  LineSource
} from "../types.js";

const readFunctions: CapabilityName[] = [
  "query_schedule",
  "find_ppt_slides",
  "find_sheet_music",
  "find_resource",
  "query_knowledge",
  "retrieve_memory",
  "query_wikipedia"
];

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
    enabledFunctions: readFunctions,
    permissionRequiredFunctions: [],
    agent: { personaPrompt: "合成人設", memoryPolicyPrompt: "合成記憶政策" },
    allowedProviders: ["deepseek"],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
}

function input(text: string, source: LineSource = { type: "user", userId: "LINE_USER_ID" }) {
  return {
    profile: profile(),
    event: { type: "message", source, message: { type: "text", text } },
    requestId: "request-1"
  };
}

function handlers(): FunctionRegistry {
  return Object.fromEntries(
    readFunctions.map((name) => [
      name,
      vi.fn(async () => ({
        ok: true,
        replyText: "domain",
        agentResult: {
          status: "success" as const,
          replyText: "domain",
          replyData: { kind: name, fields: { result: "synthetic" } }
        }
      }))
    ])
  );
}

function state(overrides: Partial<HelperAgentState> = {}): HelperAgentState {
  const checkpointer = new MemorySaver();
  return {
    checkpointer,
    threadId: ({ source }) => (source.userId ? `helper-${source.userId}` : undefined),
    run: async ({ task }) => task({ externalSheetMusicAllowed: false }),
    reset: vi.fn(async () => undefined),
    allowExternalSheetMusic: vi.fn(async () => undefined),
    externalSheetMusicAllowed: vi.fn(async () => false),
    ...overrides
  };
}

describe("helper profile runtime", () => {
  it("turns an internal sheet-music miss into requester-approved research mode", async () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    const sessions = new InMemorySessionStore({ now: () => now });
    const helperState = createHelperAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "research-state",
      now: () => now
    });
    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: "find_sheet_music", args: { query: "missing song" }, id: "sheet-1" }],
        [],
        []
      ]
    });
    const bindTools = vi.spyOn(model, "bindTools").mockReturnValue(model);
    const findSheetMusic = createFindPopSheetMusicHandler({
      graph: { listFolderChildren: vi.fn().mockResolvedValue([]), createSharingLink: vi.fn() },
      driveId: "drive-id",
      folderItemId: "folder-id",
      allowedExtensions: [".pdf"],
      externalResearchEnabled: true,
      sessionStore: sessions,
      now: () => now,
      requestIdFactory: () => "consent-1"
    });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: helperState,
      handlers: { find_sheet_music: findSheetMusic },
      sessions,
      webSearch: { search: vi.fn(async () => []) },
      pageReader: { read: vi.fn() },
      now: () => now
    });

    await expect(runtime.handleTextTurn(input("找 missing song 歌譜"))).resolves.toMatchObject({
      agentResult: { status: "not_found" }
    });
    await expect(runtime.acceptSheetMusicResearch?.(input("上網找"))).resolves.toEqual({
      kind: "accepted"
    });
    await runtime.handleTextTurn(input("繼續搜尋"));

    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).toEqual(
      expect.arrayContaining(["search_sheet_music_web", "read_sheet_music_page"])
    );
  });

  it("records only the authoritative helper resource result with validated arguments", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          { name: "find_presentation", args: { query: "青年聚會" }, id: "ppt-1" },
          { name: "find_sheet_music", args: { query: "奇異恩典" }, id: "sheet-1" }
        ],
        []
      ]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const resourceMemory: ResourceMemoryObserver = { afterFunctionResult: vi.fn() };
    const presentation = vi.fn(async () => ({
      ok: true,
      replyText: "投影片完成",
      agentResult: { status: "success" as const, replyText: "投影片完成" },
      agentResource: {
        resourceType: "presentation" as const,
        title: "青年聚會.pptx",
        storage: { provider: "graph" as const, driveId: "drive", itemId: "ppt" }
      }
    }));
    const sheetMusic = vi.fn(async () => ({
      ok: true,
      replyText: "歌譜完成",
      agentResult: { status: "success" as const, replyText: "歌譜完成" },
      agentResource: {
        resourceType: "sheet_music" as const,
        title: "奇異恩典.pdf",
        storage: { provider: "graph" as const, driveId: "drive", itemId: "sheet" }
      }
    }));
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: { find_ppt_slides: presentation, find_sheet_music: sheetMusic },
      resourceMemory
    });

    await runtime.handleTextTurn(input("找青年聚會投影片和奇異恩典歌譜"));

    expect(resourceMemory.afterFunctionResult).toHaveBeenCalledOnce();
    expect(resourceMemory.afterFunctionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "find_sheet_music",
        arguments: { query: "奇異恩典" },
        result: expect.objectContaining({ replyText: "歌譜完成" })
      })
    );
  });

  it("continues a schedule-domain ambiguity through the scoped checkpoint with a fresh tool call", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: "get_official_schedule", args: { query: "查服事表" }, id: "schedule-1" }],
        [],
        [
          {
            name: "get_official_schedule",
            args: { query: "主日服事", domainKey: "sunday_service" },
            id: "schedule-2"
          }
        ],
        []
      ]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const querySchedule = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        replyText: "你要查主日服事還是影音服事？",
        agentResult: {
          status: "ambiguous",
          replyText: "你要查主日服事還是影音服事？",
          clarification: { choices: ["主日服事", "影音服事"] }
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        replyText: "主日服事查詢完成。",
        agentResult: { status: "success", replyText: "主日服事查詢完成。" }
      });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: createHelperAgentState({ checkpointer: new MemorySaver(), hmacKey: "state-key" }),
      handlers: { query_schedule: querySchedule }
    });

    await runtime.handleTextTurn(input("查服事表"));
    await runtime.handleTextTurn(input("主日服事"));

    expect(querySchedule).toHaveBeenNthCalledWith(
      2,
      { query: "主日服事", domainKey: "sunday_service" },
      expect.objectContaining({ agentTool: true })
    );
  });

  it("atomically enables research only for the requester-scoped consent", async () => {
    const sessions = new InMemorySessionStore({
      now: () => new Date("2026-09-04T00:00:00.000Z")
    });
    await sessions.set({
      id: "consent-1",
      type: "external_search_consent",
      action: "sheet_music_external_search",
      profileName: "helper",
      requesterUserId: "LINE_USER_ID",
      source: { type: "group", groupId: "G1", userId: "LINE_USER_ID" },
      query: "奇異恩典",
      expiresAt: "2026-09-04T00:10:00.000Z"
    });
    const helperState = state();
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: helperState,
      handlers: handlers(),
      sessions,
      webSearch: { search: vi.fn() },
      pageReader: { read: vi.fn() },
      now: () => new Date("2026-09-04T00:00:00.000Z")
    });

    await expect(
      runtime.acceptSheetMusicResearch?.(
        input("上網找", { type: "group", groupId: "G1", userId: "OTHER_USER" })
      )
    ).resolves.toBeUndefined();
    await expect(
      runtime.acceptSheetMusicResearch?.(
        input("上網找", { type: "group", groupId: "G1", userId: "LINE_USER_ID" })
      )
    ).resolves.toEqual({ kind: "accepted" });
    await expect(
      runtime.acceptSheetMusicResearch?.(
        input("上網找", { type: "group", groupId: "G1", userId: "LINE_USER_ID" })
      )
    ).resolves.toBeUndefined();
    expect(helperState.allowExternalSheetMusic).toHaveBeenCalledOnce();
    expect(helperState.allowExternalSheetMusic).toHaveBeenCalledWith(
      "helper-LINE_USER_ID",
      { type: "group", groupId: "G1", userId: "LINE_USER_ID" },
      new Date("2026-09-04T00:15:00.000Z")
    );
  });

  it("atomically cancels only the requester's pending external search", async () => {
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "consent-1",
      type: "external_search_consent",
      action: "sheet_music_external_search",
      profileName: "helper",
      requesterUserId: "LINE_USER_ID",
      source: { type: "group", groupId: "G1", userId: "LINE_USER_ID" },
      query: "奇異恩典",
      expiresAt: "2099-09-04T00:10:00.000Z"
    });
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const invoke = vi.spyOn(model, "invoke");
    const webSearch = { search: vi.fn() };
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers(),
      sessions,
      webSearch,
      pageReader: { read: vi.fn() }
    });

    await expect(
      runtime.acceptSheetMusicResearch?.(
        input("不用", { type: "group", groupId: "G1", userId: "OTHER_USER" })
      )
    ).resolves.toBeUndefined();
    await expect(
      runtime.acceptSheetMusicResearch?.(
        input("不用", { type: "group", groupId: "G1", userId: "LINE_USER_ID" })
      )
    ).resolves.toEqual({
      kind: "handled",
      result: { ok: true, replyText: "好，我不做外部搜尋。" }
    });
    await expect(sessions.get("consent-1")).resolves.toBeUndefined();
    await sessions.set({
      id: "consent-2",
      type: "external_search_consent",
      action: "sheet_music_external_search",
      profileName: "helper",
      requesterUserId: "LINE_USER_ID",
      source: { type: "group", groupId: "G1", userId: "LINE_USER_ID" },
      query: "奇異恩典",
      expiresAt: "2099-09-04T00:10:00.000Z"
    });
    await expect(
      runtime.acceptSheetMusicResearch?.(
        input("取消", { type: "group", groupId: "G1", userId: "LINE_USER_ID" })
      )
    ).resolves.toMatchObject({ kind: "handled" });
    await expect(sessions.get("consent-2")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(webSearch.search).not.toHaveBeenCalled();
  });

  it("uses the research budget tool set without model-controlled writes", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const bindTools = vi.spyOn(model, "bindTools").mockReturnValue(model);
    const helperState = state({
      run: async ({ task }) => task({ externalSheetMusicAllowed: true })
    });
    const writeProfile = {
      ...profile(),
      enabledFunctions: [...readFunctions, "save_resource" as const],
      permissionRequiredFunctions: ["save_resource" as const]
    };
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: helperState,
      handlers: { ...handlers(), save_resource: vi.fn() },
      sessions: new InMemorySessionStore(),
      jobs: new InMemoryAgentJobStore(),
      webSearch: { search: vi.fn(async () => []) },
      pageReader: { read: vi.fn() }
    });

    await runtime.handleTextTurn({
      ...input("上網找"),
      profile: writeProfile,
      configuredFunctions: writeProfile.enabledFunctions,
      authorizeFunctions: async (names) => names
    });

    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).toEqual(
      expect.arrayContaining(["search_sheet_music_web", "read_sheet_music_page"])
    );
    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).not.toContain(
      "propose_save_resource"
    );
  });

  it("constructs no research tools when the locked state snapshot has lost consent", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const bindTools = vi.spyOn(model, "bindTools").mockReturnValue(model);
    const webSearch = { search: vi.fn() };
    const helperState = state({
      externalSheetMusicAllowed: vi.fn(async () => true),
      run: async ({ task }) => task({ externalSheetMusicAllowed: false })
    });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: helperState,
      handlers: handlers(),
      sessions: new InMemorySessionStore(),
      webSearch,
      pageReader: { read: vi.fn() }
    });

    await runtime.handleTextTurn(input("繼續找歌譜"));

    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["search_sheet_music_web", "read_sheet_music_page"])
    );
    expect(helperState.externalSheetMusicAllowed).not.toHaveBeenCalled();
    expect(webSearch.search).not.toHaveBeenCalled();
  });

  it.each(["expiry", "reset"] as const)(
    "constructs no research tools after queued consent %s",
    async (loss) => {
      let now = new Date("2026-09-04T00:00:00.000Z");
      const helperState = createHelperAgentState({
        checkpointer: new MemorySaver(),
        hmacKey: "queued-consent",
        now: () => now
      });
      const turnInput = input("繼續找歌譜");
      const threadId = helperState.threadId({
        profileName: turnInput.profile.name,
        source: turnInput.event.source
      });
      if (!threadId) throw new Error("missing thread id");
      await helperState.allowExternalSheetMusic(
        threadId,
        turnInput.event.source,
        new Date("2026-09-04T00:01:00.000Z")
      );
      let release!: () => void;
      let started = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = helperState.run({
        threadId,
        policyKey: helperPolicyKey(turnInput.profile),
        source: turnInput.event.source,
        task: async () => {
          started = true;
          await gate;
        }
      });
      await vi.waitFor(() => expect(started).toBe(true));
      const model = new FakeToolCallingModel({ toolCalls: [[]] });
      const bindTools = vi.spyOn(model, "bindTools").mockReturnValue(model);
      const webSearch = { search: vi.fn() };
      const runtime = createHelperRuntime({
        model,
        summaryModel: model,
        state: helperState,
        handlers: handlers(),
        sessions: new InMemorySessionStore(),
        webSearch,
        pageReader: { read: vi.fn() },
        now: () => now
      });
      const run = vi.spyOn(helperState, "run");
      const reset = loss === "reset" ? helperState.reset(threadId) : Promise.resolve();
      const turn = runtime.handleTextTurn(turnInput);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      if (loss === "expiry") now = new Date("2026-09-04T00:02:00.000Z");

      release();
      await Promise.all([blocker, reset, turn]);

      expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(["search_sheet_music_web", "read_sheet_music_page"])
      );
      expect(webSearch.search).not.toHaveBeenCalled();
    }
  );

  it("does not invoke a model for a group without a requester", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const invoke = vi.spyOn(model, "invoke");
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers()
    });

    await expect(
      runtime.handleTextTurn(input("你好", { type: "group", groupId: "G1" }))
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails closed when checkpoint persistence is unavailable", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const generate = vi.spyOn(model, "_generate");
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state({ run: vi.fn(async () => Promise.reject(new Error("checkpoint unavailable"))) }),
      handlers: handlers()
    });

    await expect(runtime.handleTextTurn(input("你好"))).resolves.toMatchObject({
      ok: false,
      replyText: expect.stringContaining("支援碼")
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("clears a denied write interrupt so the next turn starts without the stale review", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: "propose_save_memory", args: { content: "remember" }, id: "write-1" }],
        []
      ]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const checkpointer = new MemorySaver();
    const helperState = createHelperAgentState({ checkpointer, hmacKey: "state-key" });
    const sessionStore = new InMemorySessionStore();
    const writeProfile = {
      ...profile(),
      enabledFunctions: ["save_memory" as const],
      permissionRequiredFunctions: ["save_memory" as const]
    };
    const saveMemory = vi.fn(async () => ({ ok: true, replyText: "missing preview" }));
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: helperState,
      handlers: { save_memory: saveMemory },
      sessions: sessionStore,
      jobs: new InMemoryAgentJobStore()
    });
    const turn = {
      ...input("記住這件事"),
      profile: writeProfile,
      configuredFunctions: ["save_memory" as const],
      authorizeFunctions: async () => ["save_memory" as const]
    };
    const threadId = helperState.threadId({
      profileName: "helper",
      source: turn.event.source
    });
    if (!threadId) throw new Error("missing thread id");

    await expect(runtime.handleTextTurn(turn)).resolves.toEqual({
      ok: true,
      replyText: "這項操作目前無法建立確認，請重新提出。"
    });
    await expect(
      checkpointer.getTuple({ configurable: { thread_id: threadId } })
    ).resolves.toBeUndefined();

    const next = await runtime.handleTextTurn({ ...turn, event: input("你好").event });
    expect(next?.replyText).not.toBe("這項操作目前無法建立確認，請重新提出。");
    expect(saveMemory).toHaveBeenCalledOnce();
  });

  it("resumes a scoped review once and replays its durable result", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "propose_save_memory", args: { content: "remember" }, id: "write-1" }]]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const sessions = new InMemorySessionStore();
    const jobs = new InMemoryAgentJobStore();
    const durableState = createHelperAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "state-key"
    });
    let runs = 0;
    const helperState: HelperAgentState = {
      ...durableState,
      async run(runInput) {
        runs += 1;
        const result = await durableState.run(runInput);
        if (runs === 2) throw new Error("checkpoint persistence failed after commit");
        return result;
      }
    };
    const saveMemory = vi.fn(async (args: Record<string, unknown>) => ({
      ok: true,
      replyText: args.confirm === true ? "已保存" : "請確認保存",
      writePhase: args.confirm === true ? ("commit" as const) : ("preview" as const)
    }));
    const writeProfile = {
      ...profile(),
      enabledFunctions: ["save_memory" as const],
      permissionRequiredFunctions: ["save_memory" as const]
    };
    const routeObserver = vi.fn();
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: helperState,
      handlers: { save_memory: saveMemory },
      sessions,
      jobs,
      routeObserver
    });
    const turn = {
      ...input("記住 remember"),
      profile: writeProfile,
      configuredFunctions: ["save_memory" as const],
      authorizeFunctions: async () => ["save_memory" as const]
    };

    await expect(runtime.handleTextTurn(turn)).resolves.toMatchObject({ writePhase: "preview" });
    const review = await sessions.findActionReview({
      profileName: "helper",
      source: turn.event.source,
      requesterUserId: "LINE_USER_ID"
    });
    if (!review) throw new Error("missing review");
    const wrongRequester = {
      ...turn,
      event: input("確認", { type: "user", userId: "OTHER_USER" }).event,
      reviewId: review.id,
      resultJobId: review.resultJobId,
      text: "確認"
    };
    await expect(runtime.handleActionReview?.(wrongRequester)).resolves.toMatchObject({
      result: { ok: true },
      freshExecution: false
    });
    await expect(sessions.get(review.id)).resolves.toBeDefined();
    expect(saveMemory).toHaveBeenCalledOnce();

    const approve = {
      ...turn,
      event: input("確認").event,
      reviewId: review.id,
      resultJobId: review.resultJobId,
      text: "確認"
    };
    await expect(runtime.handleActionReview?.(approve)).resolves.toMatchObject({
      result: { writePhase: "commit", replyText: "已保存" },
      freshExecution: true
    });
    await expect(runtime.handleActionReview?.(approve)).resolves.toMatchObject({
      result: { writePhase: "commit", replyText: "已保存" },
      freshExecution: false
    });
    expect(saveMemory).toHaveBeenCalledTimes(2);
    expect(
      routeObserver.mock.calls.filter(([event]) => event.eventName === "write_committed")
    ).toHaveLength(0);
  });

  it("clears prior tool evidence before the model runs after authorization is revoked", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "get_official_schedule",
            args: { query: "synthetic" },
            id: "tool-1"
          }
        ],
        [],
        []
      ]
    });
    const bindTools = vi.spyOn(model, "bindTools").mockReturnValue(model);
    const generate = vi.spyOn(model, "_generate");
    const helperProfile = profile();
    helperProfile.permissionRequiredFunctions = ["query_schedule"];
    const scopedState = createHelperAgentState({
      checkpointer: new MemorySaver(),
      hmacKey: "test-hmac"
    });
    let granted = true;
    const authorizeFunctions = vi.fn(async (names: readonly CapabilityName[]) =>
      granted ? names : names.filter((name) => name !== "query_schedule")
    );
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: scopedState,
      handlers: handlers()
    });
    const turn = {
      ...input("查服事表"),
      profile: helperProfile,
      configuredFunctions: readFunctions,
      authorizeFunctions
    };

    await runtime.handleTextTurn(turn);
    expect(generate.mock.calls.at(-1)?.[0].some(ToolMessage.isInstance)).toBe(true);
    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).toContain(
      "get_official_schedule"
    );

    granted = false;
    await runtime.handleTextTurn({ ...turn, event: input("繼續").event });

    const secondTurnModelInput = generate.mock.calls.at(-1)?.[0] ?? [];
    expect(bindTools.mock.calls.at(-1)?.[0].map(({ name }) => name)).not.toContain(
      "get_official_schedule"
    );
    expect(secondTurnModelInput.some(ToolMessage.isInstance)).toBe(false);
    expect(secondTurnModelInput.some((message) => message.text.includes("domain"))).toBe(false);
    expect(
      authorizeFunctions.mock.calls.filter(([names]) => names.length === readFunctions.length)
    ).toHaveLength(2);
  });

  it("keeps unrestricted reads when authorization infrastructure is unavailable", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "query_wikipedia",
            args: { query: "synthetic" },
            id: "tool-1"
          }
        ],
        []
      ]
    });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    const functionHandlers = handlers();
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: functionHandlers
    });

    await runtime.handleTextTurn({
      ...input("查百科"),
      configuredFunctions: readFunctions,
      authorizeFunctions: vi.fn(async () => Promise.reject(new Error("authorization unavailable")))
    });

    expect(functionHandlers.query_wikipedia).toHaveBeenCalledOnce();
  });

  it("returns a bounded support response when DeepSeek fails", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    vi.spyOn(model, "_generate").mockRejectedValue(new Error("provider timeout"));
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers()
    });

    const result = await runtime.handleTextTurn(input("你好"));

    expect(result).toMatchObject({ ok: false, replyText: expect.stringContaining("支援碼") });
    expect(result?.replyText.length).toBeLessThan(200);
  });

  it("still returns the bounded support response when error recording fails", async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state({ run: vi.fn(async () => Promise.reject(new Error("checkpoint unavailable"))) }),
      handlers: handlers(),
      lastErrorStore: {
        record: vi.fn(async () => Promise.reject(new Error("store unavailable"))),
        list: vi.fn(async () => []),
        clear: vi.fn(async () => 0)
      }
    });

    const result = await runtime.handleTextTurn(input("你好"));

    expect(result).toEqual({
      ok: false,
      replyText: expect.stringContaining("支援碼")
    });
    expect(result?.replyText.length).toBeLessThan(200);
  });

  it("resets only the scoped short-term thread", async () => {
    const scopedState = state();
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: scopedState,
      handlers: handlers()
    });

    await expect(runtime.handleTextTurn(input("忘記這段對話"))).resolves.toEqual({
      ok: true,
      replyText: "這段短期對話已清除。"
    });
    expect(scopedState.reset).toHaveBeenCalledWith("helper-LINE_USER_ID");
  });

  it("keeps IDs out of the prompt and all seven schemas within two thousand approximate tokens", () => {
    const context: FunctionHandlerContext = {
      profile: profile(),
      event: {
        type: "message",
        source: { type: "group", groupId: "LINE_GROUP_ID", userId: "LINE_USER_ID" },
        message: { type: "text", text: "synthetic" }
      }
    };
    const tools = createHelperReadTools({ context, handlers: handlers() });
    const prompt = helperSystemPrompt(
      profile(),
      context.event.source,
      new Date("2026-09-04T00:00:00Z")
    );

    expect(countTokensApproximately([], tools)).toBeLessThanOrEqual(2_000);
    expect(tools).toHaveLength(7);
    expect(prompt).not.toContain("LINE_USER_ID");
    expect(prompt).not.toContain("LINE_GROUP_ID");
    expect(prompt).toContain("group");
  });

  it("constructs response and summary models with one budgeted transport and 800 output tokens", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const models = createHelperModels({
      apiKey: "test",
      baseUrl: "https://api.deepseek.test",
      model: "deepseek-v4-flash",
      timeoutMs: 8_000,
      fetchImpl
    });

    expect(models.model.maxTokens).toBe(800);
    expect(models.summaryModel.maxTokens).toBe(800);
    expect(models.model.clientConfig.fetch).toBe(models.summaryModel.clientConfig.fetch);
    expect(models.model.clientConfig.fetch).not.toBe(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits only bounded helper counters, tool names, and statuses", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "get_official_schedule",
            args: { query: "synthetic-private-text" },
            id: "tool-private-id"
          }
        ],
        []
      ]
    });
    const traceStore = new InMemoryAgentTraceStore();
    const routeObserver = vi.fn();
    const runtime = createHelperRuntime({
      model,
      summaryModel: model,
      state: state(),
      handlers: handlers(),
      traceStore,
      routeObserver
    });

    await runtime.handleTextTurn(input("synthetic-private-text"));

    const traces = await traceStore.list();
    expect(traces[0]?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "route",
          provider: "deepseek",
          modelCallCount: 2,
          toolCallCount: 1,
          selectedToolNames: ["get_official_schedule"],
          finalStatus: "success"
        })
      ])
    );
    expect(routeObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "product_event",
        eventName: "helper_agent_turn",
        modelCallCount: 2,
        toolCallCount: 1,
        resultClass: "success"
      })
    );
    expect(JSON.stringify({ traces, events: routeObserver.mock.calls })).not.toMatch(
      /synthetic-private-text|LINE_USER_ID|tool-private-id/u
    );
  });
});
