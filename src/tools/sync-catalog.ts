import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { syncCatalogSources } from "../catalog/sync-service.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { createNotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { createAzureOpenAiEmbeddingClient } from "../clients/azure-openai-embedding.js";
import { loadConfigFromEnv } from "../config.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createScheduleStore } from "../schedules/create-schedule-store.js";
import { createKnowledgeStore } from "../knowledge/create-store.js";
import { syncScheduledKnowledgeSources } from "../knowledge/scheduled-sync.js";

const config = loadConfigFromEnv(process.env);
const postgres = await createPostgresRuntime(config.database);
const catalog = await createCatalogStore({ db: postgres?.pool });
await seedCatalogSources({
  catalog,
  sources: buildCatalogSourceSeedsForProfiles(process.env, config.profiles)
});
const schedules = await createScheduleStore({ db: postgres?.pool });
const knowledge = await createKnowledgeStore({ db: postgres?.pool });

try {
  const graph = config.graph ? createGraphDriveClient(config.graph) : undefined;
  const notion = config.notion ? createNotionDatabaseClient(config.notion) : undefined;
  const sourceKeys = (process.env.CATALOG_SYNC_SOURCE_KEYS ?? "")
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
    logger: (event) => {
      console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
    }
  });
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
    const notionKnowledge = createNotionKnowledgeClient(config.knowledge.notionToken);
    const embedding = createAzureOpenAiEmbeddingClient({
      apiKey: config.knowledge.embedding.apiKey,
      endpoint: config.knowledge.embedding.endpoint,
      deployment: config.knowledge.embedding.deployment,
      apiVersion: config.knowledge.embedding.apiVersion,
      model: config.knowledge.embedding.model,
      dimensions: config.knowledge.embedding.dimensions,
      timeoutMs: config.knowledge.embedding.timeoutMs
    });
    const requested = new Set(
      (process.env.KNOWLEDGE_SYNC_SOURCE_KEYS ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    );
    const sources = (
      await Promise.all(
        config.profiles.map((profile) =>
          knowledge.listSources({ profileName: profile.name, includeDisabled: false })
        )
      )
    )
      .flat()
      .filter((source) => requested.size === 0 || requested.has(source.sourceKey));
    Object.assign(
      knowledgeResult,
      await syncScheduledKnowledgeSources({
        sources,
        store: knowledge,
        notion: notionKnowledge,
        embedding,
        batchSize: config.knowledge.embedding.batchSize
      })
    );
  }
  await knowledge.purgeExpired(new Date());
  console.log(JSON.stringify({ ok: true, result, knowledge: knowledgeResult }));
} finally {
  await postgres?.pool.end();
}
