import type { ActiveTaskContext } from "../../../agent/active-task.js";
import { buildCapabilityCandidates } from "../../../agent/capability-candidates.js";
import { InMemoryAgentMemoryStore } from "../../../agent/memory-store.js";
import { searchCatalogWithFreshness } from "../../../catalog/retrieval.js";
import {
  catalogStorageIdentity,
  InMemoryCatalogStore,
  type CatalogDomain
} from "../../../catalog/store.js";
import { createValidatedSharingLink } from "../../../functions/validated-sharing-link.js";
import { extractPptSlideQuery } from "../../../ppt-query.js";
import type {
  KernelAcceptanceCase,
  KernelCaseObservation,
  KernelJourney,
  RecurrenceFamily
} from "../contracts.js";
import { runKernelJourneyCheck, runKernelJourneyStatus } from "../journey-runtime.js";

export const RETRIEVAL_KERNEL_CASES: KernelAcceptanceCase[] = [
  checkCase(
    "kernel-v1/ppt/sequential-distinct-query@1",
    "ppt",
    "stale_result_replay",
    sequentialDistinctCatalogQueries
  ),
  checkCase(
    "kernel-v1/ppt/wrapper-words-subject@1",
    "ppt",
    "wrapper_words_hide_subject",
    async () => extractPptSlideQuery("麻煩幫我查詢恩典之路的投影片") === "恩典之路"
  ),
  checkCase(
    "kernel-v1/sheet_music/catalog-hit@1",
    "sheet_music",
    "stale_result_replay",
    async (now) => catalogHit("sheet_music", "sheet_music", now)
  ),
  checkCase(
    "kernel-v1/resource/fresh-second-query@1",
    "resource",
    "stale_result_replay",
    freshSecondQuery
  ),
  checkCase(
    "kernel-v1/resource/tombstone-cannot-resurrect@1",
    "resource",
    "resource_memory_resurrection",
    tombstoneCannotResurrect
  ),
  checkCase(
    "kernel-v1/resource/reference-validation@1",
    "resource",
    "resource_memory_resurrection",
    referenceValidation
  ),
  checkCase(
    "kernel-v1/knowledge/body-only-routing@1",
    "knowledge",
    "required_slot_misrouted",
    async () =>
      knowledgeCandidates(undefined).some(({ capability }) => capability === "query_knowledge")
  ),
  checkCase(
    "kernel-v1/knowledge/section-document-source-follow-up@1",
    "knowledge",
    "role_follow_up_lost",
    async () =>
      knowledgeCandidates(knowledgeTask).some(({ capability }) => capability === "query_knowledge")
  ),
  checkCase(
    "kernel-v1/memory/explicit-save-retrieve@1",
    "memory",
    "required_slot_misrouted",
    explicitMemoryRoundTrip
  ),
  checkCase(
    "kernel-v1/resource/atomic-publication@1",
    "resource",
    "replica_state_divergence",
    atomicPublication
  ),
  ...Array.from({ length: 10 }, (_, index) => unavailableCase(index))
];

function checkCase(
  id: string,
  journey: KernelJourney,
  recurrenceFamily: RecurrenceFamily,
  check: (now: Date) => Promise<boolean>
): KernelAcceptanceCase {
  return {
    id,
    version: 1,
    journey,
    recurrenceFamily,
    boundary: "adapter_retrieval",
    async run(context) {
      const result = await runKernelJourneyCheck({
        journey,
        now: context.now,
        check: () => check(context.now()),
        requestId: id
      });
      const passed = result?.resultStatus === "success";
      return observation(id, recurrenceFamily, {
        passed,
        coreJourneySucceeded: passed
      });
    }
  };
}

function unavailableCase(index: number): KernelAcceptanceCase {
  const named = [
    { journey: "sheet_music" as const, slug: "unavailable-not-not-found" },
    { journey: "resource" as const, slug: "unavailable-not-not-found" }
  ][index];
  const journey = named?.journey ?? (index % 2 === 0 ? "ppt" : "resource");
  const id = named
    ? `kernel-v1/${journey}/${named.slug}@1`
    : `kernel-v1/${journey}/unavailable-${String(index + 1).padStart(2, "0")}@1`;
  return {
    id,
    version: 1,
    journey,
    recurrenceFamily: "unavailable_presented_as_not_found",
    boundary: "freshness_invalidation",
    async run(context) {
      const result = await runKernelJourneyStatus({
        journey,
        now: context.now,
        requestId: id,
        resolveStatus: async () => {
          const catalog = new InMemoryCatalogStore();
          await catalog.upsertSource(sourceInput(`never_${index}`, "general"));
          const retrieval = await searchCatalogWithFreshness({
            catalog,
            search: { profileName: "helper", query: "synthetic", domains: ["general"] },
            now: context.now()
          });
          if (retrieval.status === "unavailable") return "unavailable";
          if (retrieval.status === "not_found") return "not_found";
          return "success";
        }
      });
      const passed = result?.resultStatus === "unavailable";
      return observation(id, "unavailable_presented_as_not_found", {
        passed,
        coreJourneySucceeded: passed,
        unavailableEligible: true,
        unavailableMisclassified: !passed
      });
    }
  };
}

async function sequentialDistinctCatalogQueries(now: Date): Promise<boolean> {
  const { catalog, sourceId } = await publishedCatalog(now, [
    ["first", "first"],
    ["second", "second"]
  ]);
  const first = await searchCatalogWithFreshness({
    catalog,
    search: { profileName: "helper", query: "first" },
    now
  });
  const second = await searchCatalogWithFreshness({
    catalog,
    search: { profileName: "helper", query: "second" },
    now
  });
  return (
    first.items.length === 1 &&
    second.items.length === 1 &&
    first.items[0]?.sourceId === sourceId &&
    first.items[0]?.id !== second.items[0]?.id
  );
}

async function catalogHit(domain: CatalogDomain, itemKind: string, now: Date): Promise<boolean> {
  const { catalog } = await publishedCatalog(now, [["catalog target", "target"]], domain, itemKind);
  const result = await searchCatalogWithFreshness({
    catalog,
    search: { profileName: "helper", query: "catalog target", domains: [domain] },
    now
  });
  return result.status === "fresh" && result.items.length === 1;
}

async function freshSecondQuery(now: Date): Promise<boolean> {
  const catalog = new InMemoryCatalogStore();
  const source = await catalog.upsertSource(sourceInput("fresh_second", "general"));
  await catalog.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: "0",
    publishedAt: now.toISOString(),
    items: [catalogItem(source.id, "first", "first")]
  });
  await catalog.publishSourceDelta({
    sourceId: source.id,
    expectedRevision: "1",
    publishedAt: now.toISOString(),
    upserts: [catalogItem(source.id, "second", "second")],
    deletedStorageIdentities: [],
    syncCursor: "cursor-2"
  });
  const result = await searchCatalogWithFreshness({
    catalog,
    search: { profileName: "helper", query: "second" },
    now
  });
  return result.status === "fresh" && result.items[0]?.storageRef.provider === "graph";
}

async function tombstoneCannotResurrect(now: Date): Promise<boolean> {
  const catalog = new InMemoryCatalogStore();
  const source = await catalog.upsertSource(sourceInput("tombstone", "general"));
  const item = catalogItem(source.id, "retired", "retired");
  await catalog.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: "0",
    publishedAt: now.toISOString(),
    items: [item]
  });
  await catalog.publishSourceDelta({
    sourceId: source.id,
    expectedRevision: "1",
    publishedAt: now.toISOString(),
    upserts: [],
    deletedStorageIdentities: [catalogStorageIdentity(item.storageRef)],
    syncCursor: "cursor-2"
  });
  const result = await searchCatalogWithFreshness({
    catalog,
    search: { profileName: "helper", query: "retired" },
    now
  });
  return result.status === "not_found" && result.items.length === 0;
}

async function referenceValidation(now: Date): Promise<boolean> {
  let sharingCalls = 0;
  const result = await createValidatedSharingLink({
    graph: {
      listFolderChildren: async () => [],
      getItemById: async () => undefined,
      createSharingLink: async () => {
        sharingCalls += 1;
        return "synthetic-link";
      }
    },
    driveId: "drive",
    itemId: "missing",
    expiresAt: now.toISOString()
  });
  return !result.link && sharingCalls === 0;
}

function knowledgeCandidates(activeTask?: ActiveTaskContext) {
  return buildCapabilityCandidates({
    text: activeTask ? "那幾點集合" : "第一天去哪裡",
    enabledFunctions: ["query_knowledge"],
    activeTask,
    knowledgeSources: [
      {
        sourceKey: "source-opaque",
        displayName: "synthetic source",
        aliases: ["synthetic"],
        topics: ["第一天", "集合時間"],
        sampleQueries: ["第一天去哪裡"]
      }
    ],
    maxCandidates: 3,
    source: "group"
  });
}

const knowledgeTask: ActiveTaskContext = {
  version: 2,
  currentCapability: "query_knowledge",
  allowedCapabilities: ["query_knowledge"],
  anchors: { sourceId: "opaque-source", documentId: "opaque-document" },
  entities: [{ type: "document", key: "opaque-document", label: "知識文件" }],
  supportedOperations: ["continue", "refine"],
  createdAt: "2026-07-16T07:55:00.000Z",
  expiresAt: "2026-07-16T08:05:00.000Z"
};

async function explicitMemoryRoundTrip(now: Date): Promise<boolean> {
  const memory = new InMemoryAgentMemoryStore({ now: () => now });
  await memory.saveTextMemory({
    profileName: "helper",
    source: { type: "user", userId: "U_SYNTHETIC" },
    createdBy: "U_SYNTHETIC",
    content: "synthetic memory",
    query: "synthetic"
  });
  const results = await memory.searchTextMemories({
    profileName: "helper",
    source: { type: "user", userId: "U_SYNTHETIC" },
    requesterUserId: "U_SYNTHETIC",
    query: "synthetic"
  });
  return results.length === 1;
}

async function atomicPublication(now: Date): Promise<boolean> {
  const catalog = new InMemoryCatalogStore();
  const source = await catalog.upsertSource(sourceInput("atomic", "general"));
  const first = await catalog.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: "0",
    publishedAt: now.toISOString(),
    items: []
  });
  const stale = await catalog.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: "0",
    publishedAt: now.toISOString(),
    items: []
  });
  return first?.revision === "1" && stale === undefined;
}

async function publishedCatalog(
  now: Date,
  rows: Array<[string, string]>,
  domain: CatalogDomain = "general",
  itemKind = "church_document"
) {
  const catalog = new InMemoryCatalogStore();
  const source = await catalog.upsertSource(sourceInput(`published_${domain}`, domain));
  await catalog.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: "0",
    publishedAt: now.toISOString(),
    items: rows.map(([title, itemId]) => catalogItem(source.id, title, itemId, domain, itemKind))
  });
  return { catalog, sourceId: source.id };
}

function sourceInput(sourceKey: string, domain: CatalogDomain) {
  return {
    profileName: "helper",
    sourceKey,
    adapterType: "onedrive" as const,
    domain,
    defaultItemKind: "church_document",
    rootLocation: { driveId: "drive", folderItemId: "folder" },
    enabled: true,
    syncPolicy: { mode: "scheduled" as const, intervalMinutes: 60 },
    capabilities: { read: ["helper"], write: [] }
  };
}

function catalogItem(
  sourceId: string,
  title: string,
  itemId: string,
  domain: CatalogDomain = "general",
  itemKind = "church_document"
) {
  return {
    sourceId,
    itemKind,
    domain,
    title,
    storageRef: { provider: "graph" as const, driveId: "drive", itemId }
  };
}

function observation(
  caseId: string,
  recurrenceFamily: RecurrenceFamily,
  override: Partial<KernelCaseObservation>
): KernelCaseObservation {
  return {
    caseId,
    passed: false,
    boundary: "adapter_retrieval",
    recurrenceFamily,
    scheduleAssertions: [],
    coreJourneyEligible: true,
    coreJourneySucceeded: false,
    unavailableEligible: false,
    unavailableMisclassified: false,
    ambiguityEligible: false,
    ambiguityResolvedWithinTwoTurns: false,
    securityViolations: [],
    performanceEligible: true,
    elapsedMs: 25,
    returnedRetrievableJob: false,
    ...override
  };
}
