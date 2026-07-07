import { randomUUID } from "node:crypto";

import type { CacheStore } from "../cache/cache-store.js";
import {
  findPopSheetMusicArgumentsSchema,
  type FindPopSheetMusicArguments
} from "../function-arguments.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import {
  InMemorySessionStore,
  type ConversationSession,
  type SessionStore
} from "../state/session-store.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import type {
  DriveItem,
  FunctionHandler,
  FunctionHandlerContext,
  GraphDriveClient,
  PostbackHandler,
  TextMessageContext,
  TextMessageHandler
} from "../types.js";

const POSTBACK_ACTION = "select_sheet_music";
const MAX_CANDIDATES = 5;
const SELECTION_TTL_MS = 10 * 60 * 1000;
const FILE_INDEX_TTL_MS = 30 * 60 * 1000;
const MIN_FUZZY_SCORE = 0.42;
const INVALID_SELECTION_MESSAGE = "請只回覆清單中的數字，例如：1。不要加上其他字。";
export const SHEET_MUSIC_INDEX_CACHE_PREFIX = "sheet-music-index:";

export interface FindPopSheetMusicOptions {
  graph: GraphDriveClient;
  driveId: string;
  folderItemId?: string;
  folderPath?: string;
  allowedExtensions: string[];
  recursive?: boolean;
  cache?: CacheStore;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}

export interface FindPopSheetMusicPostbackOptions {
  graph: GraphDriveClient;
  sessionStore: SessionStore;
  now?: () => Date;
}

export type FindPopSheetMusicTextMessageOptions = FindPopSheetMusicPostbackOptions;

interface ScoredItem {
  item: DriveItem;
  score: number;
}

type SheetMusicMatchMode = NonNullable<FindPopSheetMusicArguments["matchMode"]>;

export function createFindPopSheetMusicHandler(options: FindPopSheetMusicOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const configuredExtensions = normalizeExtensions(options.allowedExtensions);
  const sessionStore =
    options.sessionStore ?? new InMemorySessionStore({ now, ttlMs: SELECTION_TTL_MS });
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return async (rawArgs, context) => {
    const args = findPopSheetMusicArgumentsSchema.parse(rawArgs);
    const rawQuery = args.query.trim();

    if (!rawQuery) {
      await storePendingFunctionQuery({
        sessionStore,
        requestId: requestIdFactory(),
        action: "find_pop_sheet_music",
        arguments: args,
        context,
        now: now()
      });
      return {
        ok: true,
        replyText: "要查哪一首流行歌譜？請直接回覆歌名或歌手。"
      };
    }

    const root = await resolveSheetMusicRoot(options);
    const extensions = resolveSearchExtensions(configuredExtensions, args);
    const allItems = await getCachedFileIndex(options, root);
    const candidates = rankSheetMusicCandidates(
      allItems,
      rawQuery,
      args.artist,
      extensions,
      args.matchMode ?? "fuzzy"
    );

    if (candidates.length === 0) {
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
        ]
      };
    }

    if (candidates.length === 1) {
      return createSharingLinkReply(options.graph, candidates[0].item, now());
    }

    const requestId = requestIdFactory();
    await sessionStore.set({
      id: requestId,
      type: "selection",
      action: POSTBACK_ACTION,
      profileName: context.profile.name,
      requesterUserId: context.event.source.userId,
      source: context.event.source,
      items: candidates.map(({ item }) => ({
        id: item.id,
        driveId: item.driveId,
        name: item.name
      })),
      expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString()
    });

    return {
      ok: true,
      replyText: [
        "找到多個相近的樂譜，請選擇：",
        ...candidates.map(({ item }, index) => `${index + 1}. ${item.name}`)
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
      )
    };
  };
}

export function createFindPopSheetMusicPostbackHandler(
  options: FindPopSheetMusicPostbackOptions
): PostbackHandler {
  const now = options.now ?? (() => new Date());

  return async (request, context) => {
    if (!context.profile.enabledFunctions.includes("find_pop_sheet_music")) {
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
    matches: async (request, context) =>
      context.profile.enabledFunctions.includes("find_pop_sheet_music") &&
      numericSelectionToIndex(request.text) !== undefined &&
      Boolean(await findSheetMusicSelection(options.sessionStore, context)),

    handle: async (request, context) => {
      const selectedIndex = numericSelectionToIndex(request.text);
      if (selectedIndex === undefined) {
        return undefined;
      }
      const session = await findSheetMusicSelection(options.sessionStore, context);
      if (!session) {
        return undefined;
      }
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
  };
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
  return createSharingLinkReply(graph, item, now);
}

async function createSharingLinkReply(
  graph: GraphDriveClient,
  item: Pick<DriveItem, "id" | "name" | "driveId">,
  now: Date
) {
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const link = await graph.createSharingLink(item.driveId ?? "", item.id, expiresAt);

  return {
    ok: true,
    replyText: ["已找到流行歌曲樂譜：", item.name, "下載連結（1 天內有效）：", link].join("\n")
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
  switch (args.fileType ?? "pdf") {
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
