import { describe, expect, it, vi } from "vitest";

import { ProviderResponseError, createFunctionRouter } from "../router.js";
import type { ChatProvider } from "../types.js";

function provider(raw: string): ChatProvider {
  return {
    completeJson: vi.fn().mockResolvedValue(raw)
  };
}

describe("function router", () => {
  it("returns an executable action when Qwen returns valid JSON for an enabled function", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        confidence: 0.93,
        arguments: { query: "主日詩歌", includePdf: true }
      })
    );
    const azure = provider(JSON.stringify({ action: "deny", reason: "unused" }));
    const router = createFunctionRouter({ primary: qwen, fallback: azure, fallbackEnabled: true });

    const result = await router.route({
      profileName: "main",
      text: "找主日詩歌 ppt",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "ollama",
      arguments: { query: "主日詩歌", includePdf: true }
    });
    expect(azure.completeJson).not.toHaveBeenCalled();
  });

  it("denies disabled functions without calling fallback", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "query_service_schedule",
        confidence: 0.9,
        arguments: { query: "招待" }
      })
    );
    const azure = provider(JSON.stringify({ action: "find_ppt_slides", arguments: {} }));
    const router = createFunctionRouter({ primary: qwen, fallback: azure, fallbackEnabled: true });

    const result = await router.route({
      profileName: "slides",
      text: "查招待服事",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "function_disabled",
      provider: "ollama"
    });
    expect(azure.completeJson).not.toHaveBeenCalled();
  });

  it("does not fallback when Qwen explicitly denies", async () => {
    const qwen = provider(JSON.stringify({ action: "deny", reason: "not_matched" }));
    const azure = provider(
      JSON.stringify({ action: "find_ppt_slides", arguments: { query: "should not run" } })
    );
    const router = createFunctionRouter({ primary: qwen, fallback: azure, fallbackEnabled: true });

    const result = await router.route({
      profileName: "main",
      text: "今天天氣",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({ type: "deny", reason: "not_matched", provider: "ollama" });
    expect(azure.completeJson).not.toHaveBeenCalled();
  });

  it("falls back to Azure OpenAI when Qwen returns invalid JSON", async () => {
    const qwen = provider("not-json");
    const azure = provider(
      JSON.stringify({
        action: "query_service_schedule",
        confidence: 0.84,
        arguments: { query: "主日司會" }
      })
    );
    const router = createFunctionRouter({ primary: qwen, fallback: azure, fallbackEnabled: true });

    const result = await router.route({
      profileName: "main",
      text: "查主日司會",
      enabledFunctions: ["query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "query_service_schedule",
      provider: "azure_openai",
      arguments: { query: "主日司會" }
    });
  });

  it("falls back to Azure OpenAI when Qwen times out", async () => {
    const qwen: ChatProvider = {
      completeJson: vi.fn().mockRejectedValue(new ProviderResponseError("timeout"))
    };
    const azure = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        confidence: 0.8,
        arguments: { query: "青年聚會" }
      })
    );
    const router = createFunctionRouter({ primary: qwen, fallback: azure, fallbackEnabled: true });

    const result = await router.route({
      profileName: "main",
      text: "找青年聚會投影片",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "azure_openai"
    });
  });
});
