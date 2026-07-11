import { runCatalogMigrations } from "./migrations.js";
import { InMemoryCatalogStore, type CatalogStore } from "./store.js";
import { PostgresCatalogStore, type PgQueryable } from "./postgres-store.js";

export interface CreateCatalogStoreOptions {
  db?: PgQueryable;
}

export async function createCatalogStore(
  options: CreateCatalogStoreOptions
): Promise<CatalogStore> {
  if (!options.db) {
    return new InMemoryCatalogStore();
  }
  await runCatalogMigrations(options.db);
  return new PostgresCatalogStore(options.db);
}
