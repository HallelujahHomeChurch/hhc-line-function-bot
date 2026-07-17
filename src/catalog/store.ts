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
    allowedExtensions?: string[];
  };
  capabilities: {
    read: string[];
    write: string[];
  };
}

export interface CatalogSourceRecord extends CatalogSourceInput {
  id: string;
  syncCursor?: string;
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
  expiresAt?: string;
  deletedAt?: string;
}

export interface CatalogItemRecord extends CatalogItemInput {
  id: string;
  normalizedTitle: string;
  source: CatalogSourceRecord;
}

export interface CatalogSearchInput {
  profileName: string;
  itemIds?: string[];
  query?: string;
  itemKinds?: string[];
  domains?: string[];
  allowedSourceKeys?: string[];
  limit?: number;
}

export interface CatalogSourceListInput {
  profileName?: string;
  enabled?: boolean;
  sourceKeys?: string[];
}

export interface CatalogStore {
  upsertSource(input: CatalogSourceInput): Promise<CatalogSourceRecord>;
  createSourceIfMissing(input: CatalogSourceInput): Promise<{
    source: CatalogSourceRecord;
    created: boolean;
  }>;
  updateSourceEnabled(input: {
    profileName: string;
    sourceKey: string;
    enabled: boolean;
  }): Promise<CatalogSourceRecord | undefined>;
  listSources(input?: CatalogSourceListInput): Promise<CatalogSourceRecord[]>;
  updateSourceSyncCursor(sourceId: string, syncCursor: string | undefined): Promise<void>;
  upsertItem(input: CatalogItemInput): Promise<CatalogItemRecord>;
  tombstoneMissingItems(input: {
    sourceId: string;
    liveStorageIdentities: string[];
    deletedAt: string;
  }): Promise<number>;
  tombstoneItemsByStorageIdentities(input: {
    sourceId: string;
    storageIdentities: string[];
    deletedAt: string;
  }): Promise<number>;
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

  async createSourceIfMissing(input: CatalogSourceInput): Promise<{
    source: CatalogSourceRecord;
    created: boolean;
  }> {
    const existing = Array.from(this.sources.values()).find(
      (source) => source.profileName === input.profileName && source.sourceKey === input.sourceKey
    );
    if (existing) {
      return { source: existing, created: false };
    }
    const source: CatalogSourceRecord = { ...input, id: randomUUID() };
    this.sources.set(source.id, source);
    return { source, created: true };
  }

  async listSources(input: CatalogSourceListInput = {}): Promise<CatalogSourceRecord[]> {
    const sourceKeys = new Set(input.sourceKeys ?? []);
    return Array.from(this.sources.values())
      .filter((source) => !input.profileName || source.profileName === input.profileName)
      .filter((source) => input.enabled === undefined || source.enabled === input.enabled)
      .filter((source) => sourceKeys.size === 0 || sourceKeys.has(source.sourceKey))
      .sort((a, b) =>
        `${a.profileName}:${a.sourceKey}`.localeCompare(`${b.profileName}:${b.sourceKey}`)
      );
  }

  async updateSourceEnabled(input: {
    profileName: string;
    sourceKey: string;
    enabled: boolean;
  }): Promise<CatalogSourceRecord | undefined> {
    const existing = Array.from(this.sources.values()).find(
      (source) => source.profileName === input.profileName && source.sourceKey === input.sourceKey
    );
    if (!existing) {
      return undefined;
    }
    const updated = { ...existing, enabled: input.enabled };
    this.sources.set(updated.id, updated);
    return updated;
  }

  async updateSourceSyncCursor(sourceId: string, syncCursor: string | undefined): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`catalog_source_not_found:${sourceId}`);
    }
    this.sources.set(sourceId, { ...source, syncCursor });
  }

  async upsertItem(input: CatalogItemInput): Promise<CatalogItemRecord> {
    const existing = Array.from(this.items.values()).find(
      (item) =>
        item.sourceId === input.sourceId &&
        item.storageRef.provider === input.storageRef.provider &&
        catalogStorageIdentity(item.storageRef) === catalogStorageIdentity(input.storageRef)
    );
    const record: Omit<CatalogItemRecord, "source"> = {
      ...input,
      id: existing?.id ?? randomUUID(),
      normalizedTitle: input.normalizedTitle ?? normalizeCatalogText(input.title)
    };
    this.items.set(record.id, record);
    return this.withSource(record);
  }

  async tombstoneMissingItems(input: {
    sourceId: string;
    liveStorageIdentities: string[];
    deletedAt: string;
  }): Promise<number> {
    const live = new Set(input.liveStorageIdentities);
    let count = 0;
    for (const item of Array.from(this.items.values())) {
      if (
        item.sourceId === input.sourceId &&
        !item.deletedAt &&
        !live.has(catalogStorageIdentity(item.storageRef))
      ) {
        this.items.set(item.id, { ...item, deletedAt: input.deletedAt });
        count += 1;
      }
    }
    return count;
  }

  async tombstoneItemsByStorageIdentities(input: {
    sourceId: string;
    storageIdentities: string[];
    deletedAt: string;
  }): Promise<number> {
    const identities = new Set(input.storageIdentities);
    let count = 0;
    for (const item of Array.from(this.items.values())) {
      if (
        item.sourceId === input.sourceId &&
        !item.deletedAt &&
        identities.has(catalogStorageIdentity(item.storageRef))
      ) {
        this.items.set(item.id, { ...item, deletedAt: input.deletedAt });
        count += 1;
      }
    }
    return count;
  }

  async searchItems(input: CatalogSearchInput): Promise<CatalogItemRecord[]> {
    const query = normalizeCatalogText(input.query ?? "");
    const itemIds = new Set(input.itemIds ?? []);
    const itemKinds = new Set(input.itemKinds ?? []);
    const domains = new Set(input.domains ?? []);
    const allowedSourceKeys = new Set(input.allowedSourceKeys ?? []);
    const records = Array.from(this.items.values())
      .filter((item) => !item.deletedAt)
      .filter((item) => itemIds.size === 0 || itemIds.has(item.id))
      .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now())
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

export function catalogStorageIdentity(storage: AgentResourceStorage): string {
  switch (storage.provider) {
    case "graph":
      return `graph:${storage.driveId}:${storage.itemId}`;
    case "external_link":
      return `external_link:${storage.url}`;
  }
}

export function catalogSourceAllowsRead(
  source: CatalogSourceRecord,
  capabilities: string[]
): boolean {
  const allowed = new Set(source.capabilities.read);
  return capabilities.some((capability) => allowed.has(capability));
}
