import { afterEach, describe, expect, it, vi } from "vitest";

import { createOllamaProvider } from "../clients/ollama.js";

describe("Ollama client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits keep_alive from chat requests when it is not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '{"action":"deny"}' } }), {
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchImpl);
    const provider = createOllamaProvider({
      baseUrl: "http://ollama.local:11434",
      model: "qwen3:4b-instruct",
      timeoutMs: 8000
    });

    await provider.completeJson({
      prompt: "Return JSON.",
      profileName: "helper",
      text: "小哈",
      enabledFunctions: ["query_service_schedule"]
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.keep_alive).toBeUndefined();
  });

  it("sends keep_alive when explicitly configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '{"action":"deny"}' } }), {
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchImpl);
    const provider = createOllamaProvider({
      baseUrl: "http://ollama.local:11434",
      model: "qwen3:4b-instruct",
      timeoutMs: 8000,
      keepAlive: -1
    });

    await provider.completeJson({
      prompt: "Return JSON.",
      profileName: "helper",
      text: "小哈",
      enabledFunctions: ["query_service_schedule"]
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.keep_alive).toBe(-1);
  });

  it("generates controlled text without JSON response formatting", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "我在，謝謝你關心。" } }), {
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchImpl);
    const provider = createOllamaProvider({
      baseUrl: "http://ollama.local:11434",
      model: "qwen3:4b-instruct",
      timeoutMs: 8000,
      keepAlive: -1
    });

    await provider.completeText({
      prompt: "Reply briefly.",
      profileName: "helper",
      text: "小哈你好嗎",
      category: "wellbeing",
      maxChars: 80
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.format).toBeUndefined();
    expect(body.options).toMatchObject({
      temperature: 0.4,
      num_predict: 80
    });
    expect(body.keep_alive).toBe(-1);
  });
});
