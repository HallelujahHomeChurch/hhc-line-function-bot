import {
  catalogSourceFreshness,
  type CatalogItemRecord,
  type CatalogSearchInput,
  type CatalogStore
} from "./store.js";

export type CatalogRetrievalStatus = "fresh" | "stale_allowed" | "unavailable" | "not_found";

export interface CatalogRetrievalResult {
  status: CatalogRetrievalStatus;
  revision: string;
  items: CatalogItemRecord[];
  dataAsOf?: string;
}

export async function searchCatalogWithFreshness(input: {
  catalog: CatalogStore;
  search: CatalogSearchInput;
  now?: Date;
}): Promise<CatalogRetrievalResult> {
  const sources = (
    await input.catalog.listSources({
      profileName: input.search.profileName,
      enabled: true,
      sourceKeys: input.search.allowedSourceKeys
    })
  ).filter(
    (source) => !input.search.domains?.length || input.search.domains.includes(source.domain)
  );
  const items = await input.catalog.searchItems(input.search);
  const relevant = items.length
    ? sources.filter((source) => items.some((item) => item.source.id === source.id))
    : sources;
  const statuses = relevant.map((source) => catalogSourceFreshness(source, input.now));
  const revision = relevant
    .map(({ sourceKey, revision: value }) => `${sourceKey}:${value}`)
    .sort()
    .join("|");
  const dataAsOf = oldestPublishedAt(relevant.map((source) => source.lastSuccessAt));
  if (items.length > 0) {
    return {
      status: statuses.includes("fresh") ? "fresh" : "stale_allowed",
      revision,
      items,
      dataAsOf
    };
  }
  if (statuses.includes("fresh")) return { status: "not_found", revision, items, dataAsOf };
  if (statuses.includes("stale_allowed")) {
    return { status: "stale_allowed", revision, items, dataAsOf };
  }
  return { status: "unavailable", revision, items, dataAsOf };
}

function oldestPublishedAt(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}
