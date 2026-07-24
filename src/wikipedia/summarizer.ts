import type { TextGenerationProvider } from "../types.js";
import type { WikipediaSummarizer } from "./lookup.js";

export function createWikipediaSummarizer(options: {
  primary: TextGenerationProvider;
  fallback?: TextGenerationProvider;
}): WikipediaSummarizer {
  return async (input) => {
    const request = {
      profileName: input.profileName,
      prompt: [
        "你是受控的維基百科內容整理器。",
        "只可依據提供的維基百科來源回答，不可補充來源未提及的事實。",
        "用繁體中文回答使用者的問題，保持精簡。",
        "如果來源不足以回答，明確說明來源沒有提供答案。"
      ].join("\n"),
      text: [
        `使用者問題：${input.query}`,
        `條目：${input.title} (${input.language})`,
        "維基百科來源：",
        input.extract
      ].join("\n")
    };
    try {
      return sanitizeSummary(await options.primary.completeText(request));
    } catch {
      if (!hasDistinctFallback(options, input.profileName)) {
        throw new Error("wikipedia_summary_unavailable");
      }
      return sanitizeSummary(await options.fallback.completeText(request));
    }
  };
}

function hasDistinctFallback(
  options: {
    primary: TextGenerationProvider;
    fallback?: TextGenerationProvider;
  },
  profileName: string
): options is {
  primary: TextGenerationProvider;
  fallback: TextGenerationProvider;
} {
  const primaryName =
    options.primary.providerNameForProfile?.(profileName) ?? options.primary.providerName;
  const fallbackName =
    options.fallback?.providerNameForProfile?.(profileName) ?? options.fallback?.providerName;
  return Boolean(options.fallback && fallbackName && fallbackName !== primaryName);
}

function sanitizeSummary(value: string): string {
  const summary = value.trim();
  if (!summary) {
    throw new Error("wikipedia_summary_empty");
  }
  return summary;
}
