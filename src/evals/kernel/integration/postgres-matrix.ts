import { runAccessMigrations } from "../../../access/migrations.js";
import { runAgentMemoryMigrations } from "../../../agent/migrations.js";
import { runCatalogMigrations } from "../../../catalog/migrations.js";
import { PostgresCatalogStore } from "../../../catalog/postgres-store.js";
import { catalogStorageIdentity, type CatalogItemInput } from "../../../catalog/store.js";
import { runKnowledgeMigrations } from "../../../knowledge/migrations.js";
import { PostgresKnowledgeStore } from "../../../knowledge/postgres-store.js";
import { runScheduleMigrations } from "../../../schedules/migrations.js";
import type { KernelBoundary } from "../contracts.js";
import type { KernelIntegrationCaseResult } from "./redis-matrix.js";
import type { KernelPostgresEnvironment } from "./environment.js";

const PROFILE = "kernel-profile";
const PUBLISHED_AT = "2026-07-21T12:00:00.000Z";

export async function runPostgresIntegrationMatrix(
  environment: KernelPostgresEnvironment
): Promise<KernelIntegrationCaseResult[]> {
  const cases: Array<{
    caseId: string;
    boundary: KernelBoundary;
    run: () => Promise<void>;
  }> = [
    {
      caseId: "postgres/migrations/fresh-idempotent",
      boundary: "deployment_configuration",
      run: async () => freshMigrations(environment)
    },
    {
      caseId: "postgres/catalog/concurrent-publication",
      boundary: "freshness_invalidation",
      run: async () => catalogConcurrentPublication(environment)
    },
    {
      caseId: "postgres/catalog/rollback-and-visibility",
      boundary: "adapter_retrieval",
      run: async () => catalogRollbackAndVisibility(environment)
    },
    {
      caseId: "postgres/knowledge/rollback-and-stale-failure",
      boundary: "adapter_retrieval",
      run: async () => knowledgeRollbackAndStaleFailure(environment)
    }
  ];

  const results: KernelIntegrationCaseResult[] = [];
  for (const entry of cases) {
    try {
      await entry.run();
      results.push({ caseId: entry.caseId, boundary: entry.boundary, passed: true });
    } catch (error) {
      results.push({
        caseId: entry.caseId,
        boundary: entry.boundary,
        passed: false,
        failureCode: boundedFailureCode(error)
      });
    }
  }
  return results;
}

const MATRIX_FAILURE_CODES = new Set([
  "catalog_baseline_not_published",
  "catalog_multiple_winners",
  "catalog_mixed_snapshot",
  "catalog_winner_missing",
  "catalog_source_missing",
  "catalog_prior_snapshot_missing",
  "catalog_wrong_scope_not_rejected",
  "catalog_prior_snapshot_lost",
  "catalog_prior_snapshot_changed",
  "catalog_stale_failure_updated_health",
  "catalog_immediate_visibility_missing",
  "catalog_health_not_ready",
  "catalog_raw_source_mismatch",
  "catalog_raw_items_mismatch",
  "catalog_loser_mutated_items",
  "knowledge_baseline_not_searchable",
  "knowledge_invalid_embedding_not_rejected",
  "knowledge_baseline_lost_after_rollback",
  "knowledge_rollback_exposed_document",
  "knowledge_stale_failure_not_rejected",
  "knowledge_ready_health_overwritten",
  "knowledge_routing_metadata_overwritten",
  "knowledge_revision_not_rotated"
]);

function boundedFailureCode(error: unknown): string {
  return error instanceof Error && MATRIX_FAILURE_CODES.has(error.message)
    ? error.message
    : "postgres_matrix_case_failed";
}

type KernelPgPool = KernelPostgresEnvironment["pools"][number];

async function installCatalogOverlapTrigger(pool: KernelPgPool): Promise<void> {
  await pool.query(`
    create or replace function kernel_catalog_overlap_delay()
    returns trigger language plpgsql as $$
    begin
      perform pg_sleep(0.5);
      return new;
    end
    $$;
    drop trigger if exists kernel_catalog_overlap_delay on catalog_items;
    create trigger kernel_catalog_overlap_delay
    before insert or update on catalog_items
    for each row execute function kernel_catalog_overlap_delay();
  `);
}

async function assertRawCatalogSnapshotState(
  pool: KernelPgPool,
  input: {
    sourceId: string;
    baselineRevision: string;
    baselineIdentity: string;
    winnerIdentity: string;
    loserIdentity: string;
  }
): Promise<void> {
  const source = await rawCatalogSource(pool, input.sourceId);
  assert(
    source.revision === (BigInt(input.baselineRevision) + 1n).toString() &&
      source.sync_cursor === null &&
      source.health_status === "ready" &&
      Number(source.published_item_count) === 1,
    "catalog_raw_source_mismatch"
  );
  const rows = await rawCatalogItems(pool, input.sourceId);
  assert(
    !rows.some((row) => row.storage_identity === input.loserIdentity),
    "catalog_loser_mutated_items"
  );
  assert(
    rows.length === 2 &&
      rows.some(
        (row) => row.storage_identity === input.baselineIdentity && row.deleted_at !== null
      ) &&
      rows.some((row) => row.storage_identity === input.winnerIdentity && row.deleted_at === null),
    "catalog_raw_items_mismatch"
  );
}

async function assertRawCatalogDeltaState(
  pool: KernelPgPool,
  input: {
    sourceId: string;
    baselineRevision: string;
    baselineIdentity: string;
    winnerIdentity: string;
    loserIdentity: string;
    winnerCursor: string;
  }
): Promise<void> {
  const source = await rawCatalogSource(pool, input.sourceId);
  assert(
    source.revision === (BigInt(input.baselineRevision) + 1n).toString() &&
      source.sync_cursor === input.winnerCursor &&
      source.health_status === "ready" &&
      Number(source.published_item_count) === 2,
    "catalog_raw_source_mismatch"
  );
  const rows = await rawCatalogItems(pool, input.sourceId);
  assert(
    !rows.some((row) => row.storage_identity === input.loserIdentity),
    "catalog_loser_mutated_items"
  );
  assert(
    rows.length === 2 &&
      rows.every((row) => row.deleted_at === null) &&
      rows.some((row) => row.storage_identity === input.baselineIdentity) &&
      rows.some((row) => row.storage_identity === input.winnerIdentity),
    "catalog_raw_items_mismatch"
  );
}

async function rawCatalogSource(pool: KernelPgPool, sourceId: string) {
  const result = await pool.query<{
    revision: string;
    sync_cursor: string | null;
    health_status: string;
    published_item_count: number | string;
  }>(
    `select revision, sync_cursor, health_status, published_item_count
     from catalog_sources where id=$1`,
    [sourceId]
  );
  const source = result.rows[0];
  assert(source, "catalog_raw_source_mismatch");
  return source;
}

async function rawCatalogItems(pool: KernelPgPool, sourceId: string) {
  return (
    await pool.query<{
      storage_identity: string;
      deleted_at: Date | string | null;
    }>(
      `select storage_identity, deleted_at
       from catalog_items where source_id=$1 order by storage_identity`,
      [sourceId]
    )
  ).rows;
}

async function freshMigrations(environment: KernelPostgresEnvironment): Promise<void> {
  const [pool] = environment.pools;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await runScheduleMigrations(pool);
    await runCatalogMigrations(pool);
    await runAgentMemoryMigrations(pool);
    await runAccessMigrations(pool);
    await runKnowledgeMigrations(pool);
  }
}

async function catalogConcurrentPublication(environment: KernelPostgresEnvironment): Promise<void> {
  const [leftPool, rightPool] = environment.pools;
  const left = new PostgresCatalogStore(leftPool);
  const right = new PostgresCatalogStore(rightPool);
  await installCatalogOverlapTrigger(leftPool);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const source = await left.upsertSource({
      profileName: PROFILE,
      sourceKey: `catalog-concurrent-delta-${attempt}`,
      adapterType: "manual",
      domain: "general",
      defaultItemKind: "document",
      rootLocation: {},
      enabled: true,
      syncPolicy: { mode: "manual" },
      capabilities: { read: ["search"], write: [] }
    });
    const baseline = await left.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: source.revision,
      items: [catalogItem(source.id, `delta-baseline-${attempt}`, "Delta baseline")],
      publishedAt: PUBLISHED_AT
    });
    assert(baseline, "catalog_baseline_not_published");
    const firstItem = catalogItem(source.id, `delta-a-${attempt}`, "Delta A");
    const secondItem = catalogItem(source.id, `delta-b-${attempt}`, "Delta B");
    const [first, second] = await Promise.all([
      left.publishSourceDelta({
        sourceId: source.id,
        expectedRevision: baseline.revision,
        upserts: [firstItem],
        deletedStorageIdentities: [],
        syncCursor: "cursor-a",
        publishedAt: "2026-07-21T12:00:30.000Z"
      }),
      right.publishSourceDelta({
        sourceId: source.id,
        expectedRevision: baseline.revision,
        upserts: [secondItem],
        deletedStorageIdentities: [],
        syncCursor: "cursor-b",
        publishedAt: "2026-07-21T12:00:31.000Z"
      })
    ]);
    assert(Number(Boolean(first)) + Number(Boolean(second)) === 1, "catalog_multiple_winners");
    const visible = await right.searchItems({
      profileName: PROFILE,
      allowedSourceKeys: [source.sourceKey],
      limit: 10
    });
    assert(visible.length === 2, "catalog_mixed_snapshot");
    assert(
      visible.some((item) => item.title === "Delta baseline") &&
        visible.filter((item) => ["Delta A", "Delta B"].includes(item.title)).length === 1,
      "catalog_winner_missing"
    );
    await assertRawCatalogDeltaState(leftPool, {
      sourceId: source.id,
      baselineRevision: baseline.revision,
      baselineIdentity: catalogStorageIdentity(
        catalogItem(source.id, `delta-baseline-${attempt}`, "Delta baseline").storageRef
      ),
      winnerIdentity: catalogStorageIdentity((first ? firstItem : secondItem).storageRef),
      loserIdentity: catalogStorageIdentity((first ? secondItem : firstItem).storageRef),
      winnerCursor: first ? "cursor-a" : "cursor-b"
    });
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const source = await left.upsertSource({
      profileName: PROFILE,
      sourceKey: `catalog-concurrent-${attempt}`,
      adapterType: "manual",
      domain: "general",
      defaultItemKind: "document",
      rootLocation: {},
      enabled: true,
      syncPolicy: { mode: "manual" },
      capabilities: { read: ["search"], write: [] }
    });
    const baseline = await left.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: source.revision,
      items: [catalogItem(source.id, `baseline-${attempt}`, "Baseline item")],
      publishedAt: PUBLISHED_AT
    });
    assert(baseline, "catalog_baseline_not_published");

    const firstItem = catalogItem(source.id, `winner-a-${attempt}`, "Winner A");
    const secondItem = catalogItem(source.id, `winner-b-${attempt}`, "Winner B");
    const [first, second] = await Promise.all([
      left.publishSourceSnapshot({
        sourceId: source.id,
        expectedRevision: baseline.revision,
        items: [firstItem],
        publishedAt: "2026-07-21T12:01:00.000Z"
      }),
      right.publishSourceSnapshot({
        sourceId: source.id,
        expectedRevision: baseline.revision,
        items: [secondItem],
        publishedAt: "2026-07-21T12:01:01.000Z"
      })
    ]);
    assert(Number(Boolean(first)) + Number(Boolean(second)) === 1, "catalog_multiple_winners");

    const visible = await right.searchItems({
      profileName: PROFILE,
      allowedSourceKeys: [source.sourceKey],
      limit: 10
    });
    assert(visible.length === 1, "catalog_mixed_snapshot");
    assert(["Winner A", "Winner B"].includes(visible[0]!.title), "catalog_winner_missing");
    await assertRawCatalogSnapshotState(leftPool, {
      sourceId: source.id,
      baselineRevision: baseline.revision,
      baselineIdentity: catalogStorageIdentity(
        catalogItem(source.id, `baseline-${attempt}`, "Baseline item").storageRef
      ),
      winnerIdentity: catalogStorageIdentity((first ? firstItem : secondItem).storageRef),
      loserIdentity: catalogStorageIdentity((first ? secondItem : firstItem).storageRef)
    });
  }
}

async function catalogRollbackAndVisibility(environment: KernelPostgresEnvironment): Promise<void> {
  const [leftPool, rightPool] = environment.pools;
  const left = new PostgresCatalogStore(leftPool);
  const right = new PostgresCatalogStore(rightPool);
  const source = await left.upsertSource({
    profileName: PROFILE,
    sourceKey: "catalog-rollback",
    adapterType: "manual",
    domain: "general",
    defaultItemKind: "document",
    rootLocation: {},
    enabled: true,
    syncPolicy: { mode: "manual" },
    capabilities: { read: ["search"], write: [] }
  });
  const published = await left.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: source.revision,
    items: [catalogItem(source.id, "rollback-baseline", "Rollback baseline")],
    publishedAt: PUBLISHED_AT
  });
  assert(published, "catalog_baseline_not_published");
  const prior = await left.searchItems({
    profileName: PROFILE,
    allowedSourceKeys: [source.sourceKey],
    limit: 10
  });
  assert(prior.length === 1, "catalog_prior_snapshot_missing");

  let rejectedWrongScope = false;
  try {
    await left.publishSourceSnapshot({
      sourceId: source.id,
      expectedRevision: published.revision,
      items: [catalogItem("00000000-0000-0000-0000-000000000000", "wrong", "Wrong scope")],
      publishedAt: "2026-07-21T12:02:00.000Z"
    });
  } catch {
    rejectedWrongScope = true;
  }
  assert(rejectedWrongScope, "catalog_wrong_scope_not_rejected");

  const afterFailure = await right.searchItems({
    profileName: PROFILE,
    allowedSourceKeys: [source.sourceKey],
    limit: 10
  });
  assert(afterFailure.length === 1, "catalog_prior_snapshot_lost");
  assert(afterFailure[0]!.id === prior[0]!.id, "catalog_prior_snapshot_changed");
  const staleFailure = await right.markSourceSyncFailure({
    sourceId: source.id,
    expectedRevision: source.revision,
    failedAt: "2026-07-21T12:03:00.000Z",
    errorCode: "synthetic_failure"
  });
  assert(staleFailure === undefined, "catalog_stale_failure_updated_health");

  await left.upsertItem(catalogItem(source.id, "immediate", "Immediate visibility"));
  const immediate = await right.searchItems({
    profileName: PROFILE,
    query: "Immediate visibility",
    allowedSourceKeys: [source.sourceKey]
  });
  assert(immediate.length === 1, "catalog_immediate_visibility_missing");
  const refreshed = (
    await right.listSources({ profileName: PROFILE, sourceKeys: [source.sourceKey] })
  )[0];
  assert(refreshed?.healthStatus === "ready", "catalog_health_not_ready");
}

async function knowledgeRollbackAndStaleFailure(
  environment: KernelPostgresEnvironment
): Promise<void> {
  const [leftPool, rightPool] = environment.pools;
  const left = new PostgresKnowledgeStore(leftPool);
  const right = new PostgresKnowledgeStore(rightPool);
  const source = await left.upsertSource({
    profileName: PROFILE,
    sourceKey: "knowledge-atomic",
    displayName: "Synthetic knowledge",
    adapterType: "notion",
    externalRootId: "root-opaque-1",
    rootUrl: "https://example.invalid/root-opaque-1",
    enabled: true,
    aliases: ["synthetic"],
    topics: ["atomic"],
    sampleQueries: ["stable content"]
  });
  const first = await left.publishSourceSnapshot({
    sourceId: source.id,
    expectedStagingRevision: source.stagingRevision,
    syncedAt: PUBLISHED_AT,
    syncStatus: "ready",
    routingDisplayName: "Synthetic knowledge",
    aliases: ["synthetic"],
    topics: ["atomic"],
    sampleQueries: ["stable content"],
    documents: [knowledgeDocument("doc-opaque-1", "stable-content", "Stable content")],
    embeddings: []
  });
  assert(
    (await right.search({ profileName: PROFILE, query: "Stable content" })).length === 1,
    "knowledge_baseline_not_searchable"
  );

  const staged = await left.upsertSource({
    profileName: PROFILE,
    sourceKey: source.sourceKey,
    displayName: "Synthetic knowledge staged",
    adapterType: "notion",
    externalRootId: "root-opaque-2",
    rootUrl: "https://example.invalid/root-opaque-2",
    enabled: true,
    aliases: ["staged"],
    topics: ["rollback"],
    sampleQueries: ["uncommitted content"]
  });
  let rolledBack = false;
  try {
    await left.publishSourceSnapshot({
      sourceId: source.id,
      expectedStagingRevision: staged.stagingRevision,
      syncedAt: "2026-07-21T12:04:00.000Z",
      syncStatus: "ready",
      routingDisplayName: "Synthetic knowledge staged",
      aliases: ["staged"],
      topics: ["rollback"],
      sampleQueries: ["uncommitted content"],
      documents: [knowledgeDocument("doc-opaque-2", "uncommitted-content", "Uncommitted content")],
      embeddings: [
        {
          documentExternalId: "doc-opaque-2",
          contentHash: "uncommitted-content",
          provider: "synthetic",
          model: "synthetic",
          dimensions: 3,
          embedding: [0, 0, 0]
        }
      ]
    });
  } catch {
    rolledBack = true;
  }
  assert(rolledBack, "knowledge_invalid_embedding_not_rejected");
  assert(
    (await right.search({ profileName: PROFILE, query: "Stable content" })).length === 1,
    "knowledge_baseline_lost_after_rollback"
  );
  assert(
    (await right.search({ profileName: PROFILE, query: "Uncommitted content" })).length === 0,
    "knowledge_rollback_exposed_document"
  );

  const promoted = await right.publishSourceSnapshot({
    sourceId: source.id,
    expectedStagingRevision: staged.stagingRevision,
    syncedAt: "2026-07-21T12:05:00.000Z",
    syncStatus: "ready",
    routingDisplayName: "Synthetic knowledge promoted",
    aliases: ["promoted"],
    topics: ["ready"],
    sampleQueries: ["promoted content"],
    documents: [knowledgeDocument("doc-opaque-3", "promoted-content", "Promoted content")],
    embeddings: []
  });
  const stale = await left.markSourceSyncFailed({
    profileName: PROFILE,
    sourceKey: source.sourceKey,
    expectedStagingRevision: staged.stagingRevision,
    syncErrorCode: "synthetic_stale_failure"
  });
  assert(stale === "stale", "knowledge_stale_failure_not_rejected");
  const visible = (await right.listSources({ profileName: PROFILE, includeDisabled: true })).find(
    (candidate) => candidate.id === source.id
  );
  assert(visible?.syncStatus === "ready", "knowledge_ready_health_overwritten");
  assert(
    visible.routingDisplayName === "Synthetic knowledge promoted",
    "knowledge_routing_metadata_overwritten"
  );
  assert(promoted.stagingRevision !== first.stagingRevision, "knowledge_revision_not_rotated");
}

function catalogItem(sourceId: string, identity: string, title: string): CatalogItemInput {
  return {
    sourceId,
    itemKind: "document",
    domain: "general",
    title,
    storageRef: {
      provider: "external_link",
      url: `https://example.invalid/${identity}`
    }
  };
}

function knowledgeDocument(externalId: string, contentHash: string, content: string) {
  return {
    externalId,
    title: `Title ${externalId}`,
    url: `https://example.invalid/${externalId}`,
    nodes: [{ externalId: `${externalId}-node`, type: "paragraph", ordinal: 0, text: content }],
    chunks: [{ headingPath: ["Section"], ordinal: 0, content, contentHash }]
  };
}

function assert(condition: unknown, failureCode: string): asserts condition {
  if (!condition) throw new Error(failureCode);
}
