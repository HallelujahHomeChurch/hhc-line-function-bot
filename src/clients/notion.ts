import { Client } from "@notionhq/client";

import type { JsonRecord, NotionConfig, NotionDatabaseClient, NotionPage } from "../types.js";

interface NotionQueryResponse {
  results?: unknown[];
}

interface NotionQueryClient {
  databases?: {
    query?: (args: JsonRecord) => Promise<NotionQueryResponse>;
  };
  dataSources?: {
    query?: (args: JsonRecord) => Promise<NotionQueryResponse>;
  };
}

export function createNotionDatabaseClient(config: NotionConfig): NotionDatabaseClient {
  const client = new Client({ auth: config.token });

  return {
    async queryDatabase(databaseId: string, query = {}): Promise<NotionPage[]> {
      const notion = client as unknown as NotionQueryClient;
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
      const response = notion.databases?.query
        ? await notion.databases.query({ database_id: databaseId, ...commonQuery })
        : await notion.dataSources?.query?.({ data_source_id: databaseId, ...commonQuery });

      return (response?.results ?? []).filter(isNotionPage).map((page) => ({
        id: page.id,
        properties: page.properties as Record<string, unknown>
      }));
    }
  };
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
