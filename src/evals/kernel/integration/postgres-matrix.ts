import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { FakeToolCallingModel } from "langchain";
import { Pool } from "pg";

import { runAccessMigrations } from "../../../access/migrations.js";
import { runAgentMemoryMigrations } from "../../../agent/migrations.js";
import { createSdkAgent } from "../../../agent/sdk-runtime.js";
import { createPostgresSdkAgentState } from "../../../agent/sdk-state.js";
import { runCatalogMigrations } from "../../../catalog/migrations.js";
import { createPostgresHelperAgentState } from "../../../helper-agent/state.js";
import { PostgresCatalogStore } from "../../../catalog/postgres-store.js";
import { catalogStorageIdentity, type CatalogItemInput } from "../../../catalog/store.js";
import { runKnowledgeMigrations } from "../../../knowledge/migrations.js";
import { PostgresKnowledgeStore } from "../../../knowledge/postgres-store.js";
import { createQueryKnowledgeHandler } from "../../../functions/query-knowledge.js";
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
    },
    {
      caseId: "postgres/sdk-agent/checkpoint-restart-and-expiry",
      boundary: "state_lifecycle",
      run: async () => sdkAgentCheckpointRestartAndExpiry(environment)
    },
    {
      caseId: "postgres/helper-agent/source-ttl-and-reset",
      boundary: "state_lifecycle",
      run: async () => helperAgentSourceTtlAndReset(environment)
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
  "knowledge_revision_not_rotated",
  "knowledge_result_anchors_missing",
  "knowledge_result_anchor_invalid",
  "knowledge_result_source_missing",
  "knowledge_result_anchor_missing",
  "knowledge_scoped_search_missing",
  "sdk_checkpoint_not_persisted",
  "sdk_checkpoint_not_restored",
  "sdk_checkpoint_policy_not_invalidated",
  "sdk_checkpoint_not_deleted",
  "sdk_thread_metadata_not_deleted",
  "helper_direct_ttl_invalid",
  "helper_group_ttl_invalid",
  "helper_checkpoint_not_deleted",
  "helper_failed_run_metadata_retained",
  "helper_state_pool_deadlock",
  "helper_data_pool_not_saturated"
]);

function boundedFailureCode(error: unknown): string {
  return error instanceof Error && MATRIX_FAILURE_CODES.has(error.message)
    ? error.message
    : "postgres_matrix_case_failed";
}

type KernelPgPool = KernelPostgresEnvironment["pools"][number];

async function sdkAgentCheckpointRestartAndExpiry(
  environment: KernelPostgresEnvironment
): Promise<void> {
  const pool = environment.pools[0];
  const checkpointer = new PostgresSaver(pool);
  let now = new Date("2026-09-04T00:00:00.000Z");
  const createState = () =>
    createPostgresSdkAgentState({
      pool,
      checkpointer,
      hmacKey: "kernel-sdk-agent-state-key",
      ttlMs: 1_000,
      now: () => now
    });
  const firstState = createState();
  await checkpointer.setup();
  await firstState.setup();
  const threadId = firstState.threadId({
    profileName: PROFILE,
    source: { type: "group", groupId: "kernel-group", userId: "kernel-user" }
  });
  if (!threadId) throw new Error("sdk_checkpoint_not_persisted");

  const invoke = (
    state: ReturnType<typeof createState>,
    content: string,
    policyKey = "kernel-policy-v1"
  ) =>
    state.run(threadId, policyKey, () =>
      createSdkAgent({
        checkpointer,
        model: new FakeToolCallingModel({ toolCalls: [[]] })
      }).invoke(
        { messages: [{ role: "user", content }] },
        { configurable: { thread_id: threadId } }
      )
    );

  const first = await invoke(firstState, "first");
  if (first.messages.length < 2) throw new Error("sdk_checkpoint_not_persisted");
  const secondState = createState();
  await secondState.setup();
  const second = await invoke(secondState, "second");
  if (second.messages.length <= first.messages.length) {
    throw new Error("sdk_checkpoint_not_restored");
  }
  const changedPolicy = await invoke(secondState, "third", "kernel-policy-v2");
  if (changedPolicy.messages.length >= second.messages.length) {
    throw new Error("sdk_checkpoint_policy_not_invalidated");
  }

  now = new Date("2026-09-04T00:00:02.000Z");
  if ((await secondState.cleanupExpired()) !== 1) {
    throw new Error("sdk_thread_metadata_not_deleted");
  }
  const [checkpointRows, threadRows] = await Promise.all([
    pool.query("select 1 from checkpoints where thread_id = $1 limit 1", [threadId]),
    pool.query("select 1 from agent_sdk_threads where thread_id = $1", [threadId])
  ]);
  if (checkpointRows.rowCount) throw new Error("sdk_checkpoint_not_deleted");
  if (threadRows.rowCount) throw new Error("sdk_thread_metadata_not_deleted");
}

async function helperAgentSourceTtlAndReset(environment: KernelPostgresEnvironment): Promise<void> {
  const pool = new Pool({ ...environment.pools[0].options, max: 1 });
  try {
    const checkpointer = new PostgresSaver(pool);
    const now = new Date("2026-09-04T00:00:00.000Z");
    const state = createPostgresHelperAgentState({
      pool,
      lockPool: environment.pools[1],
      checkpointer,
      hmacKey: "kernel-helper-agent-state-key",
      now: () => now
    });
    await checkpointer.setup();
    await state.setup();
    const direct = state.threadId({
      profileName: PROFILE,
      source: { type: "user", userId: "kernel-direct-user" }
    });
    const group = state.threadId({
      profileName: PROFILE,
      source: { type: "group", groupId: "kernel-group", userId: "kernel-group-user" }
    });
    if (!direct || !group) throw new Error("helper_checkpoint_not_deleted");
    const groupSource = { type: "group", groupId: "kernel-group", userId: "kernel-group-user" };
    await state.allowExternalSheetMusic(group, groupSource, new Date("2026-09-04T00:01:00.000Z"));

    const invoke = (threadId: string, source: { type: string; userId: string; groupId?: string }) =>
      state.run({
        threadId,
        policyKey: "kernel-policy-v1",
        source,
        task: () =>
          createSdkAgent({
            checkpointer,
            model: new FakeToolCallingModel({ toolCalls: [[]] })
          }).invoke(
            { messages: [{ role: "user", content: "kernel" }] },
            { configurable: { thread_id: threadId } }
          )
      });

    if (pool.options.max !== 1) throw new Error("helper_data_pool_not_saturated");
    await withinHelperStateTimeout(invoke(direct, { type: "user", userId: "kernel-direct-user" }));
    await invoke(group, groupSource);
    const metadata = await pool.query<{ thread_id: string; expires_at: Date }>(
      "select thread_id, expires_at from agent_sdk_threads where thread_id = any($1::text[])",
      [[direct, group]]
    );
    const expiresAt = new Map(metadata.rows.map((row) => [row.thread_id, row.expires_at]));
    if (expiresAt.get(direct)?.getTime() !== now.getTime() + 30 * 60_000) {
      throw new Error("helper_direct_ttl_invalid");
    }
    if (expiresAt.get(group)?.getTime() !== now.getTime() + 15 * 60_000) {
      throw new Error("helper_group_ttl_invalid");
    }

    await state.reset(group);
    const checkpoint = await pool.query("select 1 from checkpoints where thread_id = $1 limit 1", [
      group
    ]);
    if (checkpoint.rowCount) throw new Error("helper_checkpoint_not_deleted");

    const failed = state.threadId({
      profileName: PROFILE,
      source: { type: "group", groupId: "kernel-failed-group", userId: "kernel-failed-user" }
    });
    if (!failed) throw new Error("helper_failed_run_metadata_retained");
    const failedSource = {
      type: "group",
      groupId: "kernel-failed-group",
      userId: "kernel-failed-user"
    };
    await invoke(failed, failedSource);
    await state.allowExternalSheetMusic(failed, failedSource, new Date("2026-09-04T00:01:00.000Z"));
    try {
      await withinHelperStateTimeout(
        state.run({
          threadId: failed,
          policyKey: "kernel-policy-v1",
          source: failedSource,
          task: async () => {
            throw new ReviewCreationDenied();
          }
        })
      );
    } catch (error) {
      if (!(error instanceof ReviewCreationDenied)) {
        throw error;
      }
    }
    const [failedMetadata, failedCheckpoint] = await Promise.all([
      pool.query("select 1 from agent_sdk_threads where thread_id = $1", [failed]),
      pool.query("select 1 from checkpoints where thread_id = $1 limit 1", [failed])
    ]);
    if (failedMetadata.rowCount || failedCheckpoint.rowCount) {
      throw new Error("helper_failed_run_metadata_retained");
    }
  } finally {
    await pool.end();
  }
}

class ReviewCreationDenied extends Error {}

async function withinHelperStateTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("helper_state_pool_deadlock")), 5_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    embeddings: [
      {
        documentExternalId: "doc-opaque-1",
        contentHash: "stable-content",
        provider: "azure_openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        embedding: oneHotVector()
      }
    ]
  });
  assert(
    (await right.search({ profileName: PROFILE, query: "Stable content" })).length === 1,
    "knowledge_baseline_not_searchable"
  );
  await assertKnowledgeResultAnchor(right);

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

async function assertKnowledgeResultAnchor(store: PostgresKnowledgeStore): Promise<void> {
  const handler = createQueryKnowledgeHandler({
    store,
    embedding: {
      provider: "azure_openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      async embed() {
        return [oneHotVector()];
      }
    },
    textGenerator: {
      providerName: "deepseek",
      async completeText() {
        return "Synthetic answer";
      }
    }
  });
  const profile = {
    name: PROFILE,
    webhookPath: `/api/line/webhook/${PROFILE}`,
    channelSecret: "synthetic-secret",
    channelAccessToken: "synthetic-token",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text" as const],
    groupRequireWakeWord: false,
    wakeKeywords: [],
    acceptMention: true,
    enabledFunctions: ["query_knowledge" as const],
    permissionRequiredFunctions: [],
    allowedProviders: ["deepseek" as const],
    allowSubscriptionProviders: false,
    schedulePolicy: { meetingWindows: [], domains: [] }
  };
  const event = {
    type: "message" as const,
    source: { type: "user" as const, userId: "U_KERNEL" },
    message: { type: "text" as const, text: "Stable content" }
  };
  const first = await handler({ query: "Stable content" }, { profile, event });
  const anchors = first.agentResult?.anchors;
  assert(anchors, "knowledge_result_anchors_missing");
  const sourceId = anchors.sourceId;
  const documentId = anchors.documentId;
  const sectionKey = anchors.sectionKey;
  assert(
    typeof sourceId === "string" &&
      typeof documentId === "string" &&
      typeof sectionKey === "string",
    "knowledge_result_anchor_invalid"
  );
  assert(
    (await store.listSources({ profileName: PROFILE })).some(({ id }) => id === sourceId),
    "knowledge_result_source_missing"
  );
  assert(
    await store.hasAnchor({ profileName: PROFILE, sourceId, documentId, sectionKey }),
    "knowledge_result_anchor_missing"
  );
  assert(
    (
      await store.search({
        profileName: PROFILE,
        query: "Follow-up content",
        queryEmbedding: oneHotVector(),
        embeddingProvider: "azure_openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        sourceId,
        documentId,
        sectionKey,
        ordinal: 0
      })
    ).length > 0,
    "knowledge_scoped_search_missing"
  );
}

function oneHotVector(): number[] {
  return Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
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
