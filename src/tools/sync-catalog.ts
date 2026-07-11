import { createCatalogStore } from "../catalog/create-catalog-store.js";
import { syncCatalogSources } from "../catalog/sync-service.js";
import { createGraphDriveClient } from "../clients/graph.js";
import { createNotionDatabaseClient } from "../clients/notion.js";
import { loadConfigFromEnv } from "../config.js";
import { createPostgresRuntime } from "../db/postgres.js";
import { createScheduleStore } from "../schedules/create-schedule-store.js";

const config = loadConfigFromEnv(process.env);
const postgres = await createPostgresRuntime(config.database);
const catalog = await createCatalogStore({ db: postgres?.pool });
const schedules = await createScheduleStore({ db: postgres?.pool });

try {
  const graph = config.graph ? createGraphDriveClient(config.graph) : undefined;
  const notion = config.notion ? createNotionDatabaseClient(config.notion) : undefined;
  const result = await syncCatalogSources({
    catalog,
    graph,
    notion,
    notionProperties: config.notion?.properties,
    schedules,
    sources: config.catalog?.sources ?? []
  });
  console.log(JSON.stringify({ ok: true, result }));
} finally {
  await postgres?.pool.end();
}
