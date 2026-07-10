import { describe, expect, it, vi } from "vitest";

import { createDeepSeekProvider } from "../clients/deepseek.js";

function provider(fetchImpl: typeof fetch, apiKey?: string) {
  return createDeepSeekProvider({
    apiKey: apiKey ?? "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    timeoutMs: 8000,
    routeMaxOutputTokens: 256,
    generalMaxOutputTokens: 512,
    fetchImpl
  });
}

describe("DeepSeek client", () => {
  it("sends JSON chat completion requests with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"deny"}' } }] }), {
        status: 200
      })
    );

    const result = await provider(fetchImpl).completeJson({
      prompt: "Return JSON.",
      profileName: "helper",
      text: "hello",
      enabledFunctions: []
    });

    expect(result).toBe('{"action":"deny"}');
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk-test"
        })
      })
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: false,
      temperature: 0,
      max_tokens: 256,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" }
    });
  });

  it("sends controlled text requests without JSON response formatting", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "我在。" } }] }), {
        status: 200
      })
    );

    await provider(fetchImpl).completeText({
      prompt: "Reply briefly.",
      profileName: "helper",
      text: "小哈你好",
      category: "greeting",
      maxChars: 320
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toBeUndefined();
    expect(body).toMatchObject({
      temperature: 0.4,
      max_tokens: 320,
      thinking: { type: "disabled" }
    });
  });

  it("uses the configured token budget when a text request has no character limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
        status: 200
      })
    );

    await provider(fetchImpl).completeText({
      prompt: "Reply naturally.",
      profileName: "helper",
      text: "hello",
      category: "greeting"
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(512);
  });

  it("fails fast when the API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createDeepSeekProvider({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      timeoutMs: 8000,
      routeMaxOutputTokens: 256,
      generalMaxOutputTokens: 512,
      fetchImpl
    });

    await expect(
      client.completeJson({
        prompt: "Return JSON.",
        profileName: "helper",
        text: "hello",
        enabledFunctions: []
      })
    ).rejects.toThrow("deepseek_missing_api_key");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps HTTP errors to provider errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 429 }));

    await expect(
      provider(fetchImpl).completeJson({
        prompt: "Return JSON.",
        profileName: "helper",
        text: "hello",
        enabledFunctions: []
      })
    ).rejects.toThrow("deepseek_http_429");
  });
});
