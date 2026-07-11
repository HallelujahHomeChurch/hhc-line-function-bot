import type { WebSearchClient, WebSearchInput, WebSearchResult } from "../types.js";

export interface SearxngClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface SearxngResponse {
  results?: Array<{
    title?: unknown;
    content?: unknown;
    url?: unknown;
  }>;
}

export function createSearxngClient(options: SearxngClientOptions): WebSearchClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async search(input: WebSearchInput): Promise<WebSearchResult[]> {
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("q", input.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", input.language ?? "zh-TW");
      url.searchParams.set("safesearch", "1");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          signal: controller.signal,
          headers: { accept: "application/json" }
        });
        if (!response.ok) {
          throw new Error(`searxng_http_${response.status}`);
        }
        const payload = (await response.json()) as SearxngResponse;
        return (payload.results ?? [])
          .map(normalizeResult)
          .filter((result): result is WebSearchResult => Boolean(result))
          .slice(0, input.limit ?? 5);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function normalizeResult(
  result: NonNullable<SearxngResponse["results"]>[number]
): WebSearchResult | undefined {
  if (typeof result.title !== "string" || typeof result.url !== "string") {
    return undefined;
  }
  if (!/^https?:\/\//iu.test(result.url)) {
    return undefined;
  }
  const snippet = typeof result.content === "string" ? result.content.trim() : "";
  return {
    title: result.title.trim(),
    ...(snippet ? { snippet } : {}),
    url: result.url
  };
}
