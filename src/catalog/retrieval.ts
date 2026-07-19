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
  if (items.length > 0) {
    return {
      status: statuses.includes("fresh") ? "fresh" : "stale_allowed",
      revision,
      items
    };
  }
  if (statuses.includes("fresh")) return { status: "not_found", revision, items };
  if (statuses.includes("stale_allowed")) return { status: "stale_allowed", revision, items };
  return { status: "unavailable", revision, items };
}
