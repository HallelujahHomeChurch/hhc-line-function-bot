import { randomUUID } from "node:crypto";

import type { AgentResourceReference, AgentResourceType, LineSource } from "../types.js";

export type AgentMemoryScopeType = "user" | "group" | "room" | "profile";
export type AgentMemoryVisibility = "private" | "group" | "profile";
export type AgentScheduleType =
  "morning_prayer_family" | "street_sign_service" | "custom_service_schedule";

export interface AgentMemoryScope {
  type: AgentMemoryScopeType;
  id: string;
}

export interface AgentResourceRecord extends AgentResourceReference {
  id: string;
  profileName: string;
  scope: AgentMemoryScope;
  visibility: AgentMemoryVisibility;
  createdBy?: string;
  createdAt: string;
  verifiedAt: string;
  sourceRevision?: string;
  expiresAt: string;
  deletedAt?: string;
  tombstonedAt?: string;
}

export interface AgentTextMemoryRecord {
  id: string;
  profileName: string;
  scope: AgentMemoryScope;
  visibility: AgentMemoryVisibility;
  title?: string;
  content: string;
  query?: string;
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface AgentScheduleEntryInput {
  serviceDate: string;
  weekday?: string;
  meetingName: string;
  role?: string;
  assignee: string;
  familyName?: string;
  notes?: string;
}

export interface AgentScheduleEntryRecord extends AgentScheduleEntryInput {
  id: string;
  memoryId: string;
  profileName: string;
  scope: AgentMemoryScope;
  visibility: AgentMemoryVisibility;
  createdBy?: string;
  scheduleType: AgentScheduleType;
  scheduleTitle: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface AgentScheduleMemoryRecord {
  id: string;
  profileName: string;
  scope: AgentMemoryScope;
  visibility: AgentMemoryVisibility;
  scheduleType: AgentScheduleType;
  periodKey: string;
  title: string;
  originalText: string;
  entries: AgentScheduleEntryRecord[];
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface RecordAgentResourceInput {
  profileName: string;
  source: LineSource;
  createdBy?: string;
  visibility?: AgentMemoryVisibility;
  resourceType: AgentResourceType;
  title: string;
  query?: string;
  storage: AgentResourceReference["storage"];
  sourceRevision?: string;
  expiresAt?: string;
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
  requesterUserId?: string;
  alias: string;
  resourceTypes?: AgentResourceType[];
}

export interface SaveAgentTextMemoryInput {
  profileName: string;
  source: LineSource;
  createdBy?: string;
  visibility?: AgentMemoryVisibility;
  title?: string;
  content: string;
  query?: string;
  expiresAt?: string;
  embedding?: number[];
}

export interface SaveAgentScheduleMemoryInput {
  profileName: string;
  source: LineSource;
  createdBy?: string;
  visibility?: AgentMemoryVisibility;
  scheduleType: AgentScheduleType;
  periodKey?: string;
  title: string;
  originalText: string;
  entries: AgentScheduleEntryInput[];
  expiresAt?: string;
}

export interface AddAgentScheduleEntryInput {
  profileName: string;
  scheduleType: AgentScheduleType;
  entry: AgentScheduleEntryInput;
}

export interface UpdateAgentScheduleEntryInput {
  profileName: string;
  entryId: string;
  changes: Partial<AgentScheduleEntryInput>;
}

export interface DeleteAgentScheduleEntryInput {
  profileName: string;
  entryId: string;
}

export interface SearchAgentScheduleEntriesInput {
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
  memoryId?: string;
  scheduleType?: AgentScheduleType;
  date?: string;
  meetingName?: string;
  role?: string;
  query?: string;
  limit?: number;
}

export interface ListAgentScheduleMemoriesInput {
  profileName: string;
  limit?: number;
}

export interface SearchAgentTextMemoriesInput {
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
  memoryId?: string;
  query?: string;
  limit?: number;
  queryEmbedding?: number[];
}

export interface AgentTextMemoryEmbeddingCandidate {
  id: string;
  title?: string;
  content: string;
}

export interface SearchAgentResourcesInput {
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
  query?: string;
  resourceTypes?: AgentResourceType[];
  sourceRevision?: string;
  limit?: number;
}

export interface ForgetAgentMemoryInput {
  profileName: string;
  source: LineSource;
  id: string;
  deletedBy?: string;
  isAdmin?: boolean;
}

export interface AgentMemoryPurgeResult {
  resources: number;
  textMemories: number;
  scheduleMemories: number;
  aliases: number;
}

export interface AgentMemorySummary {
  resources: number;
  externalResources: number;
  textMemories: number;
  scheduleMemories: number;
  scheduleEntries: number;
  aliases: number;
}

export interface AgentMemoryStore {
  recordResource(input: RecordAgentResourceInput): Promise<AgentResourceRecord>;
  searchResources(input: SearchAgentResourcesInput): Promise<AgentResourceRecord[]>;
  rememberAlias(input: RememberAgentAliasInput): Promise<void>;
  findResourceByAlias(
    input: FindAgentResourceByAliasInput
  ): Promise<AgentResourceRecord | undefined>;
  saveTextMemory(input: SaveAgentTextMemoryInput): Promise<AgentTextMemoryRecord>;
  searchTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]>;
  listTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]>;
  listTextMemoriesMissingEmbedding(limit: number): Promise<AgentTextMemoryEmbeddingCandidate[]>;
  updateTextMemoryEmbedding(id: string, embedding: number[]): Promise<boolean>;
  saveScheduleMemory(input: SaveAgentScheduleMemoryInput): Promise<AgentScheduleMemoryRecord>;
  listScheduleMemories(input: ListAgentScheduleMemoriesInput): Promise<AgentScheduleMemoryRecord[]>;
  searchScheduleEntries(
    input: SearchAgentScheduleEntriesInput
  ): Promise<AgentScheduleEntryRecord[]>;
  addScheduleEntry(
    input: AddAgentScheduleEntryInput
  ): Promise<AgentScheduleEntryRecord | undefined>;
  updateScheduleEntry(
    input: UpdateAgentScheduleEntryInput
  ): Promise<AgentScheduleEntryRecord | undefined>;
  deleteScheduleEntry(input: DeleteAgentScheduleEntryInput): Promise<boolean>;
  forgetMemory(input: ForgetAgentMemoryInput): Promise<boolean>;
  forgetResource(input: ForgetAgentMemoryInput): Promise<boolean>;
  forgetScheduleMemory(input: ForgetAgentMemoryInput): Promise<boolean>;
  purgeExpired(now?: Date): Promise<AgentMemoryPurgeResult>;
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
  private readonly textMemoryEmbeddings = new Map<string, number[]>();
  private readonly scheduleMemories = new Map<string, AgentScheduleMemoryRecord>();
  private readonly scheduleEntries = new Map<string, AgentScheduleEntryRecord>();
  private readonly aliases = new Map<string, AgentAliasRecord>();

  constructor(options: InMemoryAgentMemoryStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async recordResource(input: RecordAgentResourceInput): Promise<AgentResourceRecord> {
    const scope = scopeFromSource(input.source);
    const createdAt = this.now().toISOString();
    const identity = resourceIdentity(input.storage, input.createdBy);
    const existing = Array.from(this.resources.values()).find(
      (record) =>
        record.profileName === input.profileName &&
        sameScope(record.scope, scope) &&
        record.resourceType === input.resourceType &&
        resourceIdentity(record.storage, record.createdBy) === identity
    );
    const record: AgentResourceRecord = {
      id: existing?.id ?? randomUUID(),
      profileName: input.profileName,
      scope,
      visibility: input.visibility ?? defaultVisibility(scope),
      createdBy: input.createdBy,
      resourceType: input.resourceType,
      title: input.title,
      query: input.query,
      storage: input.storage,
      sourceRevision: input.sourceRevision,
      createdAt: existing?.createdAt ?? createdAt,
      verifiedAt: createdAt,
      expiresAt: input.expiresAt ?? this.defaultExpiresAt()
    };
    this.resources.set(record.id, record);
    return record;
  }

  async searchResources(input: SearchAgentResourcesInput): Promise<AgentResourceRecord[]> {
    const scope = scopeFromSource(input.source);
    const query = normalizeLookupText(input.query ?? "");
    return Array.from(this.resources.values())
      .filter((record) =>
        this.resourceMatches(record, input.profileName, scope, input.resourceTypes)
      )
      .filter((record) =>
        this.isVisible(record, input.requesterUserId ?? input.source.userId, scope)
      )
      .filter((record) => !record.tombstonedAt)
      .filter((record) => !input.sourceRevision || record.sourceRevision === input.sourceRevision)
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
        this.resourceMatches(resource, input.profileName, scope, input.resourceTypes) &&
        record.createdBy === (input.requesterUserId ?? input.source.userId) &&
        this.isVisible(resource, input.requesterUserId ?? input.source.userId, scope)
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
      visibility: input.visibility ?? defaultVisibility(scopeFromSource(input.source)),
      title: input.title,
      content: input.content,
      query: input.query,
      createdBy: input.createdBy,
      createdAt: this.now().toISOString(),
      expiresAt: input.expiresAt ?? this.defaultExpiresAt()
    };
    this.textMemories.set(record.id, record);
    if (input.embedding?.length) this.textMemoryEmbeddings.set(record.id, [...input.embedding]);
    return record;
  }

  async searchTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    const scope = scopeFromSource(input.source);
    const query = input.memoryId ? "" : normalizeLookupText(input.query ?? "");
    const queryEmbedding = input.queryEmbedding;
    return Array.from(this.textMemories.values())
      .filter((record) => this.textMemoryMatches(record, input.profileName, scope))
      .filter((record) => !input.memoryId || record.id === input.memoryId)
      .filter((record) =>
        this.isVisible(record, input.requesterUserId ?? input.source.userId, scope)
      )
      .map((record) => ({
        record,
        lexical: !query || normalizeLookupText(memorySearchText(record)).includes(query),
        semantic: cosineSimilarity(queryEmbedding, this.textMemoryEmbeddings.get(record.id))
      }))
      .filter(({ lexical, semantic }) => lexical || semantic >= 0.65)
      .sort(
        (left, right) =>
          Number(right.lexical) - Number(left.lexical) ||
          right.semantic - left.semantic ||
          descendingCreatedAt(left.record, right.record)
      )
      .map(({ record }) => record)
      .slice(0, input.limit ?? 5);
  }

  async listTextMemoriesMissingEmbedding(
    limit: number
  ): Promise<AgentTextMemoryEmbeddingCandidate[]> {
    return Array.from(this.textMemories.values())
      .filter((record) => !this.textMemoryEmbeddings.has(record.id))
      .filter((record) => !record.deletedAt && Date.parse(record.expiresAt) > this.now().getTime())
      .sort(descendingCreatedAt)
      .slice(0, Math.max(0, limit))
      .map(({ id, title, content }) => ({ id, title, content }));
  }

  async updateTextMemoryEmbedding(id: string, embedding: number[]): Promise<boolean> {
    if (!this.textMemories.has(id) || !embedding.length) return false;
    this.textMemoryEmbeddings.set(id, [...embedding]);
    return true;
  }

  async listTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    return this.searchTextMemories({ ...input, query: undefined });
  }

  async saveScheduleMemory(
    input: SaveAgentScheduleMemoryInput
  ): Promise<AgentScheduleMemoryRecord> {
    const scope = profileScope(input.profileName);
    const createdAt = this.now().toISOString();
    const expiresAt = input.expiresAt ?? this.defaultExpiresAt();
    const memoryId = randomUUID();
    const periodKey = input.periodKey ?? input.entries[0]?.serviceDate.slice(0, 7) ?? "unknown";
    for (const existing of this.scheduleMemories.values()) {
      if (
        existing.profileName === input.profileName &&
        existing.scheduleType === input.scheduleType &&
        existing.periodKey === periodKey &&
        this.active(existing)
      ) {
        const deletedAt = this.now().toISOString();
        this.scheduleMemories.set(existing.id, { ...existing, deletedAt });
        for (const entry of existing.entries) {
          this.scheduleEntries.set(entry.id, { ...entry, deletedAt });
        }
      }
    }
    const entries = input.entries.map((entry) => ({
      id: randomUUID(),
      memoryId,
      profileName: input.profileName,
      scope,
      visibility: "profile" as const,
      createdBy: input.createdBy,
      scheduleType: input.scheduleType,
      periodKey,
      scheduleTitle: input.title,
      serviceDate: entry.serviceDate,
      weekday: entry.weekday,
      meetingName: entry.meetingName,
      role: entry.role,
      assignee: entry.assignee,
      familyName: entry.familyName,
      notes: entry.notes,
      createdAt,
      expiresAt
    }));
    const record: AgentScheduleMemoryRecord = {
      id: memoryId,
      profileName: input.profileName,
      scope,
      visibility: "profile",
      scheduleType: input.scheduleType,
      periodKey,
      title: input.title,
      originalText: input.originalText,
      entries,
      createdBy: input.createdBy,
      createdAt,
      expiresAt
    };
    this.scheduleMemories.set(record.id, record);
    for (const entry of entries) {
      this.scheduleEntries.set(entry.id, entry);
    }
    return record;
  }

  async listScheduleMemories(
    input: ListAgentScheduleMemoriesInput
  ): Promise<AgentScheduleMemoryRecord[]> {
    return Array.from(this.scheduleMemories.values())
      .filter((record) => record.profileName === input.profileName && this.active(record))
      .sort(descendingCreatedAt)
      .slice(0, input.limit ?? 10);
  }

  async searchScheduleEntries(
    input: SearchAgentScheduleEntriesInput
  ): Promise<AgentScheduleEntryRecord[]> {
    const query = normalizeLookupText(input.query ?? "");
    const meetingName = normalizeLookupText(input.meetingName ?? "");
    const role = normalizeLookupText(input.role ?? "");
    return Array.from(this.scheduleEntries.values())
      .filter(
        (record) =>
          record.profileName === input.profileName &&
          record.scope.type === "profile" &&
          this.active(record) &&
          (!input.memoryId || record.memoryId === input.memoryId) &&
          (!input.scheduleType || record.scheduleType === input.scheduleType) &&
          (!input.date || record.serviceDate === input.date) &&
          (!meetingName || normalizeLookupText(record.meetingName).includes(meetingName)) &&
          (!role || normalizeLookupText(record.role ?? "").includes(role))
      )
      .filter(
        (record) => !query || normalizeLookupText(scheduleEntrySearchText(record)).includes(query)
      )
      .sort(ascendingScheduleDateThenCreatedAt)
      .slice(0, input.limit ?? 10);
  }

  async addScheduleEntry(
    input: AddAgentScheduleEntryInput
  ): Promise<AgentScheduleEntryRecord | undefined> {
    const periodKey = input.entry.serviceDate.slice(0, 7);
    const memory = Array.from(this.scheduleMemories.values()).find(
      (record) =>
        record.profileName === input.profileName &&
        record.scheduleType === input.scheduleType &&
        record.periodKey === periodKey &&
        this.active(record)
    );
    if (!memory) {
      return undefined;
    }
    const entry: AgentScheduleEntryRecord = {
      ...input.entry,
      id: randomUUID(),
      memoryId: memory.id,
      profileName: memory.profileName,
      scope: memory.scope,
      visibility: "profile",
      createdBy: memory.createdBy,
      scheduleType: memory.scheduleType,
      scheduleTitle: memory.title,
      createdAt: this.now().toISOString(),
      expiresAt: memory.expiresAt
    };
    this.scheduleEntries.set(entry.id, entry);
    this.scheduleMemories.set(memory.id, { ...memory, entries: [...memory.entries, entry] });
    return entry;
  }

  async updateScheduleEntry(
    input: UpdateAgentScheduleEntryInput
  ): Promise<AgentScheduleEntryRecord | undefined> {
    const current = this.scheduleEntries.get(input.entryId);
    if (!current || current.profileName !== input.profileName || !this.active(current)) {
      return undefined;
    }
    const updated = { ...current, ...input.changes };
    this.scheduleEntries.set(current.id, updated);
    const memory = this.scheduleMemories.get(current.memoryId);
    if (memory) {
      this.scheduleMemories.set(memory.id, {
        ...memory,
        entries: memory.entries.map((entry) => (entry.id === current.id ? updated : entry))
      });
    }
    return updated;
  }

  async deleteScheduleEntry(input: DeleteAgentScheduleEntryInput): Promise<boolean> {
    const current = this.scheduleEntries.get(input.entryId);
    if (!current || current.profileName !== input.profileName || !this.active(current)) {
      return false;
    }
    const deletedAt = this.now().toISOString();
    this.scheduleEntries.set(current.id, { ...current, deletedAt });
    return true;
  }

  async forgetMemory(input: ForgetAgentMemoryInput): Promise<boolean> {
    const scope = scopeFromSource(input.source);
    const record = this.textMemories.get(input.id);
    if (
      !record ||
      record.profileName !== input.profileName ||
      !sameScope(record.scope, scope) ||
      !canDelete(record, input)
    ) {
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
    if (
      !record ||
      record.profileName !== input.profileName ||
      !sameScope(record.scope, scope) ||
      !canDelete(record, input)
    ) {
      return false;
    }
    this.resources.set(record.id, {
      ...record,
      deletedAt: this.now().toISOString()
    });
    return true;
  }

  async forgetScheduleMemory(input: ForgetAgentMemoryInput): Promise<boolean> {
    const record = this.scheduleMemories.get(input.id);
    if (!record || record.profileName !== input.profileName || !canDelete(record, input)) {
      return false;
    }
    const deletedAt = this.now().toISOString();
    this.scheduleMemories.set(record.id, { ...record, deletedAt });
    for (const entry of record.entries) {
      this.scheduleEntries.set(entry.id, { ...entry, deletedAt });
    }
    return true;
  }

  async purgeExpired(now = this.now()): Promise<AgentMemoryPurgeResult> {
    const expired = (record: { expiresAt: string; deletedAt?: string }) =>
      Boolean(record.deletedAt) || Date.parse(record.expiresAt) <= now.getTime();
    const resources = removeWhere(this.resources, expired);
    const textMemories = removeWhere(this.textMemories, expired);
    const scheduleMemoryIds = new Set(
      Array.from(this.scheduleMemories.values())
        .filter(expired)
        .map((record) => record.id)
    );
    const scheduleMemories = removeWhere(this.scheduleMemories, expired);
    removeWhere(
      this.scheduleEntries,
      (entry: AgentScheduleEntryRecord) => expired(entry) || scheduleMemoryIds.has(entry.memoryId)
    );
    const aliases = removeWhere(
      this.aliases,
      (alias: AgentAliasRecord) => !this.resources.has(alias.resourceId)
    );
    return { resources, textMemories, scheduleMemories, aliases };
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
      scheduleMemories: Array.from(this.scheduleMemories.values()).filter((record) =>
        this.active(record)
      ).length,
      scheduleEntries: Array.from(this.scheduleEntries.values()).filter((record) =>
        this.active(record)
      ).length,
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
      !record.tombstonedAt &&
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

  private isVisible(
    record: { visibility: AgentMemoryVisibility; createdBy?: string },
    requesterUserId: string | undefined,
    scope: AgentMemoryScope
  ): boolean {
    if (scope.type === "user") {
      return true;
    }
    return (
      record.visibility === "group" ||
      Boolean(requesterUserId && record.createdBy === requesterUserId)
    );
  }

  private active(record: { expiresAt: string; deletedAt?: string }): boolean {
    return !record.deletedAt && Date.parse(record.expiresAt) > this.now().getTime();
  }

  private defaultExpiresAt(): string {
    return new Date(this.now().getTime() + this.ttlMs).toISOString();
  }
}

function cosineSimilarity(left: number[] | undefined, right: number[] | undefined): number {
  if (!left?.length || !right?.length || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
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

export function profileScope(profileName: string): AgentMemoryScope {
  return { type: "profile", id: profileName };
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

function defaultVisibility(scope: AgentMemoryScope): AgentMemoryVisibility {
  return scope.type === "group" || scope.type === "room" ? "private" : "private";
}

function canDelete(record: { createdBy?: string }, input: ForgetAgentMemoryInput): boolean {
  return Boolean(input.isAdmin || (input.deletedBy && input.deletedBy === record.createdBy));
}

function removeWhere<T>(records: Map<string, T>, predicate: (record: T) => boolean): number {
  let removed = 0;
  for (const [id, record] of records) {
    if (predicate(record)) {
      records.delete(id);
      removed += 1;
    }
  }
  return removed;
}

function descendingCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function ascendingScheduleDateThenCreatedAt(
  left: AgentScheduleEntryRecord,
  right: AgentScheduleEntryRecord
): number {
  const dateDiff = left.serviceDate.localeCompare(right.serviceDate);
  if (dateDiff !== 0) {
    return dateDiff;
  }
  return descendingCreatedAt(left, right);
}

function memorySearchText(record: AgentTextMemoryRecord): string {
  return [record.title, record.query, record.content].filter(Boolean).join(" ");
}

function scheduleEntrySearchText(record: AgentScheduleEntryRecord): string {
  return [
    record.scheduleTitle,
    record.scheduleType,
    record.serviceDate,
    record.weekday,
    record.meetingName,
    record.role,
    record.assignee,
    record.familyName,
    record.notes
  ]
    .filter(Boolean)
    .join(" ");
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

function resourceIdentity(storage: AgentResourceReference["storage"], createdBy?: string): string {
  const parts =
    storage.provider === "graph"
      ? [storage.provider, storage.driveId, storage.itemId, createdBy ?? ""]
      : [storage.provider, storage.url, "", createdBy ?? ""];
  return parts.map((part) => Buffer.from(part, "utf8").toString("base64")).join(":");
}
