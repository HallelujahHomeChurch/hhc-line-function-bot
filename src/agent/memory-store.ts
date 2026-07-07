import { randomUUID } from "node:crypto";

import type { AgentResourceReference, AgentResourceType, LineSource } from "../types.js";

export type AgentMemoryScopeType = "user" | "group" | "room";

export interface AgentMemoryScope {
  type: AgentMemoryScopeType;
  id: string;
}

export interface AgentResourceRecord extends AgentResourceReference {
  id: string;
  profileName: string;
  scope: AgentMemoryScope;
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface AgentTextMemoryRecord {
  id: string;
  profileName: string;
  scope: AgentMemoryScope;
  title?: string;
  content: string;
  query?: string;
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface RecordAgentResourceInput {
  profileName: string;
  source: LineSource;
  createdBy?: string;
  resourceType: AgentResourceType;
  title: string;
  query?: string;
  storage: AgentResourceReference["storage"];
  expiresAt?: string;
}

export interface FindRecentAgentResourceInput {
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
  resourceTypes?: AgentResourceType[];
}

export interface RememberAgentAliasInput {
  profileName: string;
  source: LineSource;
  createdBy?: string;
  alias: string;
  resourceId: string;
}

export interface FindAgentResourceByAliasInput {
  profileName: string;
  source: LineSource;
  alias: string;
  resourceTypes?: AgentResourceType[];
}

export interface SaveAgentTextMemoryInput {
  profileName: string;
  source: LineSource;
  createdBy?: string;
  title?: string;
  content: string;
  query?: string;
  expiresAt?: string;
}

export interface SearchAgentTextMemoriesInput {
  profileName: string;
  source: LineSource;
  query?: string;
  limit?: number;
}

export interface SearchAgentResourcesInput {
  profileName: string;
  source: LineSource;
  query?: string;
  resourceTypes?: AgentResourceType[];
  limit?: number;
}

export interface ForgetAgentMemoryInput {
  profileName: string;
  source: LineSource;
  id: string;
  deletedBy?: string;
}

export interface AgentMemorySummary {
  resources: number;
  externalResources: number;
  textMemories: number;
  aliases: number;
}

export interface AgentMemoryStore {
  recordResource(input: RecordAgentResourceInput): Promise<AgentResourceRecord>;
  findRecentResource(input: FindRecentAgentResourceInput): Promise<AgentResourceRecord | undefined>;
  searchResources(input: SearchAgentResourcesInput): Promise<AgentResourceRecord[]>;
  rememberAlias(input: RememberAgentAliasInput): Promise<void>;
  findResourceByAlias(
    input: FindAgentResourceByAliasInput
  ): Promise<AgentResourceRecord | undefined>;
  saveTextMemory(input: SaveAgentTextMemoryInput): Promise<AgentTextMemoryRecord>;
  searchTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]>;
  listTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]>;
  forgetMemory(input: ForgetAgentMemoryInput): Promise<boolean>;
  forgetResource(input: ForgetAgentMemoryInput): Promise<boolean>;
  summary(): Promise<AgentMemorySummary>;
}

interface AgentAliasRecord {
  id: string;
  profileName: string;
  scope: AgentMemoryScope;
  alias: string;
  resourceId: string;
  createdBy?: string;
  createdAt: string;
}

export interface InMemoryAgentMemoryStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class InMemoryAgentMemoryStore implements AgentMemoryStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly resources = new Map<string, AgentResourceRecord>();
  private readonly textMemories = new Map<string, AgentTextMemoryRecord>();
  private readonly aliases = new Map<string, AgentAliasRecord>();

  constructor(options: InMemoryAgentMemoryStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async recordResource(input: RecordAgentResourceInput): Promise<AgentResourceRecord> {
    const scope = scopeFromSource(input.source);
    const createdAt = this.now().toISOString();
    const record: AgentResourceRecord = {
      id: randomUUID(),
      profileName: input.profileName,
      scope,
      createdBy: input.createdBy,
      resourceType: input.resourceType,
      title: input.title,
      query: input.query,
      storage: input.storage,
      createdAt,
      expiresAt: input.expiresAt ?? this.defaultExpiresAt()
    };
    this.resources.set(record.id, record);
    return record;
  }

  async findRecentResource(
    input: FindRecentAgentResourceInput
  ): Promise<AgentResourceRecord | undefined> {
    const scope = scopeFromSource(input.source);
    return Array.from(this.resources.values())
      .filter((record) =>
        this.resourceMatches(record, input.profileName, scope, input.resourceTypes)
      )
      .filter((record) => !input.requesterUserId || record.createdBy === input.requesterUserId)
      .sort(descendingCreatedAt)[0];
  }

  async searchResources(input: SearchAgentResourcesInput): Promise<AgentResourceRecord[]> {
    const scope = scopeFromSource(input.source);
    const query = normalizeLookupText(input.query ?? "");
    return Array.from(this.resources.values())
      .filter((record) =>
        this.resourceMatches(record, input.profileName, scope, input.resourceTypes)
      )
      .filter((record) => !query || normalizeLookupText(resourceSearchText(record)).includes(query))
      .sort(descendingCreatedAt)
      .slice(0, input.limit ?? 5);
  }

  async rememberAlias(input: RememberAgentAliasInput): Promise<void> {
    const resource = this.resources.get(input.resourceId);
    const scope = scopeFromSource(input.source);
    if (
      !resource ||
      !sameScope(resource.scope, scope) ||
      resource.profileName !== input.profileName
    ) {
      return;
    }
    const record: AgentAliasRecord = {
      id: randomUUID(),
      profileName: input.profileName,
      scope,
      alias: normalizeLookupText(input.alias),
      resourceId: input.resourceId,
      createdBy: input.createdBy,
      createdAt: this.now().toISOString()
    };
    this.aliases.set(record.id, record);
  }

  async findResourceByAlias(
    input: FindAgentResourceByAliasInput
  ): Promise<AgentResourceRecord | undefined> {
    const scope = scopeFromSource(input.source);
    const alias = normalizeLookupText(input.alias);
    const matchedAliases = Array.from(this.aliases.values())
      .filter(
        (record) =>
          record.profileName === input.profileName &&
          sameScope(record.scope, scope) &&
          record.alias === alias
      )
      .sort(descendingCreatedAt);

    for (const record of matchedAliases) {
      const resource = this.resources.get(record.resourceId);
      if (
        resource &&
        this.resourceMatches(resource, input.profileName, scope, input.resourceTypes)
      ) {
        return resource;
      }
    }
    return undefined;
  }

  async saveTextMemory(input: SaveAgentTextMemoryInput): Promise<AgentTextMemoryRecord> {
    const record: AgentTextMemoryRecord = {
      id: randomUUID(),
      profileName: input.profileName,
      scope: scopeFromSource(input.source),
      title: input.title,
      content: input.content,
      query: input.query,
      createdBy: input.createdBy,
      createdAt: this.now().toISOString(),
      expiresAt: input.expiresAt ?? this.defaultExpiresAt()
    };
    this.textMemories.set(record.id, record);
    return record;
  }

  async searchTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    const scope = scopeFromSource(input.source);
    const query = normalizeLookupText(input.query ?? "");
    return Array.from(this.textMemories.values())
      .filter((record) => this.textMemoryMatches(record, input.profileName, scope))
      .filter((record) => !query || normalizeLookupText(memorySearchText(record)).includes(query))
      .sort(descendingCreatedAt)
      .slice(0, input.limit ?? 5);
  }

  async listTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    return this.searchTextMemories({ ...input, query: undefined });
  }

  async forgetMemory(input: ForgetAgentMemoryInput): Promise<boolean> {
    const scope = scopeFromSource(input.source);
    const record = this.textMemories.get(input.id);
    if (!record || record.profileName !== input.profileName || !sameScope(record.scope, scope)) {
      return false;
    }
    this.textMemories.set(record.id, {
      ...record,
      deletedAt: this.now().toISOString()
    });
    return true;
  }

  async forgetResource(input: ForgetAgentMemoryInput): Promise<boolean> {
    const scope = scopeFromSource(input.source);
    const record = this.resources.get(input.id);
    if (!record || record.profileName !== input.profileName || !sameScope(record.scope, scope)) {
      return false;
    }
    this.resources.set(record.id, {
      ...record,
      deletedAt: this.now().toISOString()
    });
    return true;
  }

  async summary(): Promise<AgentMemorySummary> {
    const activeResources = Array.from(this.resources.values()).filter((record) =>
      this.active(record)
    );
    return {
      resources: activeResources.length,
      externalResources: activeResources.filter(
        (record) => record.storage.provider === "external_link"
      ).length,
      textMemories: Array.from(this.textMemories.values()).filter((record) => this.active(record))
        .length,
      aliases: this.aliases.size
    };
  }

  private resourceMatches(
    record: AgentResourceRecord,
    profileName: string,
    scope: AgentMemoryScope,
    resourceTypes: AgentResourceType[] | undefined
  ): boolean {
    return (
      record.profileName === profileName &&
      sameScope(record.scope, scope) &&
      this.active(record) &&
      (!resourceTypes || resourceTypes.includes(record.resourceType))
    );
  }

  private textMemoryMatches(
    record: AgentTextMemoryRecord,
    profileName: string,
    scope: AgentMemoryScope
  ): boolean {
    return (
      record.profileName === profileName && sameScope(record.scope, scope) && this.active(record)
    );
  }

  private active(record: { expiresAt: string; deletedAt?: string }): boolean {
    return !record.deletedAt && Date.parse(record.expiresAt) > this.now().getTime();
  }

  private defaultExpiresAt(): string {
    return new Date(this.now().getTime() + this.ttlMs).toISOString();
  }
}

export function scopeFromSource(source: LineSource): AgentMemoryScope {
  if (source.type === "group" && source.groupId) {
    return { type: "group", id: source.groupId };
  }
  if (source.type === "room" && source.roomId) {
    return { type: "room", id: source.roomId };
  }
  return { type: "user", id: source.userId ?? "unknown" };
}

export function normalizeLookupText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-()[\]{}.,:;'"!?/\\|，。！？、：；「」『』（）【】]+/g, "");
}

function sameScope(left: AgentMemoryScope, right: AgentMemoryScope): boolean {
  return left.type === right.type && left.id === right.id;
}

function descendingCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function memorySearchText(record: AgentTextMemoryRecord): string {
  return [record.title, record.query, record.content].filter(Boolean).join(" ");
}

function resourceSearchText(record: AgentResourceRecord): string {
  return [
    record.title,
    record.query,
    record.storage.provider === "external_link" ? record.storage.sourceLabel : undefined,
    record.storage.provider === "external_link" ? record.storage.description : undefined,
    record.storage.provider === "external_link" ? record.storage.url : undefined
  ]
    .filter(Boolean)
    .join(" ");
}
