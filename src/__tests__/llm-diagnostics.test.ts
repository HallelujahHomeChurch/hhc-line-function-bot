import { describe, expect, it, vi } from "vitest";

import { createLlmStatusAdminHandler } from "../llm-diagnostics.js";
import type { LlmConfig } from "../types.js";

function llmConfig(): LlmConfig {
  return {
    ollamaBaseUrl: "http://172.16.65.5:11434",
    ollamaModel: "qwen3:4b-instruct",
    ollamaKeepAlive: -1,
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-flash",
    deepseekTimeoutMs: 8000,
    timeoutMs: 8000,
    keywordFallbackEnabled: true
  };
}

function llmConfigWithoutKeepAlive(): LlmConfig {
  return {
    ollamaBaseUrl: "http://172.16.65.5:11434",
    ollamaModel: "qwen3:4b-instruct",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-flash",
    deepseekTimeoutMs: 8000,
    timeoutMs: 8000,
    keywordFallbackEnabled: true
  };
}

function adminContext() {
  return {
    profile: {
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
      enabledFunctions: ["query_service_schedule"],
      allowedProviders: ["ollama", "deepseek"],
      allowSubscriptionProviders: false,
      adminUserId: "Uadmin",
      adminDirectOnly: true
    },
    event: { type: "message", source: { type: "user", userId: "Uadmin" } },
    command: "llm-status",
    args: []
  } as const;
}

describe("LLM diagnostics admin handler", () => {
  it("reports DeepSeek configured state without exposing the API key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      })
    );
    const handler = createLlmStatusAdminHandler(
      {
        ...llmConfig(),
        provider: "deepseek",
        fallbackProvider: "ollama",
        deepseekApiKey: "sk-secret"
      },
      { fetchImpl }
    );

    const result = await handler(adminContext());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(result.replyText).toContain("provider: deepseek");
    expect(result.replyText).toContain("apiKey: configured");
    expect(result.replyText).toContain("model: deepseek-v4-flash");
    expect(result.replyText).toContain("chat: ok");
    expect(result.replyText).not.toContain("sk-secret");
  });

  it("skips DeepSeek chat probe when the API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const handler = createLlmStatusAdminHandler(
      {
        ...llmConfig(),
        provider: "deepseek",
        fallbackProvider: "ollama"
      },
      { fetchImpl }
    );

    const result = await handler(adminContext());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.replyText).toContain("provider: deepseek");
    expect(result.replyText).toContain("apiKey: missing");
    expect(result.replyText).toContain("chat: skipped");
  });

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

    const result = await handler(adminContext());

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

    await handler(adminContext());

    const body = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(body.keep_alive).toBeUndefined();
  });

  it("reports an unreachable Ollama endpoint as a diagnostic result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const handler = createLlmStatusAdminHandler(llmConfig(), { fetchImpl });

    const result = await handler(adminContext());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain("LLM status");
    expect(result.replyText).toContain("tags: error");
    expect(result.replyText).toContain("connect ECONNREFUSED");
    expect(result.replyText).toContain("chat: skipped");
  });
});
