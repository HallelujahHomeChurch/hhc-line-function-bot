import { randomUUID } from "node:crypto";

import {
  findPptSlidesArgumentsSchema,
  type FindPptSlidesArguments
} from "../function-arguments.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import {
  InMemorySessionStore,
  type ConversationSession,
  type SessionStore
} from "../state/session-store.js";
import type {
  DriveItem,
  FunctionHandler,
  FunctionHandlerContext,
  GraphDriveClient,
  PostbackHandler,
  TextMessageHandler,
  TextMessageContext
} from "../types.js";

const POSTBACK_ACTION = "select_ppt";
const MAX_CANDIDATES = 5;
const SELECTION_TTL_MS = 10 * 60 * 1000;
const MIN_FUZZY_SCORE = 0.45;
const INVALID_SELECTION_MESSAGE = "請只回覆清單中的數字，例如：1。不要加上其他字。";

const similarChineseCharacters: Record<string, string> = {
  易: "異",
  点: "典",
  點: "典"
};

const titleAliases: Array<[string, string]> = [["amazinggrace", "奇異恩典"]];

export interface FindPptSlidesOptions {
  graph: GraphDriveClient;
  driveId: string;
  folderItemId: string;
  allowedExtensions: string[];
  defaultIncludePdf: boolean;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}

export interface FindPptSlidesPostbackOptions {
  graph: GraphDriveClient;
  sessionStore: SessionStore;
  now?: () => Date;
}

export type FindPptSlidesTextMessageOptions = FindPptSlidesPostbackOptions;

interface ScoredItem {
  item: DriveItem;
  score: number;
}

type PptMatchMode = NonNullable<FindPptSlidesArguments["matchMode"]>;

export function createFindPptSlidesHandler(options: FindPptSlidesOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const configuredExtensions = normalizeExtensions(options.allowedExtensions);
  const sessionStore =
    options.sessionStore ?? new InMemorySessionStore({ now, ttlMs: SELECTION_TTL_MS });
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return async (rawArgs, context) => {
    const args = findPptSlidesArgumentsSchema.parse(rawArgs);
    const rawQuery = args.query.trim();

    if (!rawQuery) {
      await storePendingFunctionQuery({
        sessionStore,
        requestId: requestIdFactory(),
        action: "find_ppt_slides",
        arguments: args,
        context,
        now: now()
      });
      return {
        ok: true,
        replyText: "要查哪一份投影片？請直接回覆名稱。"
      };
    }

    const extensions = resolveSearchExtensions(
      configuredExtensions,
      args,
      options.defaultIncludePdf
    );
    const allItems = await options.graph.listFolderChildren(options.driveId, options.folderItemId);
    const candidates = rankPptCandidates(allItems, rawQuery, extensions, args.matchMode ?? "fuzzy");

    if (candidates.length === 0) {
      return {
        ok: true,
        replyText: "找不到符合的詩歌投影片，請再提供更完整歌名。",
        quickReplies: [
          {
            label: "重新查投影片",
            action: { type: "message", label: "重新查投影片", text: "小哈 查投影片" }
          },
          {
            label: "查PDF投影片",
            action: { type: "message", label: "查PDF投影片", text: "小哈 查投影片 pdf" }
          }
        ]
      };
    }

    if (candidates.length === 1) {
      return createSharingLinkReply(options.graph, options.driveId, candidates[0].item, now());
    }

    const requestId = requestIdFactory();
    await sessionStore.set({
      id: requestId,
      type: "ppt_selection",
      profileName: context.profile.name,
      requesterUserId: context.event.source.userId,
      source: context.event.source,
      driveId: options.driveId,
      items: candidates.map(({ item }) => ({ id: item.id, name: item.name })),
      expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString()
    });

    return {
      ok: true,
      replyText: [
        "找到多個相近的詩歌投影片，請回覆編號：",
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

export function createFindPptSlidesPostbackHandler(
  options: FindPptSlidesPostbackOptions
): PostbackHandler {
  const now = options.now ?? (() => new Date());

  return async (request, context) => {
    if (!context.profile.enabledFunctions.includes("find_ppt_slides")) {
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

    return selectPptCandidate({
      graph: options.graph,
      sessionStore: options.sessionStore,
      session: await options.sessionStore.get(request.params.requestId),
      selectedIndex,
      context,
      now: now()
    });
  };
}

export function createFindPptSlidesTextMessageHandler(
  options: FindPptSlidesTextMessageOptions
): TextMessageHandler {
  const now = options.now ?? (() => new Date());

  return {
    matches: async (request, context) =>
      context.profile.enabledFunctions.includes("find_ppt_slides") &&
      numericSelectionToIndex(request.text) !== undefined &&
      Boolean(await findPptSelection(options.sessionStore, context)),

    handle: async (request, context) => {
      const selectedIndex = numericSelectionToIndex(request.text);
      if (selectedIndex === undefined) {
        return undefined;
      }
      const session = await findPptSelection(options.sessionStore, context);
      if (!session) {
        return undefined;
      }
      return selectPptCandidate({
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

async function findPptSelection(sessionStore: SessionStore, context: TextMessageContext) {
  return sessionStore.findPptSelection({
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

async function selectPptCandidate(options: {
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
    session.type !== "ppt_selection" ||
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
  return createSharingLinkReply(graph, session.driveId, item, now);
}

async function createSharingLinkReply(
  graph: GraphDriveClient,
  driveId: string,
  item: Pick<DriveItem, "id" | "name">,
  now: Date
) {
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const link = await graph.createSharingLink(driveId, item.id, expiresAt);

  return {
    ok: true,
    replyText: ["已找到詩歌投影片：", item.name, "下載連結（1 天內有效）：", link].join("\n")
  };
}

function rankPptCandidates(
  items: DriveItem[],
  rawQuery: string,
  extensions: string[],
  matchMode: PptMatchMode
): ScoredItem[] {
  const query = normalizeSearchText(rawQuery);
  const queryWithAliases = normalizeKnownAliases(query);

  return items
    .filter((item) => extensions.some((extension) => item.name.toLowerCase().endsWith(extension)))
    .map((item) => ({
      item,
      score: scoreCandidate(query, queryWithAliases, item, matchMode)
    }))
    .filter(({ score }) => score >= MIN_FUZZY_SCORE)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return extensionPriority(right.item.name) - extensionPriority(left.item.name);
    })
    .slice(0, MAX_CANDIDATES);
}

function scoreCandidate(
  query: string,
  queryWithAliases: string,
  item: DriveItem,
  matchMode: PptMatchMode
): number {
  const normalizedName = normalizeSearchText(item.name);
  const normalizedNameWithAliases = normalizeKnownAliases(normalizedName);

  if (normalizedName.includes(query) || normalizedNameWithAliases.includes(queryWithAliases)) {
    return 1;
  }
  if (normalizedName.includes(queryWithAliases) || normalizedNameWithAliases.includes(query)) {
    return 0.92;
  }

  if (matchMode === "exact") {
    return 0;
  }

  return Math.max(
    diceCoefficient(query, normalizedName),
    diceCoefficient(queryWithAliases, normalizedNameWithAliases)
  );
}

function resolveSearchExtensions(
  configuredExtensions: string[],
  args: FindPptSlidesArguments,
  defaultIncludePdf: boolean
): string[] {
  switch (args.fileType) {
    case "pdf":
      return configuredExtensions.filter((extension) => extension === ".pdf");
    case "ppt":
      return configuredExtensions.filter(
        (extension) => extension === ".ppt" || extension === ".pptx"
      );
    case "any":
      return configuredExtensions;
    default: {
      const includePdf = args.includePdf ?? defaultIncludePdf;
      return configuredExtensions.filter((extension) => includePdf || extension !== ".pdf");
    }
  }
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
  const withoutExtension = value.replace(/\.[a-z0-9]+$/i, "");
  return Array.from(withoutExtension.normalize("NFKC").toLowerCase())
    .map((character) => similarChineseCharacters[character] ?? character)
    .join("")
    .replace(/[\s_\-()[\]{}.,，。:：;；'"!?！？/\\|]+/g, "");
}

function normalizeKnownAliases(value: string): string {
  return titleAliases.reduce(
    (normalized, [alias, canonical]) => normalized.replaceAll(alias, canonical),
    value
  );
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

function extensionPriority(name: string): number {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".pptx")) {
    return 3;
  }
  if (lowerName.endsWith(".ppt")) {
    return 2;
  }
  if (lowerName.endsWith(".pdf")) {
    return 1;
  }
  return 0;
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
