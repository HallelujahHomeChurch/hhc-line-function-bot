import { describe, expect, it, vi } from "vitest";

import { createKeywordFallbackRouter } from "../keyword-router.js";
import { createFunctionRouter } from "../router.js";
import type { ChatProvider, FunctionName } from "../types.js";

const enabledFunctions: FunctionName[] = [
  "find_ppt_slides",
  "query_service_schedule",
  "find_pop_sheet_music"
];

function invalidProvider(): ChatProvider {
  return {
    completeJson: vi.fn().mockResolvedValue("not-json")
  };
}

describe("router eval corpus", () => {
  it.each([
    {
      text: "小哈 查投影片 主日報告 pdf",
      action: "find_ppt_slides",
      arguments: { query: "主日報告", fileType: "pdf", matchMode: "fuzzy" }
    },
    {
      text: "小哈 查流行歌譜 A TIME FOR US",
      action: "find_pop_sheet_music",
      arguments: { query: "A TIME FOR US", fileType: "pdf", matchMode: "fuzzy" }
    },
    {
      text: "小哈 查歌譜 Yesterday jpg",
      action: "find_pop_sheet_music",
      arguments: { query: "Yesterday", fileType: "image", matchMode: "fuzzy" }
    },
    {
      text: "小哈 查服事表",
      action: "query_service_schedule",
      arguments: { query: "服事表" }
    }
  ] as const)("routes '$text' with conservative keyword fallback", async (entry) => {
    const router = createFunctionRouter({
      primary: invalidProvider(),
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "helper",
      text: entry.text,
      enabledFunctions,
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: entry.action,
      provider: "keyword",
      arguments: entry.arguments
    });
  });

  it.each(["小哈 查流行歌 Yesterday", "小哈 查詩歌 奇異恩典", "小哈 幫我查資料"])(
    "denies unsupported keyword fallback phrase '%s'",
    async (text) => {
      const router = createFunctionRouter({
        primary: invalidProvider(),
        keywordFallback: createKeywordFallbackRouter(),
        keywordFallbackEnabled: true
      });

      const result = await router.route({
        profileName: "helper",
        text,
        enabledFunctions,
        source: { type: "group", groupId: "C1", userId: "U1" }
      });

      expect(result).toMatchObject({
        type: "deny",
        reason: "keyword_no_match",
        provider: "keyword"
      });
    }
  );
});
