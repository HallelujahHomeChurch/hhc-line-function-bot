import { Client, LogLevel } from "@notionhq/client";

import type { KnowledgeNodeInput } from "../knowledge/store.js";

export interface NotionKnowledgeDocument {
  externalId: string;
  title: string;
  url: string;
  properties: Record<string, unknown>;
  nodes: KnowledgeNodeInput[];
}

export interface NotionKnowledgeClient {
  fetchRoot(rootId: string): Promise<NotionKnowledgeDocument[]>;
}

interface NotionSdk {
  pages: { retrieve(args: { page_id: string }): Promise<Record<string, unknown>> };
  databases: { retrieve(args: { database_id: string }): Promise<Record<string, unknown>> };
  dataSources: { query(args: Record<string, unknown>): Promise<Record<string, unknown>> };
  blocks: { children: { list(args: Record<string, unknown>): Promise<Record<string, unknown>> } };
}

export function createNotionKnowledgeClient(
  token: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; noRetry?: boolean } = {}
): NotionKnowledgeClient {
  const sdk = new Client({
    auth: token,
    logLevel: LogLevel.ERROR,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.noRetry ? { retry: false } : {})
  }) as unknown as NotionSdk;
  return {
    async fetchRoot(rootId: string): Promise<NotionKnowledgeDocument[]> {
      options.signal?.throwIfAborted();
      try {
        const page = await sdk.pages.retrieve({ page_id: rootId });
        options.signal?.throwIfAborted();
        return [await readPageDocument(sdk, page, options.signal)];
      } catch (pageError) {
        options.signal?.throwIfAborted();
        try {
          const database = await sdk.databases.retrieve({ database_id: rootId });
          options.signal?.throwIfAborted();
          const sourceId = dataSourceId(database);
          const pages = await queryAllPages(sdk, sourceId, options.signal);
          options.signal?.throwIfAborted();
          const work = pages.map((page) => readPageDocument(sdk, page, options.signal));
          if (!options.signal) return Promise.all(work);
          const results = await Promise.allSettled(work);
          options.signal.throwIfAborted();
          const documents: NotionKnowledgeDocument[] = [];
          const errors: unknown[] = [];
          for (const result of results) {
            if (result.status === "fulfilled") documents.push(result.value);
            else errors.push(result.reason);
          }
          if (errors.length) throw errors[0];
          return documents;
        } catch {
          options.signal?.throwIfAborted();
          throw sanitizeNotionError(pageError);
        }
      }
    }
  };
}

export function parseNotionRootId(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("notion_url_invalid");
  }
  if (
    !/(^|\.)notion\.so$/iu.test(parsed.hostname) &&
    !/(^|\.)notion\.site$/iu.test(parsed.hostname)
  ) {
    throw new Error("notion_url_invalid");
  }
  const compact =
    parsed.pathname.match(/([0-9a-f]{32})(?:$|\/)/iu)?.[1] ??
    parsed.searchParams.get("p")?.replaceAll("-", "");
  if (!compact || !/^[0-9a-f]{32}$/iu.test(compact)) throw new Error("notion_url_missing_id");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`.toLowerCase();
}

export function notionBlockToKnowledgeNode(
  block: Record<string, unknown>,
  ordinal: number,
  parentExternalId?: string
): KnowledgeNodeInput {
  const id = typeof block.id === "string" ? block.id : `unknown-${ordinal}`;
  const type = typeof block.type === "string" ? block.type : "unsupported";
  const payload = isRecord(block[type]) ? block[type] : {};
  return {
    externalId: id,
    parentExternalId,
    type,
    ordinal,
    text: blockText(type, payload),
    metadata: {}
  };
}

async function readPageDocument(
  sdk: NotionSdk,
  page: Record<string, unknown>,
  signal?: AbortSignal
): Promise<NotionKnowledgeDocument> {
  signal?.throwIfAborted();
  const externalId = String(page.id);
  return {
    externalId,
    title: pageTitle(page.properties),
    url: typeof page.url === "string" ? page.url : "",
    properties: isRecord(page.properties) ? page.properties : {},
    nodes: await readBlocks(sdk, externalId, signal)
  };
}

async function readBlocks(
  sdk: NotionSdk,
  rootId: string,
  signal?: AbortSignal
): Promise<KnowledgeNodeInput[]> {
  const nodes: KnowledgeNodeInput[] = [];
  const visit = async (blockId: string, parentExternalId?: string): Promise<void> => {
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const response = await sdk.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {})
      });
      signal?.throwIfAborted();
      const results = Array.isArray(response.results) ? response.results.filter(isRecord) : [];
      for (const block of results) {
        signal?.throwIfAborted();
        const node = notionBlockToKnowledgeNode(block, nodes.length, parentExternalId);
        nodes.push(node);
        if (block.has_children === true) await visit(node.externalId, node.externalId);
      }
      cursor =
        response.has_more === true && typeof response.next_cursor === "string"
          ? response.next_cursor
          : undefined;
    } while (cursor);
  };
  await visit(rootId);
  return nodes;
}

async function queryAllPages(
  sdk: NotionSdk,
  sourceId: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  const pages: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const response = await sdk.dataSources.query({
      data_source_id: sourceId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });
    signal?.throwIfAborted();
    if (Array.isArray(response.results)) pages.push(...response.results.filter(isRecord));
    cursor =
      response.has_more === true && typeof response.next_cursor === "string"
        ? response.next_cursor
        : undefined;
  } while (cursor);
  return pages;
}

function dataSourceId(database: Record<string, unknown>): string {
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources.filter(isRecord)
    : [];
  const id = sources.find((source) => typeof source.id === "string")?.id;
  if (typeof id !== "string") throw new Error("notion_data_source_missing");
  return id;
}

function pageTitle(properties: unknown): string {
  if (!isRecord(properties)) return "未命名頁面";
  for (const value of Object.values(properties)) {
    if (!isRecord(value) || value.type !== "title" || !Array.isArray(value.title)) continue;
    const title = richText(value.title);
    if (title) return title;
  }
  return "未命名頁面";
}

function blockText(type: string, payload: Record<string, unknown>): string {
  if (type === "table_row" && Array.isArray(payload.cells))
    return payload.cells.map((cell) => richText(cell)).join(" | ");
  if (typeof payload.title === "string") return payload.title;
  if (Array.isArray(payload.rich_text)) return richText(payload.rich_text);
  if (isRecord(payload.caption)) return richText(payload.caption);
  return "";
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .map((item) => (typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("")
    .trim();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sanitizeNotionError(error: unknown): Error {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "unavailable";
  return new Error(`notion_knowledge_${code}`);
}
