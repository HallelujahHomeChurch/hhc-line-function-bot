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
});
