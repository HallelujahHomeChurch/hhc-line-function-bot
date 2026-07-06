import { describe, expect, it, vi } from "vitest";

import { createLlmStatusAdminHandler } from "../llm-diagnostics.js";
import type { LlmConfig } from "../types.js";

function llmConfig(): LlmConfig {
  return {
    ollamaBaseUrl: "http://172.16.65.5:11434",
    ollamaModel: "qwen3:4b-instruct",
    ollamaKeepAlive: -1,
    timeoutMs: 8000,
    keywordFallbackEnabled: true
  };
}

function llmConfigWithoutKeepAlive(): LlmConfig {
  return {
    ollamaBaseUrl: "http://172.16.65.5:11434",
    ollamaModel: "qwen3:4b-instruct",
    timeoutMs: 8000,
    keywordFallbackEnabled: true
  };
}

describe("LLM diagnostics admin handler", () => {
  it("checks Ollama tags and chat without exposing the full base URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: "qwen3:4b-instruct" }]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: '{"action":"deny"}' } }), {
          status: 200
        })
      );
    const handler = createLlmStatusAdminHandler(llmConfig(), { fetchImpl });

    const result = await handler({
      profile: {
        name: "helper",
        webhookPath: "/line/helper/webhook",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowedGroupIds: [],
        allowedUserIds: ["Uadmin"],
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_service_schedule"],
        adminUserIds: ["Uadmin"],
        adminDirectOnly: true
      },
      event: { type: "message", source: { type: "user", userId: "Uadmin" } },
      command: "llm-status",
      args: []
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://172.16.65.5:11434/api/tags");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://172.16.65.5:11434/api/chat");
    expect(result.replyText).toContain("LLM status");
    expect(result.replyText).toContain("host: private-ip");
    expect(result.replyText).toContain("model: qwen3:4b-instruct");
    expect(result.replyText).toContain("tags: ok");
    expect(result.replyText).toContain("modelPresent: true");
    expect(result.replyText).toContain("chat: ok");
    expect(result.replyText).not.toContain("172.16.65.5");
  });

  it("omits keep_alive from the diagnostic chat probe when it is not configured", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: "qwen3:4b-instruct" }] }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: '{"action":"deny"}' } }), {
          status: 200
        })
      );
    const handler = createLlmStatusAdminHandler(llmConfigWithoutKeepAlive(), { fetchImpl });

    await handler({
      profile: {
        name: "helper",
        webhookPath: "/line/helper/webhook",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowedGroupIds: [],
        allowedUserIds: ["Uadmin"],
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_service_schedule"],
        adminUserIds: ["Uadmin"],
        adminDirectOnly: true
      },
      event: { type: "message", source: { type: "user", userId: "Uadmin" } },
      command: "llm-status",
      args: []
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(body.keep_alive).toBeUndefined();
  });

  it("reports an unreachable Ollama endpoint as a diagnostic result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const handler = createLlmStatusAdminHandler(llmConfig(), { fetchImpl });

    const result = await handler({
      profile: {
        name: "helper",
        webhookPath: "/line/helper/webhook",
        channelSecret: "secret",
        channelAccessToken: "token",
        allowedGroupIds: [],
        allowedUserIds: ["Uadmin"],
        allowDirectUser: true,
        allowRooms: false,
        allowedMessageTypes: ["text"],
        groupRequireWakeWord: true,
        wakeKeywords: ["小哈"],
        acceptMention: true,
        enabledFunctions: ["query_service_schedule"],
        adminUserIds: ["Uadmin"],
        adminDirectOnly: true
      },
      event: { type: "message", source: { type: "user", userId: "Uadmin" } },
      command: "llm-status",
      args: []
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain("LLM status");
    expect(result.replyText).toContain("tags: error");
    expect(result.replyText).toContain("connect ECONNREFUSED");
    expect(result.replyText).toContain("chat: skipped");
  });
});
