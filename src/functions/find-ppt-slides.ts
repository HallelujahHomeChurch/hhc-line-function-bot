import { randomUUID } from "node:crypto";

import {
  findPptSlidesArgumentsSchema,
  type FindPptSlidesArguments
} from "../function-arguments.js";
import type { AgentMemoryStore, AgentResourceRecord } from "../agent/memory-store.js";
import {
  catalogSourceAllowsRead,
  type CatalogItemRecord,
  type CatalogStore
} from "../catalog/store.js";
import { searchCatalogWithFreshness, type CatalogRetrievalStatus } from "../catalog/retrieval.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import { withRequesterDisplayName } from "../requester-personalization.js";
import { canCreateRequesterScopedSession } from "../state/session-safety.js";
import {
  InMemorySessionStore,
  type ConversationSession,
  type SessionStore
} from "../state/session-store.js";
import type {
  DriveItem,
  FunctionExecutionResult,
  FunctionHandler,
  FunctionHandlerContext,
  GraphDriveClient,
  JsonRecord,
  PostbackHandler,
  TextMessageHandler,
  TextMessageContext
} from "../types.js";
import {
  diagnosticFingerprint,
  type RetrievalDiagnostics
} from "../observability/retrieval-diagnostics.js";
import { createValidatedSharingLink } from "./validated-sharing-link.js";

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

type PptCandidate =
  | {
      kind: "memory";
      resource: AgentResourceRecord;
    }
  | {
      kind: "graph";
      item: DriveItem;
    };

export interface FindPptSlidesOptions {
  graph: GraphDriveClient;
  catalog?: CatalogStore;
  driveId: string;
  folderItemId: string;
  allowedExtensions: string[];
  defaultIncludePdf: boolean;
  memoryStore?: AgentMemoryStore;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
  observabilityHmacKey?: string;
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

    if (args.driveId && args.itemId) {
      return withRetrievalDiagnostics(
        await createSharingLinkReply(
          options.graph,
          args.driveId,
          { id: args.itemId, name: "投影片" },
          now(),
          args.resourceId ?? args.itemId
        ),
        retrievalDiagnostics(options, "explicit_task_replay", rawQuery, args.itemId)
      );
    }

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
        replyText: withRequesterDisplayName(context, "要查哪一份投影片？請直接回覆名稱。"),
        agentResult: {
          status: "ambiguous",
          replyText: "要查哪一份投影片？請直接回覆名稱。",
          clarification: { prompt: "要查哪一份投影片？請直接回覆名稱。" }
        }
      };
    }

    const extensions = resolveSearchExtensions(
      configuredExtensions,
      args,
      options.defaultIncludePdf
    );
    const remembered = await findRememberedPptSlides(options.memoryStore, rawQuery, context);
    const catalogResult = await findCatalogPptSlides(
      options.catalog,
      context.profile.name,
      rawQuery,
      extensions
    );
    const catalogItems = catalogResult.items;
    if (catalogItems.length > 0) {
      const candidates: PptCandidate[] = rankWithRememberedResources(
        catalogItems.map((item) => ({
          kind: "graph" as const,
          item: catalogItemToDriveItem(item)
        })),
        remembered
      ).slice(0, MAX_CANDIDATES);

      if (candidates.length === 1) {
        return withRetrievalDiagnostics(
          await createPptCandidateReply(options.graph, options.driveId, candidates[0], now()),
          catalogDiagnostics(options, rawQuery, catalogResult)
        );
      }

      if (!canCreateRequesterScopedSession(context.event.source)) {
        return {
          ok: true,
          replyText: "找到多個相近的詩歌投影片，請提供更完整歌名。",
          agentResult: pptAmbiguousEnvelope(candidates),
          diagnostics: catalogDiagnostics(options, rawQuery, catalogResult)
        };
      }

      const requestId = requestIdFactory();
      await sessionStore.set({
        id: requestId,
        type: "ppt_selection",
        profileName: context.profile.name,
        requesterUserId: context.event.source.userId,
        source: context.event.source,
        driveId: options.driveId,
        items: candidates.map(toSelectionItem),
        expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString()
      });

      return {
        ok: true,
        replyText: [
          withRequesterDisplayName(context, "找到多個相近的詩歌投影片，請回覆編號："),
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
        agentResult: pptAmbiguousEnvelope(candidates),
        diagnostics: catalogDiagnostics(options, rawQuery, catalogResult)
      };
    }

    let allItems: DriveItem[];
    try {
      allItems = await options.graph.listFolderChildren(options.driveId, options.folderItemId);
    } catch {
      const replyText = "目前無法查詢投影片資料，請稍後再試。";
      return {
        ok: true,
        replyText,
        agentResult: { status: "unavailable", replyText },
        diagnostics: retrievalDiagnostics(options, "provider_fallback", rawQuery)
      };
    }
    const graphCandidates = rankPptCandidates(
      allItems,
      rawQuery,
      extensions,
      args.matchMode ?? "fuzzy"
    );
    const candidates: PptCandidate[] = rankWithRememberedResources(
      graphCandidates.map(({ item }) => ({ kind: "graph" as const, item })),
      remembered
    ).slice(0, MAX_CANDIDATES);

    if (candidates.length === 0) {
      return {
        ok: true,
        replyText: "找不到符合的詩歌投影片，請再提供更完整歌名。",
        quickReplies: [
          {
            label: "重新查投影片",
            action: { type: "message", label: "重新查投影片", text: "小哈 查投影片" }
          }
        ],
        agentResult: {
          status: "not_found",
          replyText: "找不到符合的詩歌投影片，請再提供更完整歌名。"
        },
        diagnostics: retrievalDiagnostics(options, "provider_fallback", rawQuery)
      };
    }

    if (candidates.length === 1) {
      return withRetrievalDiagnostics(
        await createPptCandidateReply(options.graph, options.driveId, candidates[0], now()),
        retrievalDiagnostics(options, "provider_fallback", rawQuery, candidateKey(candidates[0]))
      );
    }

    if (!canCreateRequesterScopedSession(context.event.source)) {
      return {
        ok: true,
        replyText: "找到多個相近的詩歌投影片，請提供更完整歌名。",
        agentResult: pptAmbiguousEnvelope(candidates),
        diagnostics: retrievalDiagnostics(options, "provider_fallback", rawQuery)
      };
    }

    const requestId = requestIdFactory();
    await sessionStore.set({
      id: requestId,
      type: "ppt_selection",
      profileName: context.profile.name,
      requesterUserId: context.event.source.userId,
      source: context.event.source,
      driveId: options.driveId,
      items: candidates.map(toSelectionItem),
      expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString()
    });

    return {
      ok: true,
      replyText: [
        withRequesterDisplayName(context, "找到多個相近的詩歌投影片，請回覆編號："),
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
      agentResult: pptAmbiguousEnvelope(candidates),
      diagnostics: retrievalDiagnostics(options, "provider_fallback", rawQuery)
    };
  };
}

function withRetrievalDiagnostics(
  result: FunctionExecutionResult,
  diagnostics: RetrievalDiagnostics
): FunctionExecutionResult {
  return { ...result, diagnostics };
}

function retrievalDiagnostics(
  options: FindPptSlidesOptions,
  executionMode: RetrievalDiagnostics["executionMode"],
  query: string,
  reference?: string
): RetrievalDiagnostics {
  return {
    executionMode,
    queryFingerprint: diagnosticFingerprint("query", query, options.observabilityHmacKey),
    referenceFingerprint: reference
      ? diagnosticFingerprint("reference", reference, options.observabilityHmacKey)
      : undefined
  };
}

function catalogDiagnostics(
  options: FindPptSlidesOptions,
  query: string,
  result: { status: CatalogRetrievalStatus; revision: string; items: CatalogItemRecord[] }
): RetrievalDiagnostics {
  return {
    ...retrievalDiagnostics(options, "catalog_snapshot_read", query, result.items[0]?.id),
    freshnessStatus:
      result.status === "fresh"
        ? "fresh"
        : result.status === "stale_allowed"
          ? "stale_allowed"
          : "stale_rejected",
    sourceRevision: result.revision ? "present" : "missing"
  };
}

function candidateKey(candidate: PptCandidate): string {
  return candidate.kind === "memory" ? candidate.resource.id : candidate.item.id;
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
    turnStage: "resolution",
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

  const consumed = await sessionStore.take(session.id);
  if (
    !consumed ||
    consumed.type !== "ppt_selection" ||
    consumed.profileName !== context.profile.name ||
    !sourceMatches(consumed.source, context.event.source) ||
    (consumed.requesterUserId && consumed.requesterUserId !== context.event.source.userId)
  ) {
    return { ok: true, replyText: "這個選擇已失效，請重新查詢。" };
  }
  const consumedItem = consumed.items[selectedIndex];
  if (!consumedItem) {
    return { ok: true, replyText: "這個選擇已失效，請重新查詢。" };
  }
  if (consumedItem.memoryResource) {
    return createRememberedReferenceReply(graph, consumedItem.memoryResource, now, consumedItem.id);
  }
  return createSharingLinkReply(graph, consumedItem.driveId ?? consumed.driveId, consumedItem, now);
}

async function findRememberedPptSlides(
  memoryStore: AgentMemoryStore | undefined,
  query: string,
  context: FunctionHandlerContext
): Promise<AgentResourceRecord[]> {
  const resources = await memoryStore?.searchResources({
    profileName: context.profile.name,
    source: context.event.source,
    requesterUserId: context.event.source.userId,
    query,
    resourceTypes: ["ppt_slide"],
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
      replyText: ["已找到我記住的詩歌投影片：", resource.title, resource.storage.url].join("\n"),
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
      agentResult: pptSuccessEnvelope(resourceId, { resourceId })
    };
  }
  return createSharingLinkReply(
    graph,
    resource.storage.driveId,
    { id: resource.storage.itemId, name: resource.title },
    now,
    resourceId
  );
}

function createPptCandidateReply(
  graph: GraphDriveClient,
  driveId: string,
  candidate: PptCandidate,
  now: Date
): Promise<FunctionExecutionResult> {
  if (candidate.kind === "memory") {
    return createRememberedResourceReply(graph, candidate.resource, now);
  }
  return createSharingLinkReply(graph, candidate.item.driveId ?? driveId, candidate.item, now);
}

function toSelectionItem(candidate: PptCandidate) {
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
  return { id: candidate.item.id, driveId: candidate.item.driveId, name: candidate.item.name };
}

async function findCatalogPptSlides(
  catalog: CatalogStore | undefined,
  profileName: string,
  query: string,
  extensions: string[]
): Promise<{ status: CatalogRetrievalStatus; revision: string; items: CatalogItemRecord[] }> {
  if (!catalog) {
    return { status: "unavailable", revision: "", items: [] };
  }
  const result = await searchCatalogWithFreshness({
    catalog,
    search: {
      profileName,
      query,
      itemKinds: ["ppt_slide"],
      domains: ["presentation"],
      limit: MAX_CANDIDATES
    }
  });
  return {
    ...result,
    items: result.items
      .filter((item) => catalogSourceAllowsRead(item.source, [profileName, "find_ppt_slides"]))
      .filter((item) => item.storageRef.provider === "graph")
      .filter((item) => extensions.some((extension) => catalogItemExtension(item) === extension))
  };
}

function rankWithRememberedResources(
  candidates: PptCandidate[],
  remembered: AgentResourceRecord[]
): PptCandidate[] {
  const identities = new Set(
    remembered.flatMap((resource) =>
      resource.storage.provider === "graph"
        ? [`${resource.storage.driveId}:${resource.storage.itemId}`]
        : []
    )
  );
  return [...candidates].sort((left, right) => {
    const leftRemembered =
      left.kind === "graph" && identities.has(`${left.item.driveId ?? ""}:${left.item.id}`);
    const rightRemembered =
      right.kind === "graph" && identities.has(`${right.item.driveId ?? ""}:${right.item.id}`);
    return Number(rightRemembered) - Number(leftRemembered);
  });
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

function candidateName(candidate: PptCandidate): string {
  return candidate.kind === "memory" ? candidate.resource.title : candidate.item.name;
}

async function createSharingLinkReply(
  graph: GraphDriveClient,
  driveId: string,
  item: Pick<DriveItem, "id" | "name">,
  now: Date,
  resourceId = item.id
): Promise<FunctionExecutionResult> {
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const current = await createValidatedSharingLink({
    graph,
    driveId,
    itemId: item.id,
    expiresAt
  });
  if (!current.link) {
    const replyText = "這份投影片已不存在或沒有權限，請重新查詢。";
    return { ok: true, replyText, agentResult: { status: "unavailable", replyText } };
  }
  const link = current.link;

  return {
    ok: true,
    replyText: ["已找到詩歌投影片：", item.name, "下載連結（1 天內有效）：", link].join("\n"),
    agentResource: {
      resourceType: "ppt_slide",
      title: item.name,
      storage: { provider: "graph", driveId, itemId: item.id }
    },
    responseData: { kind: "resource", fields: { title: item.name, link } },
    agentResult: pptSuccessEnvelope(resourceId, {
      resourceId,
      driveId,
      itemId: item.id
    })
  };
}

function pptSuccessEnvelope(resourceId: string, reference: JsonRecord) {
  return {
    status: "success" as const,
    replyText: "投影片查詢完成。",
    entities: [{ type: "resource", key: resourceId, label: "投影片資源" }],
    evidence: [{ kind: "catalog_item", reference }],
    supportedOperations: ["continue", "refine", "view_full"]
  };
}

function pptAmbiguousEnvelope(candidates: PptCandidate[]) {
  return {
    status: "ambiguous" as const,
    replyText: "找到多個相近的投影片，請選擇。",
    entities: candidates.map((candidate) => ({
      type: "resource",
      key: candidate.kind === "memory" ? candidate.resource.id : candidate.item.id,
      label: "投影片資源"
    })),
    clarification: { prompt: "找到多個相近的投影片，請選擇。" }
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
