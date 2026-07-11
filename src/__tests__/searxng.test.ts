import { describe, expect, it, vi } from "vitest";

import { createSearxngClient } from "../clients/searxng.js";

describe("SearXNG client", () => {
  it("returns normalized public web search results from SearXNG JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "Song sheet music",
            content: "snippet",
            url: "https://example.org/song"
          },
          {
            title: "Local result",
            content: "ignored",
            url: "file:///tmp/song.pdf"
          }
        ]
      })
    });
    const client = createSearxngClient({
      baseUrl: "https://searxng.internal/",
      timeoutMs: 5000,
      fetchImpl: fetchMock
    });

    await expect(
      client.search({ query: "Amazing Grace 歌譜", language: "zh-TW", limit: 5 })
    ).resolves.toEqual([
      {
        title: "Song sheet music",
        snippet: "snippet",
        url: "https://example.org/song"
      }
    ]);
    const requestUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestUrl.toString()).toContain("https://searxng.internal/search?");
    expect(requestUrl.searchParams.get("q")).toBe("Amazing Grace 歌譜");
    expect(requestUrl.searchParams.get("format")).toBe("json");
    expect(requestUrl.searchParams.get("language")).toBe("zh-TW");
  });
});
