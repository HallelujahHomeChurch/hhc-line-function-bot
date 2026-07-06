import { FUNCTION_DEFINITIONS, type FunctionDefinition } from "./functions/definitions.js";
import { normalizeFunctionArguments } from "./functions/argument-normalization.js";
import { extractPptSlideQuery } from "./ppt-query.js";
import type { JsonRecord, RouteInput, RouteResult } from "./types.js";

type KeywordRule = FunctionDefinition & {
  keywordFallback: NonNullable<FunctionDefinition["keywordFallback"]>;
};

export interface KeywordFallbackRouter {
  route(input: RouteInput): RouteResult;
}

const rules: KeywordRule[] = FUNCTION_DEFINITIONS.filter((definition): definition is KeywordRule =>
  Boolean(definition.keywordFallback)
);

export function createKeywordFallbackRouter(): KeywordFallbackRouter {
  return {
    route(input: RouteInput): RouteResult {
      const text = input.text.trim();
      const matches = rules.filter((rule) =>
        rule.keywordFallback.keywords.some((keyword) => includesKeyword(text, keyword))
      );

      if (matches.length === 0) {
        return { type: "deny", reason: "keyword_no_match", provider: "keyword" };
      }

      const enabledMatches = matches.filter((match) => input.enabledFunctions.includes(match.name));
      if (enabledMatches.length === 0) {
        return { type: "deny", reason: "function_disabled", provider: "keyword" };
      }

      if (enabledMatches.length > 1) {
        return { type: "deny", reason: "keyword_ambiguous", provider: "keyword" };
      }

      const match = enabledMatches[0];
      return {
        type: "execute",
        action: match.name,
        arguments: extractArguments(match, text),
        provider: "keyword"
      };
    }
  };
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function extractArguments(rule: KeywordRule, text: string): JsonRecord {
  const cleanedQuery =
    rule.name === "find_ppt_slides"
      ? extractPptSlideQuery(text)
      : cleanupQuery(text, rule.keywordFallback.stripWords);
  const query =
    cleanedQuery ||
    (rule.name === "find_ppt_slides" || rule.name === "find_pop_sheet_music" ? "" : text.trim());
  const argumentsRecord: JsonRecord = {
    ...(rule.keywordFallback.defaultArguments ?? {}),
    query
  };
  if (rule.name === "find_ppt_slides") {
    if (includesKeyword(text, "pdf")) {
      argumentsRecord.fileType = "pdf";
    }
  }
  if (rule.name === "find_pop_sheet_music") {
    argumentsRecord.fileType =
      includesKeyword(text, "jpg") || includesKeyword(text, "圖片") ? "image" : "pdf";
  }
  return normalizeFunctionArguments(rule.name, argumentsRecord, { text });
}

function cleanupQuery(text: string, stripWords: string[]): string {
  let result = text;
  for (const word of stripWords) {
    result = result.replaceAll(word, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}
