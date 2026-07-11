import { randomUUID } from "node:crypto";

import type { AgentResourceStorage } from "../types.js";

export type CatalogAdapterType = "onedrive" | "notion" | "manual";
export type CatalogDomain = "presentation" | "sheet_music" | "schedule" | "audio" | "general";
export type CatalogSyncMode = "scheduled" | "manual";

export interface CatalogSourceInput {
  profileName: string;
  sourceKey: string;
  adapterType: CatalogAdapterType;
  domain: CatalogDomain | string;
  defaultItemKind: string;
  rootLocation: Record<string, string>;
  enabled: boolean;
  syncPolicy: {
    mode: CatalogSyncMode;
    intervalMinutes?: number;
  };
  capabilities: {
    read: string[];
    write: string[];
  };
}

export interface CatalogSourceRecord extends CatalogSourceInput {
  id: string;
}

export interface CatalogItemInput {
  sourceId: string;
  itemKind: string;
  domain: CatalogDomain | string;
  title: string;
  normalizedTitle?: string;
  path?: string;
  mimeType?: string;
  extension?: string;
  sizeBytes?: number;
  sha256?: string;
  storageRef: AgentResourceStorage;
  externalUpdatedAt?: string;
  deletedAt?: string;
}

export interface CatalogItemRecord extends CatalogItemInput {
  id: string;
  normalizedTitle: string;
  source: CatalogSourceRecord;
}

export interface CatalogSearchInput {
  profileName: string;
  query?: string;
  itemKinds?: string[];
  domains?: string[];
  allowedSourceKeys?: string[];
  limit?: number;
}

export interface CatalogStore {
  upsertSource(input: CatalogSourceInput): Promise<CatalogSourceRecord>;
  upsertItem(input: CatalogItemInput): Promise<CatalogItemRecord>;
  searchItems(input: CatalogSearchInput): Promise<CatalogItemRecord[]>;
}

export class InMemoryCatalogStore implements CatalogStore {
  private readonly sources = new Map<string, CatalogSourceRecord>();
  private readonly items = new Map<string, Omit<CatalogItemRecord, "source">>();

  async upsertSource(input: CatalogSourceInput): Promise<CatalogSourceRecord> {
    const existing = Array.from(this.sources.values()).find(
      (source) => source.profileName === input.profileName && source.sourceKey === input.sourceKey
    );
    const record: CatalogSourceRecord = {
      ...input,
      id: existing?.id ?? randomUUID()
    };
    this.sources.set(record.id, record);
    return record;
  }

  async upsertItem(input: CatalogItemInput): Promise<CatalogItemRecord> {
    const existing = Array.from(this.items.values()).find(
      (item) =>
        item.sourceId === input.sourceId &&
        item.storageRef.provider === input.storageRef.provider &&
        storageIdentity(item.storageRef) === storageIdentity(input.storageRef)
    );
    const record: Omit<CatalogItemRecord, "source"> = {
      ...input,
      id: existing?.id ?? randomUUID(),
      normalizedTitle: input.normalizedTitle ?? normalizeCatalogText(input.title)
    };
    this.items.set(record.id, record);
    return this.withSource(record);
  }

  async searchItems(input: CatalogSearchInput): Promise<CatalogItemRecord[]> {
    const query = normalizeCatalogText(input.query ?? "");
    const itemKinds = new Set(input.itemKinds ?? []);
    const domains = new Set(input.domains ?? []);
    const allowedSourceKeys = new Set(input.allowedSourceKeys ?? []);
    const records = Array.from(this.items.values())
      .filter((item) => !item.deletedAt)
      .map((item) => this.withSource(item))
      .filter((item) => item.source.profileName === input.profileName)
      .filter((item) => item.source.enabled)
      .filter((item) => itemKinds.size === 0 || itemKinds.has(item.itemKind))
      .filter((item) => domains.size === 0 || domains.has(item.domain))
      .filter(
        (item) => allowedSourceKeys.size === 0 || allowedSourceKeys.has(item.source.sourceKey)
      )
      .filter((item) => !query || searchableText(item).includes(query))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));

    return records.slice(0, input.limit ?? 5);
  }

  private withSource(item: Omit<CatalogItemRecord, "source">): CatalogItemRecord {
    const source = this.sources.get(item.sourceId);
    if (!source) {
      throw new Error(`catalog_source_not_found:${item.sourceId}`);
    }
    return { ...item, source };
  }
}

export function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\\/_\-.:()（）[\]{}]+/gu, "");
}

function searchableText(item: CatalogItemRecord): string {
  return normalizeCatalogText(
    [item.title, item.normalizedTitle, item.path, item.extension, item.itemKind, item.domain]
      .filter(Boolean)
      .join(" ")
  );
}

function storageIdentity(storage: AgentResourceStorage): string {
  switch (storage.provider) {
    case "graph":
      return `${storage.driveId}:${storage.itemId}`;
    case "external_link":
      return storage.url;
  }
}
