import { describe, expect, it, vi } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

import { createSdkAgentState } from "../agent/sdk-state.js";
import { createSdkAgentTurnRuntime } from "../agent/sdk-turn-runtime.js";
import type { AgentTurnRuntime } from "../agent/turn-runtime.js";
import { InMemorySessionStore } from "../state/session-store.js";
import { InMemoryLastErrorStore } from "../observability/last-error-store.js";
import { createSupportId } from "../observability/opaque-identifiers.js";
import type { BotProfileConfig, FunctionRegistry, LineEvent } from "../types.js";

function profile(name: "helper" | "main" = "helper"): BotProfileConfig {
  return {
    name,
    webhookPath: `/api/line/webhook/${name}`,
    channelSecret: "secret",
    channelAccessToken: "token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: name === "helper",
    wakeKeywords: name === "helper" ? ["小哈"] : [],
    acceptMention: name === "helper",
    enabledFunctions: name === "helper" ? ["query_schedule"] : ["download_weekly_paper"],
    permissionRequiredFunctions: [],
    allowedProviders: name === "helper" ? ["deepseek"] : [],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] },
    agent:
      name === "helper"
        ? { personaPrompt: "你是小哈。", memoryPolicyPrompt: "不要記錄未受理群聊。" }
        : undefined
  };
}

function event(source: LineEvent["source"] = { type: "user", userId: "U1" }): LineEvent {
  return {
    type: "message",
    source,
    message: { type: "text", text: "這週日誰服事？" }
  };
}

function state() {
  return createSdkAgentState({
    checkpointer: new MemorySaver(),
    hmacKey: "0123456789abcdef0123456789abcdef",
    ttlMs: 600_000
  });
}

describe("SDK agent turn runtime", () => {
  it("records provider failures under the reply support id", async () => {
    const errors = new InMemoryLastErrorStore(10);
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    vi.spyOn(model, "bindTools").mockReturnValue(model);
    vi.spyOn(model, "_generate").mockRejectedValue(new Error("provider failed"));
    const runtime = createSdkAgentTurnRuntime({
      fallback: { handleTextTurn: vi.fn(async () => undefined) },
      functionRegistry: { query_schedule: vi.fn() },
      lastErrorStore: errors,
      model,
      state: state()
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      configuredFunctions: ["query_schedule"],
      event: event(),
      requestId: "request-provider-failure"
    });

    expect(result?.replyText).toContain(createSupportId("request-provider-failure"));
    await expect(errors.list()).resolves.toEqual([
      expect.objectContaining({
        supportId: createSupportId("request-provider-failure"),
        phase: "router",
        errorName: "Error",
        message: "redacted"
      })
    ]);
  });

  it("keeps main on its provider-free fallback", async () => {
    const fallbackResult = { ok: true, replyText: "main result" };
    const fallback: AgentTurnRuntime = {
      handleTextTurn: vi.fn(async () => fallbackResult)
    };
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const generate = vi.spyOn(model, "_generate");
    const runtime = createSdkAgentTurnRuntime({
      fallback,
      functionRegistry: {},
      model,
      state: state()
    });

    await expect(
      runtime.handleTextTurn({
        profile: profile("main"),
        event: event(),
        requestId: "request-main"
      })
    ).resolves.toEqual(fallbackResult);
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs helper reads through the SDK tool loop", async () => {
    const fallback: AgentTurnRuntime = {
      handleTextTurn: vi.fn(async () => undefined)
    };
    const querySchedule = vi.fn(async () => ({
      ok: true,
      replyText: "正式服事表：同工甲",
      agentResult: {
        status: "success" as const,
        replyText: "服事表查詢完成。",
        replyData: {
          kind: "schedule",
          fields: {},
          records: [{ role: "敬拜", people: "同工甲" }]
        }
      }
    }));
    const functions: FunctionRegistry = { query_schedule: querySchedule };
    const runtime = createSdkAgentTurnRuntime({
      fallback,
      functionRegistry: functions,
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "query_schedule",
              args: { query: "這週日" },
              id: "schedule-1"
            }
          ],
          []
        ]
      }),
      state: state()
    });

    const result = await runtime.handleTextTurn({
      profile: profile(),
      configuredFunctions: ["query_schedule"],
      event: event(),
      requestId: "request-helper",
      authorizeFunctions: async (names) => names
    });

    expect(querySchedule).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ ok: true, replyText: expect.any(String) }));
  });

  it("lets existing confirmation and selection handlers finish before the agent", async () => {
    const pending = {
      ok: true,
      replyText: "已儲存",
      writePhase: "commit" as const
    };
    const fallback: AgentTurnRuntime = {
      handleTextTurn: vi.fn(async () => pending)
    };
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const generate = vi.spyOn(model, "_generate");
    const runtime = createSdkAgentTurnRuntime({
      fallback,
      functionRegistry: {},
      model,
      state: state()
    });

    await expect(
      runtime.handleTextTurn({
        profile: profile(),
        event: event(),
        requestId: "request-pending"
      })
    ).resolves.toEqual(pending);
    expect(fallback.handleTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({ allowRouting: false })
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not create group state without a requester", async () => {
    const fallback: AgentTurnRuntime = {
      handleTextTurn: vi.fn(async () => undefined)
    };
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const generate = vi.spyOn(model, "_generate");
    const runtime = createSdkAgentTurnRuntime({
      fallback,
      functionRegistry: {},
      model,
      state: state()
    });

    await expect(
      runtime.handleTextTurn({
        profile: profile(),
        event: event({ type: "group", groupId: "G1" }),
        requestId: "request-no-user"
      })
    ).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("turns existing web consent into iterative discovery and the existing import selection", async () => {
    const sessions = new InMemorySessionStore();
    await sessions.set({
      id: "consent-1",
      type: "external_search_consent",
      action: "sheet_music_external_search",
      profileName: "helper",
      requesterUserId: "U1",
      source: { type: "user", userId: "U1" },
      query: "合成曲目",
      arguments: { query: "合成曲目" },
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const helper = profile();
    helper.enabledFunctions = ["find_sheet_music"];
    const runtime = createSdkAgentTurnRuntime({
      fallback: { handleTextTurn: vi.fn(async () => undefined) },
      functionRegistry: { find_sheet_music: vi.fn() },
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "search_sheet_music_web",
              args: { query: "合成曲目 合唱 樂譜 PDF" },
              id: "search-1"
            }
          ],
          [
            {
              name: "read_sheet_music_page",
              args: { ref: "web-1" },
              id: "read-1"
            }
          ],
          []
        ]
      }),
      state: state(),
      sessionStore: sessions,
      webSearch: {
        search: vi.fn(async () => [
          { title: "Choir score", url: "https://public.example.test/score.pdf" }
        ])
      },
      pageReader: {
        read: vi.fn(async () => ({
          kind: "direct_file" as const,
          untrusted: true as const,
          links: []
        }))
      }
    });

    await runtime.handleTextTurn({
      profile: helper,
      configuredFunctions: ["find_sheet_music"],
      event: {
        type: "message",
        source: { type: "user", userId: "U1" },
        message: { type: "text", text: "上網找" }
      },
      requestId: "external-selection-1",
      authorizeFunctions: async (names) => names
    });

    await expect(
      sessions.findExternalSheetMusicImport({
        profileName: "helper",
        source: { type: "user", userId: "U1" },
        requesterUserId: "U1"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        stage: "selecting",
        items: [
          {
            title: "Choir score",
            url: "https://public.example.test/score.pdf"
          }
        ]
      })
    );
  });
});
