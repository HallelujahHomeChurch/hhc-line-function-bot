import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { syncCatalogSources } from "../catalog/sync-service.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { createNotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { createAzureOpenAiEmbeddingClient } from "../clients/azure-openai-embedding.js";
import { loadCatalogSyncConfigFromEnv } from "../config.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createScheduleStore } from "../schedules/create-schedule-store.js";
import { createKnowledgeStore } from "../knowledge/create-store.js";
import { syncScheduledKnowledgeSources } from "../knowledge/scheduled-sync.js";

import { pathToFileURL } from "node:url";
import { createCatalogSyncPostgres } from "./catalog-sync-postgres.js";
import { createCatalogNotionFetch } from "./catalog-notion-fetch.js";

export async function runCatalogSync(
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal } = {}
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const deadline = Date.now() + 540_000;
  const timer = setTimeout(
    () => controller.abort(new DOMException("catalog_sync_deadline", "TimeoutError")),
    540_000
  );
  const stop = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const notionFetch = createCatalogNotionFetch(signal);
  let owned: ReturnType<typeof createCatalogSyncPostgres> | undefined;
  const work = async () => {
    signal.throwIfAborted();
    const config = loadCatalogSyncConfigFromEnv(env);
    signal.throwIfAborted();
    owned = config.database
      ? createCatalogSyncPostgres(config.database, { signal, deadline })
      : undefined;
    const postgres = await createPostgresRuntime(config.database, owned);
    signal.throwIfAborted();
    const catalog = await createCatalogStore({ db: postgres?.pool });
    signal.throwIfAborted();
    await seedCatalogSources({
      catalog,
      sources: buildCatalogSourceSeedsForProfiles(env, config.profiles)
    });
    signal.throwIfAborted();
    const schedules = await createScheduleStore({ db: postgres?.pool });
    signal.throwIfAborted();
    const knowledge = await createKnowledgeStore({ db: postgres?.pool });
    signal.throwIfAborted();
    const graph = config.graph
      ? createGraphDriveClient(config.graph, { signal, noRetry: true })
      : undefined;
    const notion = config.notion
      ? createNotionDatabaseClient(config.notion, {
          signal,
          fetch: notionFetch.fetch,
          noRetry: true
        })
      : undefined;
    const sourceKeys = (env.CATALOG_SYNC_SOURCE_KEYS ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const result = await syncCatalogSources({
      catalog,
      graph,
      notion,
      notionProperties: config.notion?.properties,
      schedules,
      sourceKeys: sourceKeys.length ? sourceKeys : undefined,
      signal,
      logger: (event) => {
        console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
      }
    });
    signal.throwIfAborted();
    const knowledgeResult = {
      sources: 0,
      synced: 0,
      failed: 0,
      stale: 0,
      documents: 0,
      chunks: 0,
      embedded: 0
    };
    if (config.knowledge) {
      const notionKnowledge = createNotionKnowledgeClient(config.knowledge.notionToken, {
        signal,
        fetch: notionFetch.fetch,
        noRetry: true
      });
      const embedding = createAzureOpenAiEmbeddingClient({
        apiKey: config.knowledge.embedding.apiKey,
        endpoint: config.knowledge.embedding.endpoint,
        deployment: config.knowledge.embedding.deployment,
        apiVersion: config.knowledge.embedding.apiVersion,
        model: config.knowledge.embedding.model,
        dimensions: config.knowledge.embedding.dimensions,
        timeoutMs: config.knowledge.embedding.timeoutMs,
        signal
      });
      const requested = new Set(
        (env.KNOWLEDGE_SYNC_SOURCE_KEYS ?? "")
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean)
      );
      signal.throwIfAborted();
      const listed = await Promise.allSettled(
        config.profiles.map((profile) =>
          knowledge.listSources({ profileName: profile.name, includeDisabled: false })
        )
      );
      signal.throwIfAborted();
      const sources: Awaited<ReturnType<typeof knowledge.listSources>> = [];
      const listErrors: unknown[] = [];
      for (const result of listed) {
        if (result.status === "fulfilled") sources.push(...result.value);
        else listErrors.push(result.reason);
      }
      if (listErrors.length === 1) throw listErrors[0];
      if (listErrors.length > 1)
        throw new AggregateError(listErrors, "catalog_knowledge_sources_failed", {
          cause: listErrors[0]
        });
      const selected = sources.filter(
        (source) => requested.size === 0 || requested.has(source.sourceKey)
      );
      Object.assign(
        knowledgeResult,
        await syncScheduledKnowledgeSources({
          sources: selected,
          store: knowledge,
          notion: notionKnowledge,
          embedding,
          batchSize: config.knowledge.embedding.batchSize,
          signal
        })
      );
    }
    signal.throwIfAborted();
    await knowledge.purgeExpired(new Date());
    signal.throwIfAborted();
    return { result, knowledge: knowledgeResult };
  };
  let outcome: Awaited<ReturnType<typeof work>> | undefined;
  const errors: unknown[] = [];
  try {
    outcome = await work();
  } catch (error) {
    if (signal.aborted && signal.reason !== error) errors.push(signal.reason);
    errors.push(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    controller.abort(new DOMException("catalog_sync_scope_closed", "AbortError"));
    const closed = await Promise.allSettled([notionFetch.close(), owned?.close()]);
    for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "catalog_sync_failed", { cause: errors[0] });
  if (!outcome) throw new Error("catalog_sync_no_result");
  return outcome;
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort(new DOMException("catalog_sync_signal", "AbortError"));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const outcome = await runCatalogSync(process.env, { signal: controller.signal });
    console.log(JSON.stringify({ ok: true, ...outcome }));
  } catch {
    console.error(JSON.stringify({ ok: false, error: "catalog_sync_failed" }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
