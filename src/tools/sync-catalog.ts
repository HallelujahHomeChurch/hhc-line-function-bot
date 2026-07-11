import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { buildCatalogSourceSeedsForProfiles, seedCatalogSources } from "../catalog/source-seeds.js";
import { syncCatalogSources } from "../catalog/sync-service.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { loadConfigFromEnv } from "../config.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createScheduleStore } from "../schedules/create-schedule-store.js";

const config = loadConfigFromEnv(process.env);
const postgres = await createPostgresRuntime(config.database);
const catalog = await createCatalogStore({ db: postgres?.pool });
await seedCatalogSources({
  catalog,
  sources: buildCatalogSourceSeedsForProfiles(process.env, config.profiles)
});
const schedules = await createScheduleStore({ db: postgres?.pool });

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
  console.log(JSON.stringify({ ok: true, result }));
} finally {
  await postgres?.pool.end();
}
