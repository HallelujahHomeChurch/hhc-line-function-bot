import { randomUUID } from "node:crypto";

import type { CacheStore } from "../cache/cache-store.js";
import type { AgentMemoryStore, AgentResourceRecord } from "../agent/memory-store.js";
import {
  catalogSourceAllowsRead,
  type CatalogItemRecord,
  type CatalogStore
} from "../catalog/store.js";
import type { SheetMusicExternalSearchSummarizer } from "../search/sheet-music-external-summarizer.js";
import type { ExternalBinaryClient } from "../clients/external-binary.js";
import {
  findPopSheetMusicArgumentsSchema,
  type FindPopSheetMusicArguments
} from "../function-arguments.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import { withRequesterDisplayName } from "../requester-personalization.js";
import { canCreateRequesterScopedSession } from "../state/session-safety.js";
import {
  InMemorySessionStore,
  type ConversationSession,
  type ExternalSheetMusicImportSession,
  type SessionStore
} from "../state/session-store.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import type { ResourceBinaryPublisher } from "./resource-binary-publisher.js";
import type {
  DriveItem,
  FunctionExecutionResult,
  FunctionHandler,
  FunctionHandlerContext,
  GraphDriveClient,
  PostbackHandler,
  TextMessageContext,
  TextMessageHandler,
  FunctionName,
  JsonRecord,
  WebSearchClient,
  WebSearchResult
} from "../types.js";

const POSTBACK_ACTION = "select_sheet_music";
const EXTERNAL_SEARCH_ACTION = "sheet_music_external_search";
const MAX_CANDIDATES = 5;
const SELECTION_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_SEARCH_CONSENT_TTL_MS = 10 * 60 * 1000;
const FILE_INDEX_TTL_MS = 30 * 60 * 1000;
const MIN_FUZZY_SCORE = 0.42;
const INVALID_SELECTION_MESSAGE = "請只回覆清單中的數字，例如：1。不要加上其他字。";
export const SHEET_MUSIC_INDEX_CACHE_PREFIX = "sheet-music-index:";

export interface FindPopSheetMusicOptions {
  graph: GraphDriveClient;
  catalog?: CatalogStore;
  driveId: string;
  folderItemId?: string;
  folderPath?: string;
  allowedExtensions: string[];
  recursive?: boolean;
  memoryStore?: AgentMemoryStore;
  cache?: CacheStore;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
  functionName?: Extract<FunctionName, "find_sheet_music">;
  externalSearch?: SheetMusicExternalSearchOptions;
}

export interface FindPopSheetMusicPostbackOptions {
  graph: GraphDriveClient;
  sessionStore: SessionStore;
  now?: () => Date;
}

export interface SheetMusicExternalSearchOptions {
  webSearch: WebSearchClient;
  summarize: SheetMusicExternalSearchSummarizer;
}

export type FindPopSheetMusicTextMessageOptions = FindPopSheetMusicPostbackOptions & {
  externalSearch?: SheetMusicExternalSearchOptions;
  externalImport?: {
    client: ExternalBinaryClient;
    publisher: ResourceBinaryPublisher;
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
  };
};

interface ScoredItem {
  item: DriveItem;
  score: number;
}

type SheetMusicCandidate =
  | {
      kind: "memory";
      resource: AgentResourceRecord;
    }
  | {
      kind: "graph";
      item: DriveItem;
    };

type SheetMusicMatchMode = NonNullable<FindPopSheetMusicArguments["matchMode"]>;

export function createFindPopSheetMusicHandler(options: FindPopSheetMusicOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const configuredExtensions = normalizeExtensions(options.allowedExtensions);
  const sessionStore =
    options.sessionStore ?? new InMemorySessionStore({ now, ttlMs: SELECTION_TTL_MS });
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const functionName = options.functionName ?? "find_sheet_music";

  return async (rawArgs, context) => {
    const args = findPopSheetMusicArgumentsSchema.parse(rawArgs);
    const rawQuery = args.query.trim();

    if (args.driveId && args.itemId) {
      return createSharingLinkReply(
        options.graph,
        { id: args.itemId, driveId: args.driveId, name: "歌譜" },
        now(),
        args.resourceId ?? args.itemId
      );
    }

    if (!rawQuery) {
      await storePendingFunctionQuery({
        sessionStore,
        requestId: requestIdFactory(),
        action: functionName,
        arguments: args,
        context,
        now: now()
      });
      return {
        ok: true,
        replyText: withRequesterDisplayName(context, "要查哪一首流行歌譜？請直接回覆歌名或歌手。"),
        agentResult: {
          status: "ambiguous",
          replyText: "要查哪一首歌的歌譜？請直接回覆歌名或歌手。",
          clarification: { prompt: "要查哪一首歌的歌譜？請直接回覆歌名或歌手。" }
        }
      };
    }

    const remembered = await findRememberedSheetMusic(options.memoryStore, rawQuery, context);
    const exactRemembered = remembered.find((resource) =>
      resourceMatchesQueryExactly(resource, rawQuery)
    );
    if (exactRemembered) {
      return createRememberedResourceReply(options.graph, exactRemembered, now());
    }

    const extensions = resolveSearchExtensions(configuredExtensions, args);
    const catalogItems = await findCatalogSheetMusic(
      options.catalog,
      context.profile.name,
      rawQuery,
      extensions
    );
    if (catalogItems.length > 0) {
      const candidates: SheetMusicCandidate[] = [
        ...remembered.map((resource) => ({ kind: "memory" as const, resource })),
        ...catalogItems.map((item) => ({
          kind: "graph" as const,
          item: catalogItemToDriveItem(item)
        }))
      ].slice(0, MAX_CANDIDATES);

      if (candidates.length === 1) {
        return createSheetMusicCandidateReply(options.graph, candidates[0], now());
      }

      if (!canCreateRequesterScopedSession(context.event.source)) {
        return {
          ok: true,
          replyText: "找到多個相近的樂譜，請提供更完整歌名或歌手。",
          agentResult: sheetMusicAmbiguousEnvelope(candidates)
        };
      }

      const requestId = requestIdFactory();
      await sessionStore.set({
        id: requestId,
        type: "selection",
        action: POSTBACK_ACTION,
        profileName: context.profile.name,
        requesterUserId: context.event.source.userId,
        source: context.event.source,
        items: candidates.map(toSelectionItem),
        expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString()
      });

      return {
        ok: true,
        replyText: [
          withRequesterDisplayName(context, "找到多個相近的樂譜，請選擇："),
          ...candidates.map((candidate, index) => `${index + 1}. ${candidateName(candidate)}`)
        ].join("\n"),
        quickReplies: candidates.map((_candidate, index) =>
          buildPostbackQuickReply(
            String(index + 1),
            new URLSearchParams({
              action: POSTBACK_ACTION,
              requestId,
              index: String(index)
            }).toString()
          )
        ),
        agentResult: sheetMusicAmbiguousEnvelope(candidates)
      };
    }

    if (options.catalog) {
      return createSheetMusicNotFoundResult({
        args,
        context,
        externalSearch: options.externalSearch,
        now: now(),
        rawQuery,
        requestIdFactory,
        sessionStore
      });
    }

    const root = await resolveSheetMusicRoot(options);
    const allItems = await getCachedFileIndex(options, root);
    const graphCandidates = rankSheetMusicCandidates(
      allItems,
      rawQuery,
      args.artist,
      extensions,
      args.matchMode ?? "fuzzy"
    );
    const candidates: SheetMusicCandidate[] = [
      ...remembered.map((resource) => ({ kind: "memory" as const, resource })),
      ...graphCandidates.map(({ item }) => ({ kind: "graph" as const, item }))
    ].slice(0, MAX_CANDIDATES);

    if (candidates.length === 0) {
      return createSheetMusicNotFoundResult({
        args,
        context,
        externalSearch: options.externalSearch,
        now: now(),
        rawQuery,
        requestIdFactory,
        sessionStore
      });
    }

    if (candidates.length === 1) {
      return createSheetMusicCandidateReply(options.graph, candidates[0], now());
    }

    if (!canCreateRequesterScopedSession(context.event.source)) {
      return {
        ok: true,
        replyText: "找到多個相近的樂譜，請提供更完整歌名或歌手。",
        agentResult: sheetMusicAmbiguousEnvelope(candidates)
      };
    }

    const requestId = requestIdFactory();
    await sessionStore.set({
      id: requestId,
      type: "selection",
      action: POSTBACK_ACTION,
      profileName: context.profile.name,
      requesterUserId: context.event.source.userId,
      source: context.event.source,
      items: candidates.map(toSelectionItem),
      expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString()
    });

    return {
      ok: true,
      replyText: [
        withRequesterDisplayName(context, "找到多個相近的樂譜，請選擇："),
        ...candidates.map((candidate, index) => `${index + 1}. ${candidateName(candidate)}`)
      ].join("\n"),
      quickReplies: candidates.map((_candidate, index) =>
        buildPostbackQuickReply(
          String(index + 1),
          new URLSearchParams({
            action: POSTBACK_ACTION,
            requestId,
            index: String(index)
          }).toString()
        )
      ),
      agentResult: sheetMusicAmbiguousEnvelope(candidates)
    };
  };
}

async function createSheetMusicNotFoundResult(options: {
  args: FindPopSheetMusicArguments;
  context: FunctionHandlerContext;
  externalSearch?: SheetMusicExternalSearchOptions;
  now: Date;
  rawQuery: string;
  requestIdFactory: () => string;
  sessionStore: SessionStore;
}): Promise<FunctionExecutionResult> {
  if (options.externalSearch && canCreateRequesterScopedSession(options.context.event.source)) {
    const requestId = options.requestIdFactory();
    await options.sessionStore.set({
      id: requestId,
      type: "external_search_consent",
      action: EXTERNAL_SEARCH_ACTION,
      profileName: options.context.profile.name,
      requesterUserId: options.context.event.source.userId,
      source: options.context.event.source,
      query: options.rawQuery,
      arguments: options.args,
      expiresAt: new Date(options.now.getTime() + EXTERNAL_SEARCH_CONSENT_TTL_MS).toISOString()
    });
    return {
      ok: true,
      replyText: [
        "本地歌譜資料庫找不到符合的結果。",
        "要不要上網找公開搜尋結果？",
        "我只會查看搜尋結果的標題、摘要與網址，不會下載或保存檔案。"
      ].join("\n"),
      quickReplies: externalSearchConsentQuickReplies(),
      agentResult: { status: "not_found", replyText: "本地歌譜資料庫找不到符合的結果。" }
    };
  }
  return {
    ok: true,
    replyText: "找不到符合的流行歌曲樂譜，請提供更完整英文歌名或歌手。",
    quickReplies: [
      {
        label: "重新查歌譜",
        action: { type: "message", label: "重新查歌譜", text: "小哈 查流行歌譜" }
      },
      {
        label: "查圖片歌譜",
        action: {
          type: "message",
          label: "查圖片歌譜",
          text: "小哈 查流行歌譜 圖片"
        }
      }
    ],
    agentResult: {
      status: "not_found",
      replyText: "找不到符合的流行歌曲樂譜，請提供更完整英文歌名或歌手。"
    }
  };
}

export function createFindPopSheetMusicPostbackHandler(
  options: FindPopSheetMusicPostbackOptions
): PostbackHandler {
  const now = options.now ?? (() => new Date());

  return async (request, context) => {
    if (!sheetMusicFunctionEnabled(context.profile.enabledFunctions)) {
      return { ok: true, replyText: "這個功能目前沒有開放。" };
    }

    const selectedIndex = Number(request.params.index);

    if (
      request.action !== POSTBACK_ACTION ||
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 0
    ) {
      return { ok: true, replyText: "這個選擇已失效，請重新查詢。" };
    }

    return selectSheetMusicCandidate({
      graph: options.graph,
      sessionStore: options.sessionStore,
      session: await options.sessionStore.get(request.params.requestId),
      selectedIndex,
      context,
      now: now()
    });
  };
}

export function createFindPopSheetMusicTextMessageHandler(
  options: FindPopSheetMusicTextMessageOptions
): TextMessageHandler {
  const now = options.now ?? (() => new Date());

  return {
    turnStage: "resolution",
    matches: async (request, context) =>
      sheetMusicFunctionEnabled(context.profile.enabledFunctions) &&
      (Boolean(
        numericSelectionToIndex(request.text) !== undefined &&
        (await findSheetMusicSelection(options.sessionStore, context))
      ) ||
        Boolean(await findSheetMusicExternalSearchConsent(options.sessionStore, context)) ||
        Boolean(await findExternalSheetMusicImport(options.sessionStore, context))),

    handle: async (request, context) => {
      const externalImport = await findExternalSheetMusicImport(options.sessionStore, context);
      if (externalImport) {
        return continueExternalSheetMusicImport({
          options,
          session: externalImport,
          text: request.text,
          context,
          now: now()
        });
      }
      const selectedIndex = numericSelectionToIndex(request.text);
      if (selectedIndex !== undefined) {
        const session = await findSheetMusicSelection(options.sessionStore, context);
        if (session) {
          return selectSheetMusicCandidate({
            graph: options.graph,
            sessionStore: options.sessionStore,
            session,
            selectedIndex,
            context,
            now: now(),
            invalidSelectionMessage: INVALID_SELECTION_MESSAGE
          });
        }
      }
      const externalSearchConsent = await findSheetMusicExternalSearchConsent(
        options.sessionStore,
        context
      );
      if (!externalSearchConsent) {
        return undefined;
      }
      if (isExternalSearchCancel(request.text)) {
        await options.sessionStore.delete(externalSearchConsent.id);
        return { ok: true, replyText: "好，我不做外部搜尋。" };
      }
      if (!isExternalSearchConfirm(request.text)) {
        return {
          ok: true,
          replyText: "請回覆「上網找」或「不用」。",
          quickReplies: externalSearchConsentQuickReplies()
        };
      }
      await options.sessionStore.delete(externalSearchConsent.id);
      return runExternalSheetMusicSearch({
        externalSearch: options.externalSearch,
        profileName: context.profile.name,
        query: externalSearchConsent.query,
        sessionStore: options.sessionStore,
        context,
        now: now(),
        requestId: externalSearchConsent.id,
        requestedKind: inferRequestedSheetKind(externalSearchConsent.query)
      });
    }
  };
}

function sheetMusicFunctionEnabled(enabledFunctions: FunctionName[]): boolean {
  return enabledFunctions.includes("find_sheet_music");
}

async function findRememberedSheetMusic(
  memoryStore: AgentMemoryStore | undefined,
  query: string,
  context: FunctionHandlerContext
): Promise<AgentResourceRecord[]> {
  const resources = await memoryStore?.searchResources({
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId,
    query,
    resourceTypes: ["sheet_music"],
    limit: MAX_CANDIDATES
  });
  return resources ?? [];
}

async function createRememberedResourceReply(
  graph: GraphDriveClient,
  resource: AgentResourceRecord,
  now: Date
): Promise<FunctionExecutionResult> {
  return createRememberedReferenceReply(
    graph,
    {
      resourceType: resource.resourceType,
      title: resource.title,
      query: resource.query,
      storage: resource.storage
    },
    now,
    resource.id
  );
}

async function createRememberedReferenceReply(
  graph: GraphDriveClient,
  resource: {
    resourceType: AgentResourceRecord["resourceType"];
    title: string;
    query?: string;
    storage: AgentResourceRecord["storage"];
  },
  now: Date,
  resourceId: string
): Promise<FunctionExecutionResult> {
  if (resource.storage.provider === "external_link") {
    return {
      ok: true,
      replyText: ["已找到我記住的流行歌曲樂譜：", resource.title, resource.storage.url].join("\n"),
      agentResource: {
        resourceType: resource.resourceType,
        title: resource.title,
        query: resource.query,
        storage: resource.storage
      },
      responseData: {
        kind: "resource",
        fields: { title: resource.title, link: resource.storage.url }
      },
      agentResult: sheetMusicSuccessEnvelope(resourceId, { resourceId })
    };
  }
  return createSharingLinkReply(
    graph,
    { id: resource.storage.itemId, driveId: resource.storage.driveId, name: resource.title },
    now,
    resourceId
  );
}

function createSheetMusicCandidateReply(
  graph: GraphDriveClient,
  candidate: SheetMusicCandidate,
  now: Date
): Promise<FunctionExecutionResult> {
  if (candidate.kind === "memory") {
    return createRememberedResourceReply(graph, candidate.resource, now);
  }
  return createSharingLinkReply(graph, candidate.item, now);
}

function toSelectionItem(candidate: SheetMusicCandidate) {
  if (candidate.kind === "memory") {
    return {
      id: candidate.resource.id,
      name: candidate.resource.title,
      memoryResource: {
        resourceType: candidate.resource.resourceType,
        title: candidate.resource.title,
        query: candidate.resource.query,
        storage: candidate.resource.storage
      }
    };
  }
  return {
    id: candidate.item.id,
    driveId: candidate.item.driveId,
    name: candidate.item.name
  };
}

function candidateName(candidate: SheetMusicCandidate): string {
  return candidate.kind === "memory" ? candidate.resource.title : candidate.item.name;
}

function resourceMatchesQueryExactly(resource: AgentResourceRecord, rawQuery: string): boolean {
  const query = normalizeSearchText(rawQuery);
  return [resource.title, resource.query]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => normalizeSearchText(value) === query);
}

async function findCatalogSheetMusic(
  catalog: CatalogStore | undefined,
  profileName: string,
  query: string,
  extensions: string[]
): Promise<CatalogItemRecord[]> {
  if (!catalog) {
    return [];
  }
  const items = await catalog.searchItems({
    profileName,
    query,
    itemKinds: ["pop_sheet", "hymn_sheet"],
    domains: ["sheet_music"],
    limit: MAX_CANDIDATES
  });
  return items
    .filter((item) => catalogSourceAllowsRead(item.source, [profileName, "find_sheet_music"]))
    .filter((item) => item.storageRef.provider === "graph")
    .filter((item) => extensions.some((extension) => catalogItemExtension(item) === extension));
}

function catalogItemToDriveItem(item: CatalogItemRecord): DriveItem {
  if (item.storageRef.provider !== "graph") {
    throw new Error("catalog_item_not_graph");
  }
  return {
    id: item.storageRef.itemId,
    driveId: item.storageRef.driveId,
    name: item.title,
    path: item.path
  };
}

function catalogItemExtension(item: CatalogItemRecord): string {
  return (item.extension || item.title.match(/\.[a-z0-9]+$/iu)?.[0] || "").toLowerCase();
}

async function resolveSheetMusicRoot(options: FindPopSheetMusicOptions) {
  if (options.folderItemId) {
    return { driveId: options.driveId, itemId: options.folderItemId };
  }
  if (!options.folderPath || !options.graph.getItemByPath) {
    throw new Error("sheet_music_folder_not_configured");
  }
  const item = await options.graph.getItemByPath(options.driveId, options.folderPath);
  if (!item?.id) {
    throw new Error("sheet_music_folder_not_found");
  }
  return {
    driveId: item.remoteItem?.parentReference?.driveId ?? item.driveId ?? options.driveId,
    itemId: item.remoteItem?.id ?? item.id
  };
}

async function getCachedFileIndex(
  options: FindPopSheetMusicOptions,
  root: { driveId: string; itemId: string }
): Promise<DriveItem[]> {
  const cacheKey = `sheet-music-index:${root.driveId}:${root.itemId}`;
  const cached = await options.cache?.get<DriveItem[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const items =
    options.recursive !== false && options.graph.listFolderFilesRecursive
      ? await options.graph.listFolderFilesRecursive(root.driveId, root.itemId)
      : await options.graph.listFolderChildren(root.driveId, root.itemId);
  const indexedItems = items.map((item) => ({ ...item, driveId: item.driveId ?? root.driveId }));
  await options.cache?.set(cacheKey, indexedItems, FILE_INDEX_TTL_MS);
  return indexedItems;
}

async function selectSheetMusicCandidate(options: {
  graph: GraphDriveClient;
  sessionStore: SessionStore;
  session: ConversationSession | undefined;
  selectedIndex: number;
  context: FunctionHandlerContext;
  now: Date;
  invalidSelectionMessage?: string;
}) {
  const { graph, sessionStore, session, selectedIndex, context, now, invalidSelectionMessage } =
    options;

  if (
    !session ||
    session.type !== "selection" ||
    session.action !== POSTBACK_ACTION ||
    session.profileName !== context.profile.name ||
    !sourceMatches(session.source, context.event.source) ||
    (session.requesterUserId && session.requesterUserId !== context.event.source.userId)
  ) {
    return { ok: true, replyText: "這個選擇已失效，請重新查詢。" };
  }

  const item = session.items[selectedIndex];
  if (!item) {
    return { ok: true, replyText: invalidSelectionMessage ?? "這個選擇已失效，請重新查詢。" };
  }

  await sessionStore.delete(session.id);
  if (item.memoryResource) {
    return createRememberedReferenceReply(graph, item.memoryResource, now, item.id);
  }
  return createSharingLinkReply(graph, item, now);
}

async function createSharingLinkReply(
  graph: GraphDriveClient,
  item: Pick<DriveItem, "id" | "name" | "driveId">,
  now: Date,
  resourceId = item.id
): Promise<FunctionExecutionResult> {
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const link = await graph.createSharingLink(item.driveId ?? "", item.id, expiresAt);

  return {
    ok: true,
    replyText: ["已找到流行歌曲樂譜：", item.name, "下載連結（1 天內有效）：", link].join("\n"),
    agentResource: {
      resourceType: "sheet_music",
      title: item.name,
      storage: { provider: "graph", driveId: item.driveId ?? "", itemId: item.id }
    },
    responseData: { kind: "resource", fields: { title: item.name, link } },
    agentResult: sheetMusicSuccessEnvelope(resourceId, {
      resourceId,
      driveId: item.driveId ?? "",
      itemId: item.id
    })
  };
}

function sheetMusicSuccessEnvelope(resourceId: string, reference: JsonRecord) {
  return {
    status: "success" as const,
    replyText: "歌譜查詢完成。",
    entities: [{ type: "resource", key: resourceId, label: "歌譜資源" }],
    evidence: [{ kind: "catalog_item", reference }],
    supportedOperations: ["continue", "refine", "view_full"]
  };
}

function sheetMusicAmbiguousEnvelope(candidates: SheetMusicCandidate[]) {
  return {
    status: "ambiguous" as const,
    replyText: "找到多個相近的歌譜，請選擇。",
    entities: candidates.map((candidate) => ({
      type: "resource",
      key: candidate.kind === "memory" ? candidate.resource.id : candidate.item.id,
      label: "歌譜資源"
    })),
    clarification: { prompt: "找到多個相近的歌譜，請選擇。" }
  };
}

function rankSheetMusicCandidates(
  items: DriveItem[],
  rawQuery: string,
  artist: string | undefined,
  extensions: string[],
  matchMode: SheetMusicMatchMode
): ScoredItem[] {
  const query = normalizeSearchText(rawQuery);
  const normalizedArtist = normalizeSearchText(artist ?? "");

  return items
    .filter((item) => extensions.some((extension) => item.name.toLowerCase().endsWith(extension)))
    .map((item) => ({
      item,
      score: scoreCandidate(query, normalizedArtist, item, matchMode)
    }))
    .filter(({ score }) => score >= MIN_FUZZY_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CANDIDATES);
}

function scoreCandidate(
  query: string,
  artist: string,
  item: DriveItem,
  matchMode: SheetMusicMatchMode
): number {
  const normalizedName = normalizeSearchText(item.name);
  const queryScore = normalizedName.includes(query) ? 1 : diceCoefficient(query, normalizedName);
  const artistBoost = artist && normalizedName.includes(artist) ? 0.08 : 0;

  if (normalizedName.includes(query)) {
    return Math.min(1, queryScore + artistBoost);
  }
  if (matchMode === "exact") {
    return 0;
  }
  return Math.min(0.99, queryScore + artistBoost);
}

function resolveSearchExtensions(
  configuredExtensions: string[],
  args: FindPopSheetMusicArguments
): string[] {
  switch (args.fileType ?? "any") {
    case "pdf":
      return configuredExtensions.filter((extension) => extension === ".pdf");
    case "image":
      return configuredExtensions.filter((extension) =>
        [".jpg", ".jpeg", ".png", ".gif"].includes(extension)
      );
    case "any":
      return configuredExtensions;
    default:
      return configuredExtensions;
  }
}

async function findSheetMusicSelection(sessionStore: SessionStore, context: TextMessageContext) {
  return sessionStore.findSelection({
    action: POSTBACK_ACTION,
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId
  });
}

async function findSheetMusicExternalSearchConsent(
  sessionStore: SessionStore,
  context: TextMessageContext
) {
  return sessionStore.findExternalSearchConsent({
    action: EXTERNAL_SEARCH_ACTION,
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId
  });
}

async function runExternalSheetMusicSearch(input: {
  externalSearch: SheetMusicExternalSearchOptions | undefined;
  profileName: string;
  query: string;
  sessionStore: SessionStore;
  context: TextMessageContext;
  now: Date;
  requestId: string;
  requestedKind?: "pop_sheet" | "hymn_sheet";
}): Promise<FunctionExecutionResult> {
  if (!input.externalSearch) {
    return { ok: true, replyText: "外部搜尋目前沒有設定。" };
  }
  let results: WebSearchResult[];
  try {
    results = await input.externalSearch.webSearch.search({
      query: `${input.query} 歌譜`,
      limit: MAX_CANDIDATES,
      language: "zh-TW"
    });
  } catch {
    return { ok: true, replyText: "外部搜尋目前不可用，請稍後再試。" };
  }
  if (results.length === 0) {
    return { ok: true, replyText: "公開搜尋結果也找不到相關歌譜。" };
  }
  try {
    const summary = await input.externalSearch.summarize({
      profileName: input.profileName,
      query: input.query,
      results
    });
    const items = results.slice(0, MAX_CANDIDATES);
    await input.sessionStore.set({
      id: input.requestId,
      type: "external_sheet_music_import",
      stage: "selecting",
      profileName: input.profileName,
      requesterUserId: input.context.event.source.userId,
      source: input.context.event.source,
      query: input.query,
      requestedKind: input.requestedKind,
      items,
      expiresAt: new Date(input.now.getTime() + SELECTION_TTL_MS).toISOString()
    });
    return {
      ok: true,
      replyText: [
        "公開搜尋結果（尚未下載或保存）：",
        summary,
        "可回覆編號選擇：",
        ...items.map((item, index) => `${index + 1}. ${item.title}\n${item.url}`)
      ].join("\n")
    };
  } catch {
    return { ok: true, replyText: "外部搜尋整理目前不可用，請稍後再試。" };
  }
}

async function findExternalSheetMusicImport(
  sessionStore: SessionStore,
  context: TextMessageContext
) {
  return sessionStore.findExternalSheetMusicImport({
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId
  });
}

async function continueExternalSheetMusicImport(input: {
  options: FindPopSheetMusicTextMessageOptions;
  session: ExternalSheetMusicImportSession;
  text: string;
  context: TextMessageContext;
  now: Date;
}): Promise<FunctionExecutionResult> {
  if (isExternalSearchCancel(input.text)) {
    await input.options.sessionStore.delete(input.session.id);
    return { ok: true, replyText: "好，我不保存這個搜尋結果。" };
  }
  if (
    input.session.stage !== "selecting" &&
    !input.context.profile.enabledFunctions.includes("save_resource")
  ) {
    await input.options.sessionStore.delete(input.session.id);
    return { ok: true, replyText: "目前沒有保存檔案的權限。" };
  }

  if (input.session.stage === "selecting") {
    const selectedIndex = numericSelectionToIndex(input.text);
    if (selectedIndex === undefined || !input.session.items[selectedIndex]) {
      return { ok: true, replyText: INVALID_SELECTION_MESSAGE };
    }
    if (!input.context.profile.enabledFunctions.includes("save_resource")) {
      await input.options.sessionStore.delete(input.session.id);
      return { ok: true, replyText: "你可以查看這個公開結果，但目前沒有保存檔案的權限。" };
    }
    const targetKind = input.session.requestedKind;
    const updated: ExternalSheetMusicImportSession = {
      ...input.session,
      selectedIndex,
      targetKind,
      stage: targetKind ? "awaiting_confirmation" : "awaiting_target"
    };
    await input.options.sessionStore.set(updated);
    if (!targetKind) {
      return { ok: true, replyText: "要存到流行歌譜還是詩歌歌譜？" };
    }
    return externalImportConfirmation(updated);
  }

  if (input.session.stage === "awaiting_target") {
    const targetKind = inferTargetKindReply(input.text);
    if (!targetKind) {
      return { ok: true, replyText: "請回覆「流行歌譜」或「詩歌歌譜」。" };
    }
    const updated: ExternalSheetMusicImportSession = {
      ...input.session,
      targetKind,
      stage: "awaiting_confirmation"
    };
    await input.options.sessionStore.set(updated);
    return externalImportConfirmation(updated);
  }

  if (!/^(保存|確認|確定|好|yes|y)$/iu.test(input.text.trim())) {
    return { ok: true, replyText: "請回覆「保存」確認，或回覆「取消」。" };
  }
  if (
    !input.context.profile.enabledFunctions.includes("save_resource") ||
    !input.options.externalImport
  ) {
    await input.options.sessionStore.delete(input.session.id);
    return { ok: true, replyText: "目前沒有開放匯入歌譜檔案。" };
  }
  const selected = input.session.items[input.session.selectedIndex ?? -1];
  const targetKind = input.session.targetKind;
  if (!selected || !targetKind) {
    await input.options.sessionStore.delete(input.session.id);
    return { ok: true, replyText: "這個選擇已失效，請重新搜尋。" };
  }
  try {
    const binary = await input.options.externalImport.client.download({
      url: selected.url,
      maxBytes: input.options.externalImport.maxBytes,
      timeoutMs: input.options.externalImport.timeoutMs,
      maxRedirects: input.options.externalImport.maxRedirects
    });
    return await input.options.externalImport.publisher.publish({
      binary: {
        data: binary.data,
        declaredFileName: binary.fileName,
        declaredContentType: binary.contentType,
        sourceKind: "external"
      },
      target: {
        profileName: input.context.profile.name,
        sourceKey: targetKind === "pop_sheet" ? "pop_sheet_music" : "hymn_sheet_music",
        itemKind: targetKind,
        domain: "sheet_music",
        title: safeExternalTitle(selected.title)
      },
      now: input.now
    });
  } catch {
    return { ok: true, replyText: "無法下載安全的直接歌譜檔案，請確認結果是 PDF 或圖片。" };
  } finally {
    await input.options.sessionStore.delete(input.session.id);
  }
}

function externalImportConfirmation(session: ExternalSheetMusicImportSession) {
  const item = session.items[session.selectedIndex ?? -1];
  const host = item ? new URL(item.url).hostname : "未知來源";
  return {
    ok: true,
    replyText: [
      "請確認匯入公開歌譜：",
      `名稱：${item?.title ?? "未知"}`,
      `來源：${host}`,
      `存到：${session.targetKind === "pop_sheet" ? "流行歌譜" : "詩歌歌譜"}`,
      "回覆「保存」代表你確認教會可以保存並使用這份檔案。"
    ].join("\n")
  };
}

function inferRequestedSheetKind(query: string): "pop_sheet" | "hymn_sheet" | undefined {
  if (/詩歌|敬拜/u.test(query)) return "hymn_sheet";
  if (/流行/u.test(query)) return "pop_sheet";
  return undefined;
}

function inferTargetKindReply(text: string): "pop_sheet" | "hymn_sheet" | undefined {
  if (/詩歌|敬拜/u.test(text)) return "hymn_sheet";
  if (/流行/u.test(text)) return "pop_sheet";
  return undefined;
}

function safeExternalTitle(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/\.(?:pdf|jpe?g|png)$/iu, "")
      .replace(/[<>:"/\\|?*]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "未命名歌譜"
  );
}

function isExternalSearchConfirm(text: string): boolean {
  return /^(上網找|好|可以|找找看|yes|y)(?:[，,\s].*)?$/iu.test(text.trim());
}

function isExternalSearchCancel(text: string): boolean {
  return /^(不用|不要|取消|先不要|no|n)$/iu.test(text.trim());
}

function externalSearchConsentQuickReplies() {
  return [
    {
      label: "上網找",
      action: { type: "message" as const, label: "上網找", text: "上網找" }
    },
    { label: "不用", action: { type: "message" as const, label: "不用", text: "不用" } }
  ];
}

function numericSelectionToIndex(text: string): number | undefined {
  const match = text.match(/^\s*(\d{1,2})\s*$/);
  if (!match) {
    return undefined;
  }
  const selection = Number(match[1]);
  if (!Number.isInteger(selection) || selection < 1) {
    return undefined;
  }
  return selection - 1;
}

function normalizeExtensions(extensions: string[]): string[] {
  return Array.from(
    new Set(
      extensions
        .map((extension) => extension.trim().toLowerCase())
        .filter(Boolean)
        .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
    )
  );
}

function normalizeSearchText(value: string): string {
  const withoutExtension = value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/-\d+$/i, "")
    .replace(/\(\d+\)$/i, "");
  return withoutExtension
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-()[\]{}.,，。:：;；'"!?！？/\\|]+/g, "");
}

function diceCoefficient(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return left === right ? 1 : 0;
  }

  const counts = new Map<string, number>();
  for (const gram of leftBigrams) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let intersections = 0;
  for (const gram of rightBigrams) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      intersections += 1;
      counts.set(gram, count - 1);
    }
  }

  return (2 * intersections) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value: string): string[] {
  if (value.length < 2) {
    return value ? [value] : [];
  }
  const grams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.push(value.slice(index, index + 2));
  }
  return grams;
}

function sourceMatches(
  expected: FunctionHandlerContext["event"]["source"],
  actual: FunctionHandlerContext["event"]["source"]
): boolean {
  if (expected.type !== actual.type) {
    return false;
  }
  switch (expected.type) {
    case "group":
      return expected.groupId === actual.groupId;
    case "room":
      return expected.roomId === actual.roomId;
    case "user":
      return expected.userId === actual.userId;
    default:
      return false;
  }
}
