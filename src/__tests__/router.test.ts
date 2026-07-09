import { describe, expect, it, vi } from "vitest";

import { createKeywordFallbackRouter } from "../keyword-router.js";
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
        arguments: { query: "奇異恩典", includePdf: true }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片 奇異恩典",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "ollama",
      arguments: { query: "奇異恩典", includePdf: true }
    });
  });

  it("returns a controlled greeting small-talk response when Qwen classifies a greeting", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "small_talk",
        confidence: 0.92,
        arguments: { category: "greeting" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "你好",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "small_talk",
      provider: "ollama",
      confidence: 0.92,
      arguments: { category: "greeting" }
    });
  });

  it("returns a controlled small-talk response when Qwen classifies addressed chat", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "small_talk",
        confidence: 0.87,
        arguments: { category: "reassurance" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈，你會覺得我們這樣很難為你嗎",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "small_talk",
      provider: "ollama",
      confidence: 0.87,
      arguments: { category: "reassurance" }
    });
  });

  it("passes structured service schedule metadata from Qwen", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "query_service_schedule",
        confidence: 0.91,
        arguments: {
          query: "下一場聚會服事表",
          dateIntent: "next_meeting",
          meeting: "主日",
          role: "音控",
          limit: "1",
          ignored: "drop me"
        }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 下一場主日音控是誰",
      enabledFunctions: ["query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toEqual({
      type: "execute",
      action: "query_service_schedule",
      provider: "ollama",
      confidence: 0.91,
      arguments: {
        query: "下一場聚會服事表",
        dateIntent: "next_meeting",
        meeting: "主日",
        role: "音控",
        limit: 1
      }
    });
  });

  it("keeps the original text for schedule parsing when Qwen omits metadata", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "query_service_schedule",
        arguments: { query: "" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈，下一場聚會服事表。",
      enabledFunctions: ["query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "query_service_schedule",
      provider: "ollama",
      arguments: { query: "小哈，下一場聚會服事表。" }
    });
  });

  it("passes structured PPT metadata from Qwen", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        confidence: 0.88,
        arguments: {
          query: "奇易恩點",
          originalQuery: "小哈 查投影片 奇易恩點",
          fileType: "any",
          includePdf: true,
          matchMode: "fuzzy"
        }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片 奇易恩點",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "ollama",
      arguments: {
        query: "奇易恩點",
        originalQuery: "小哈 查投影片 奇易恩點",
        fileType: "any",
        includePdf: true,
        matchMode: "fuzzy"
      }
    });
  });

  it("extracts a PPT title from the user text when Qwen omits the query", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        confidence: 0.81,
        arguments: { query: "" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈，查奇異恩典的投影片",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "ollama",
      arguments: {
        query: "奇異恩典",
        originalQuery: "小哈，查奇異恩典的投影片"
      }
    });
  });

  it("cleans a wrapped PPT title when Qwen returns the full request as query", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        confidence: 0.82,
        arguments: { query: "小哈，幫我查奇異恩典的投影片" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈，幫我查奇異恩典的投影片",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "ollama",
      arguments: {
        query: "奇異恩典",
        originalQuery: "小哈，幫我查奇異恩典的投影片"
      }
    });
  });

  it("keeps generic PPT queries empty when Qwen returns only request words", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        confidence: 0.79,
        arguments: { query: "小哈 查投影片" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "ollama",
      arguments: {
        query: "",
        originalQuery: "小哈 查投影片"
      }
    });
  });

  it("routes structured pop sheet music metadata from Qwen", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_pop_sheet_music",
        confidence: 0.89,
        arguments: {
          query: "A TIME FOR US",
          artist: "Andy Williams",
          fileType: "pdf",
          matchMode: "fuzzy",
          ignored: "drop me"
        }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查流行歌譜 A TIME FOR US Andy Williams",
      enabledFunctions: ["find_pop_sheet_music"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toEqual({
      type: "execute",
      action: "find_pop_sheet_music",
      provider: "ollama",
      confidence: 0.89,
      arguments: {
        query: "A TIME FOR US",
        artist: "Andy Williams",
        fileType: "pdf",
        matchMode: "fuzzy"
      }
    });
  });

  it("extracts a sheet music title from the user text when Qwen omits the query", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_pop_sheet_music",
        confidence: 0.82,
        arguments: { query: "", matchMode: "fuzzy" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈，幫我找 Yesterday 的流行歌曲樂譜",
      enabledFunctions: ["find_pop_sheet_music"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_pop_sheet_music",
      provider: "ollama",
      arguments: { query: "Yesterday", matchMode: "fuzzy" }
    });
  });

  it("cleans a wrapped sheet music title when Qwen returns the full request as query", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_pop_sheet_music",
        confidence: 0.84,
        arguments: { query: "小哈 幫我找 A TIME FOR US 的樂譜", fileType: "pdf" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 幫我找 A TIME FOR US 的樂譜",
      enabledFunctions: ["find_pop_sheet_music"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_pop_sheet_music",
      provider: "ollama",
      arguments: { query: "A TIME FOR US", fileType: "pdf" }
    });
  });

  it("keeps generic sheet music keyword fallback queries empty so the function can clarify", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查流行歌曲樂譜",
      enabledFunctions: ["find_pop_sheet_music"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_pop_sheet_music",
      provider: "keyword",
      arguments: { query: "" }
    });
  });

  it("keyword-routes pop sheet music without stealing PPT requests", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const sheetResult = await router.route({
      profileName: "main",
      text: "小哈 查流行歌譜 Yesterday",
      enabledFunctions: ["find_pop_sheet_music", "find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });
    const pptResult = await router.route({
      profileName: "main",
      text: "小哈 查投影片 奇異恩典",
      enabledFunctions: ["find_pop_sheet_music", "find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });
    const wrappedPptResult = await router.route({
      profileName: "main",
      text: "小哈，查奇異恩典的投影片",
      enabledFunctions: ["find_pop_sheet_music", "find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(sheetResult).toMatchObject({
      type: "execute",
      action: "find_pop_sheet_music",
      provider: "keyword",
      arguments: { query: "Yesterday", fileType: "pdf", matchMode: "fuzzy" }
    });
    expect(pptResult).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "keyword",
      arguments: { query: "奇異恩典" }
    });
    expect(wrappedPptResult).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "keyword",
      arguments: { query: "奇異恩典" }
    });
  });

  it("denies invalid Qwen arguments without falling back to keywords", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "find_ppt_slides",
        arguments: { query: "奇異恩典", includePdf: "yes" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片 奇異恩典",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "invalid_arguments",
      provider: "ollama"
    });
  });

  it("denies disabled functions without calling keyword fallback", async () => {
    const qwen = provider(
      JSON.stringify({
        action: "query_service_schedule",
        confidence: 0.9,
        arguments: { query: "服事表" }
      })
    );
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "slides",
      text: "小哈 查服事表",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "function_disabled",
      provider: "ollama"
    });
  });

  it("does not fallback when Qwen explicitly denies", async () => {
    const qwen = provider(JSON.stringify({ action: "deny", reason: "not_matched" }));
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({ type: "deny", reason: "not_matched", provider: "ollama" });
  });

  it("falls back to keyword routing when Qwen returns invalid JSON", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片 奇異恩典",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "keyword",
      arguments: { query: "奇異恩典" }
    });
  });

  it("falls back to greeting small talk when Qwen fails on a greeting", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "你好",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "small_talk",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "invalid_json",
      arguments: { category: "greeting" }
    });
  });

  it("falls back to a capabilities intro when Qwen fails on a capabilities question", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈你能做什麼",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "introduce_bot",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "invalid_json",
      arguments: { variant: "capabilities" }
    });
  });

  it("falls back to a capabilities intro when the addressed question has punctuation", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈，你能做什麼？",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "introduce_bot",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "invalid_json",
      arguments: { variant: "capabilities" }
    });
  });

  it("falls back to a controlled small-talk response when Qwen fails on addressed chat", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈辛苦了",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "small_talk",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "invalid_json",
      arguments: { category: "encouragement" }
    });
  });

  it("falls back to wellbeing small talk when Qwen fails on a check-in", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈你好嗎",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toEqual({
      type: "respond",
      action: "small_talk",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "invalid_json",
      arguments: { category: "wellbeing" }
    });
  });

  it("keeps generic PPT keyword fallback queries empty so the function can clarify", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查投影片",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "user", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "find_ppt_slides",
      provider: "keyword",
      arguments: { query: "" }
    });
  });

  it("falls back to keyword routing when Qwen times out", async () => {
    const qwen: ChatProvider = {
      completeJson: vi.fn().mockRejectedValue(new ProviderResponseError("timeout"))
    };
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查服事表",
      enabledFunctions: ["query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "query_service_schedule",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "timeout",
      arguments: { query: "服事表" }
    });
  });

  it("does not retry the same provider before keyword fallback", async () => {
    const primary: ChatProvider = {
      providerName: "ollama",
      completeJson: vi.fn().mockRejectedValue(new ProviderResponseError("timeout"))
    };
    const modelFallback: ChatProvider = {
      providerName: "ollama",
      completeJson: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ action: "query_service_schedule", arguments: { query: "wrong" } })
        )
    };
    const router = createFunctionRouter({
      primary,
      modelFallback,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查服事表",
      enabledFunctions: ["query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "execute",
      action: "query_service_schedule",
      provider: "keyword",
      fallbackProvider: "ollama",
      fallbackReason: "timeout"
    });
    expect(modelFallback.completeJson).not.toHaveBeenCalled();
  });

  it("does not treat poetry or pop-song keywords as PPT requests", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查詩歌 奇異恩典",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "keyword_no_match",
      provider: "keyword"
    });
  });

  it("denies ambiguous keyword fallback matches", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查服事投影片",
      enabledFunctions: ["find_ppt_slides", "query_service_schedule"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "keyword_ambiguous",
      provider: "keyword"
    });
  });

  it("denies keyword fallback matches for disabled functions", async () => {
    const qwen = provider("not-json");
    const router = createFunctionRouter({
      primary: qwen,
      keywordFallback: createKeywordFallbackRouter(),
      keywordFallbackEnabled: true
    });

    const result = await router.route({
      profileName: "main",
      text: "小哈 查服事表",
      enabledFunctions: ["find_ppt_slides"],
      source: { type: "group", groupId: "C1", userId: "U1" }
    });

    expect(result).toMatchObject({
      type: "deny",
      reason: "function_disabled",
      provider: "keyword"
    });
  });
});
