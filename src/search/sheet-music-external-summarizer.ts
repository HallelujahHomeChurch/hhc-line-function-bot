import type { TextGenerationProvider, WebSearchResult } from "../types.js";

export interface SheetMusicExternalSearchSummaryInput {
  profileName: string;
  query: string;
  results: WebSearchResult[];
}

export type SheetMusicExternalSearchSummarizer = (
  input: SheetMusicExternalSearchSummaryInput
) => Promise<string>;

export function createSheetMusicExternalSearchSummarizer(options: {
  primary: TextGenerationProvider;
  fallback?: TextGenerationProvider;
}): SheetMusicExternalSearchSummarizer {
  return async (input) => {
    const request = {
      profileName: input.profileName,
      prompt: [
        "你是受控的歌譜公開搜尋結果整理器。",
        "只可根據提供的搜尋結果 title、snippet、url 排序與摘要。",
        "不可宣稱已讀取網頁全文，不可下載檔案，不可建議自動保存。",
        "用繁體中文精簡回答，最多列 3 個可能相關結果。"
      ].join("\n"),
      text: [
        `使用者要找的歌譜：${input.query}`,
        "公開搜尋結果：",
        ...input.results.map((result, index) =>
          [
            `${index + 1}. ${result.title}`,
            result.snippet ? `摘要：${result.snippet}` : undefined,
            `網址：${result.url}`
          ]
            .filter(Boolean)
            .join("\n")
        )
      ].join("\n\n"),
      maxChars: 700
    };
    try {
      return sanitizeSummary(await options.primary.completeText(request));
    } catch {
      if (!options.fallback || options.fallback === options.primary) {
        throw new Error("sheet_music_external_summary_unavailable");
      }
      return sanitizeSummary(await options.fallback.completeText(request));
    }
  };
}

function sanitizeSummary(value: string): string {
  const summary = value.trim();
  if (!summary) {
    throw new Error("sheet_music_external_summary_empty");
  }
  return summary;
}
