import { describe, expect, it, vi } from "vitest";

import { createWikipediaClient } from "../wikipedia/client.js";
import { createWikipediaLookupHandler } from "../wikipedia/lookup.js";
import { createWikipediaSummarizer } from "../wikipedia/summarizer.js";
import type { FunctionHandlerContext } from "../types.js";

describe("Wikipedia client", () => {
  it("searches Chinese Wikipedia and maps a safe article link", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            search: [{ title: "馬丁·路德", snippet: "宗教改革者" }]
          }
        }),
        { status: 200 }
      )
    );
    const client = createWikipediaClient({
      userAgent: "HHCLineBot/1.0 (https://alive.org.tw/contact)",
      fetchImpl
    });

    await expect(client.search("zh", "馬丁路德", 3)).resolves.toEqual([
      {
        language: "zh",
        title: "馬丁·路德",
        snippet: "宗教改革者",
        articleUrl: "https://zh.wikipedia.org/wiki/%E9%A6%AC%E4%B8%81%C2%B7%E8%B7%AF%E5%BE%B7"
      }
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("zh.wikipedia.org/w/api.php"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": "HHCLineBot/1.0 (https://alive.org.tw/contact)"
        })
      })
    );
  });

  it("returns an article extract without requesting arbitrary URLs", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            pages: [{ title: "馬丁·路德", extract: "馬丁·路德是宗教改革者。" }]
          }
        }),
        { status: 200 }
      )
    );
    const client = createWikipediaClient({
      userAgent: "HHCLineBot/1.0 (https://alive.org.tw/contact)",
      fetchImpl
    });

    await expect(client.getIntro("zh", "馬丁·路德")).resolves.toEqual({
      language: "zh",
      title: "馬丁·路德",
      extract: "馬丁·路德是宗教改革者。",
      articleUrl: "https://zh.wikipedia.org/wiki/%E9%A6%AC%E4%B8%81%C2%B7%E8%B7%AF%E5%BE%B7"
    });
  });
});

describe("Wikipedia lookup handler", () => {
  const context: FunctionHandlerContext = {
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
      enabledFunctions: ["find_ppt_slides"],
      allowedProviders: ["ollama"],
      allowSubscriptionProviders: false
    },
    event: { type: "message", source: { type: "user", userId: "U1" } }
  };

  it("uses a source-bounded summary instead of returning the raw article extract", async () => {
    const summarize = vi.fn().mockResolvedValue("馬丁・路德是宗教改革的重要人物。");
    const handler = createWikipediaLookupHandler({
      client: {
        search: vi.fn().mockResolvedValue([
          {
            language: "zh",
            title: "馬丁・路德",
            snippet: "宗教改革者",
            articleUrl: "https://zh.wikipedia.org/wiki/Martin_Luther"
          }
        ]),
        getIntro: vi.fn().mockResolvedValue({
          language: "zh",
          title: "馬丁・路德",
          extract: "這是一段不應直接複製給使用者的原始條目摘要。",
          articleUrl: "https://zh.wikipedia.org/wiki/Martin_Luther"
        })
      },
      summarize
    });

    const result = await handler({ query: "馬丁路德" }, context);

    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ query: "馬丁路德", title: "馬丁・路德" })
    );
    expect(result.replyText).toContain("馬丁・路德是宗教改革的重要人物。");
    expect(result.replyText).toContain("https://zh.wikipedia.org/wiki/Martin_Luther");
    expect(result.replyText).not.toContain("不應直接複製");
    expect(result.agentResult).toEqual({
      status: "success",
      replyText: "維基百科查詢完成。",
      anchors: { language: "zh" },
      entities: [
        { type: "topic", key: expect.stringMatching(/^[a-f0-9]{24}$/u), label: "維基百科主題" }
      ],
      evidence: [
        {
          kind: "wikipedia_page",
          reference: { pageId: expect.stringMatching(/^[a-f0-9]{24}$/u) }
        }
      ],
      supportedOperations: ["continue", "refine", "view_full"]
    });
    expect(JSON.stringify(result.agentResult)).not.toMatch(/馬丁|Martin Luther|wikipedia\.org/iu);
  });

  it("falls back to English Wikipedia only after Chinese has no results", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          language: "en",
          title: "Martin Luther",
          snippet: "Reformer",
          articleUrl: "https://en.wikipedia.org/wiki/Martin_Luther"
        }
      ]);
    const handler = createWikipediaLookupHandler({
      client: {
        search,
        getIntro: vi.fn().mockResolvedValue({
          language: "en",
          title: "Martin Luther",
          extract: "Source extract.",
          articleUrl: "https://en.wikipedia.org/wiki/Martin_Luther"
        })
      },
      summarize: vi.fn().mockResolvedValue("英文條目整理。")
    });

    const result = await handler({ query: "Martin Luther" }, context);

    expect(search).toHaveBeenNthCalledWith(1, "zh", "Martin Luther", 3);
    expect(search).toHaveBeenNthCalledWith(2, "en", "Martin Luther", 3);
    expect(result.replyText).toContain("英文條目整理。");
  });
});

describe("Wikipedia summarizer", () => {
  it("passes only the selected article extract to the configured generator", async () => {
    const completeText = vi.fn().mockResolvedValue("整理後的答案");
    const summarize = createWikipediaSummarizer({
      primary: { completeText, providerName: "deepseek" }
    });

    await expect(
      summarize({
        profileName: "helper",
        query: "馬丁路德是誰",
        title: "馬丁・路德",
        language: "zh",
        extract: "來源內容"
      })
    ).resolves.toBe("整理後的答案");
    expect(completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "helper",
        text: expect.stringContaining("來源內容"),
        prompt: expect.stringContaining("只可依據提供的維基百科來源")
      })
    );
  });
});
