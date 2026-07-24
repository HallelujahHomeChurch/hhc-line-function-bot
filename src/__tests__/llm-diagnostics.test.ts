import { describe, expect, it, vi } from "vitest";

import { createLlmStatusAdminHandler } from "../llm-diagnostics.js";
import type { LlmConfig, ProviderPolicy } from "../types.js";

function llmConfig(): LlmConfig {
  return {
    provider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-flash",
    deepseekTimeoutMs: 8000
  };
}

function providerPolicy(): ProviderPolicy {
  return {
    function_routing: { primary: "deepseek" },
    admin_routing: { primary: "deepseek" },
    memory_routing: { primary: "deepseek" },
    smart_talk: { primary: "deepseek" },
    general_agent: { primary: "deepseek" },
    context_compression: { primary: "deepseek" },
    web_summarization: { primary: "deepseek" }
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
      enabledFunctions: ["query_schedule"],
      allowedProviders: ["deepseek"],
      providerPolicy: providerPolicy(),
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
  it("reports DeepSeek configured state without exposing the API key or a fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      })
    );
    const handler = createLlmStatusAdminHandler(
      { ...llmConfig(), deepseekApiKey: "sk-secret" },
      { fetchImpl }
    );

    const result = await handler(adminContext());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(result.replyText).toContain("provider: deepseek");
    expect(result.replyText).toContain("apiKey: configured");
    expect(result.replyText).toContain("fallback: none");
    expect(result.replyText).toContain("- function_routing: deepseek");
    expect(result.replyText).toContain("chat: ok");
    expect(result.replyText).not.toContain("sk-secret");
  });

  it("skips the probe when the DeepSeek API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const handler = createLlmStatusAdminHandler(llmConfig(), { fetchImpl });

    const result = await handler(adminContext());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.replyText).toContain("apiKey: missing");
    expect(result.replyText).toContain("chat: skipped");
  });
});
