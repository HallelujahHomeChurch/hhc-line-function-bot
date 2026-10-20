import { Client, LogLevel } from "@notionhq/client";

import type { JsonRecord, NotionConfig, NotionDatabaseClient, NotionPage } from "../types.js";

interface NotionQueryResponse {
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionQueryClient {
  databases?: {
    retrieve?: (args: JsonRecord) => Promise<{
      data_sources?: Array<{ id?: string }>;
    }>;
  };
  dataSources?: {
    retrieve?: (args: JsonRecord) => Promise<unknown>;
    query?: (args: JsonRecord) => Promise<NotionQueryResponse>;
  };
}

export function createNotionDatabaseClient(
  config: NotionConfig,
  options: { signal?: AbortSignal; fetch?: typeof fetch; noRetry?: boolean } = {}
): NotionDatabaseClient {
  const client = new Client({
    auth: config.token,
    logLevel: LogLevel.ERROR,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.noRetry ? { retry: false } : {})
  });
  const notion = client as unknown as NotionQueryClient;
  const dataSourceIds = new Map<string, Promise<string>>();

  return {
    async queryDatabase(databaseId: string, query = {}): Promise<NotionPage[]> {
      options.signal?.throwIfAborted();
      const commonQuery = {
        page_size: 25,
        sorts: [
          {
            property: config.properties.date,
            direction: "ascending"
          }
        ],
        ...query
      };
      const dataSourceId = await resolveDataSourceId(
        notion,
        dataSourceIds,
        databaseId,
        options.signal
      );
      options.signal?.throwIfAborted();
      const results: unknown[] = [];
      let startCursor: string | undefined;
      do {
        options.signal?.throwIfAborted();
        const response = await notion.dataSources?.query?.({
          data_source_id: dataSourceId,
          ...commonQuery,
          ...(startCursor ? { start_cursor: startCursor } : {})
        });
        options.signal?.throwIfAborted();
        results.push(...(response?.results ?? []));
        if (response?.has_more && !response.next_cursor) {
          throw new Error("notion_pagination_cursor_missing");
        }
        startCursor = response?.has_more ? (response.next_cursor ?? undefined) : undefined;
      } while (startCursor);

      return results.filter(isNotionPage).map((page) => ({
        id: page.id,
        properties: page.properties as Record<string, unknown>
      }));
    }
  };
}

async function resolveDataSourceId(
  notion: NotionQueryClient,
  cache: Map<string, Promise<string>>,
  databaseOrDataSourceId: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const cached = cache.get(databaseOrDataSourceId);
  if (cached) {
    return cached;
  }

  const resolved = resolveDataSourceIdUncached(notion, databaseOrDataSourceId, signal);
  cache.set(databaseOrDataSourceId, resolved);
  return resolved;
}

async function resolveDataSourceIdUncached(
  notion: NotionQueryClient,
  databaseOrDataSourceId: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  try {
    await notion.dataSources?.retrieve?.({ data_source_id: databaseOrDataSourceId });
    signal?.throwIfAborted();
    return databaseOrDataSourceId;
  } catch {
    signal?.throwIfAborted();
    const database = await notion.databases?.retrieve?.({ database_id: databaseOrDataSourceId });
    signal?.throwIfAborted();
    const dataSourceId = database?.data_sources?.find((source) => source.id)?.id;
    if (!dataSourceId) {
      throw new Error("Notion database has no queryable data source");
    }
    return dataSourceId;
  }
}

function isNotionPage(page: unknown): page is NotionPage {
  return (
    page !== null &&
    typeof page === "object" &&
    "properties" in page &&
    "id" in page &&
    typeof (page as { id?: unknown }).id === "string"
  );
}
