import { createHash } from "node:crypto";

import type { FunctionHandler } from "../types.js";
import type { WikipediaArticle, WikipediaClient, WikipediaSearchResult } from "./client.js";

export interface WikipediaSummaryInput {
  profileName: string;
  query: string;
  title: string;
  language: "zh" | "en";
  extract: string;
}

export type WikipediaSummarizer = (input: WikipediaSummaryInput) => Promise<string>;

export interface CreateWikipediaLookupHandlerOptions {
  client: WikipediaClient;
  summarize: WikipediaSummarizer;
}

export function createWikipediaLookupHandler(
  options: CreateWikipediaLookupHandlerOptions
): FunctionHandler {
  return async (rawArgs, context) => {
    const query = typeof rawArgs.query === "string" ? rawArgs.query.trim() : "";
    if (!query) {
      return {
        ok: true,
        replyText: "想查哪個維基百科主題？",
        agentResult: {
          status: "ambiguous",
          replyText: "想查哪個維基百科主題？",
          clarification: { prompt: "想查哪個維基百科主題？" }
        }
      };
    }

    const zh = await options.client.search("zh", query, 3);
    const matches = zh.length > 0 ? zh : await options.client.search("en", query, 3);
    if (matches.length === 0) {
      return {
        ok: true,
        replyText: "維基百科查不到相關資料。",
        agentResult: { status: "not_found", replyText: "維基百科查不到相關資料。" }
      };
    }

    const selected = selectBestMatch(matches, query);
    const article = await options.client.getIntro(selected.language, selected.title);
    if (!article) {
      return {
        ok: true,
        replyText: "維基百科暫時找不到可整理的條目內容。",
        agentResult: {
          status: "unavailable",
          replyText: "維基百科暫時找不到可整理的條目內容。"
        }
      };
    }

    const summary = await options.summarize(toSummaryInput(context.profile.name, query, article));
    const pageId = opaquePageId(article);
    return {
      ok: true,
      replyText: [article.title, summary.trim(), `來源：${article.articleUrl}`]
        .filter(Boolean)
        .join("\n"),
      responseData: {
        kind: "wikipedia",
        fields: { answer: summary.trim(), summary: summary.trim() }
      },
      agentResult: {
        status: "success",
        replyText: "維基百科查詢完成。",
        anchors: { language: article.language },
        entities: [{ type: "topic", key: pageId, label: "維基百科主題" }],
        evidence: [{ kind: "wikipedia_page", reference: { pageId } }],
        supportedOperations: []
      }
    };
  };
}

function opaquePageId(article: WikipediaArticle): string {
  return createHash("sha256")
    .update(`${article.language}:${article.title.normalize("NFKC")}`)
    .digest("hex")
    .slice(0, 24);
}

function selectBestMatch(matches: WikipediaSearchResult[], query: string): WikipediaSearchResult {
  const normalizedQuery = normalize(query);
  return matches.find((match) => normalize(match.title) === normalizedQuery) ?? matches[0]!;
}

function toSummaryInput(
  profileName: string,
  query: string,
  article: WikipediaArticle
): WikipediaSummaryInput {
  return {
    profileName,
    query,
    title: article.title,
    language: article.language,
    extract: article.extract
  };
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·・._-]/gu, "");
}
