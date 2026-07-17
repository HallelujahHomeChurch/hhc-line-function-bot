import { randomUUID } from "node:crypto";

import type { AgentResourceType } from "../types.js";
import {
  normalizeLookupText,
  profileScope,
  scopeFromSource,
  type AgentMemoryScope,
  type AgentMemoryVisibility,
  type AgentMemoryPurgeResult,
  type AgentMemoryStore,
  type AgentMemorySummary,
  type AddAgentScheduleEntryInput,
  type DeleteAgentScheduleEntryInput,
  type AgentResourceRecord,
  type AgentScheduleEntryRecord,
  type AgentScheduleMemoryRecord,
  type AgentTextMemoryRecord,
  type AgentTextMemoryEmbeddingCandidate,
  type FindAgentResourceByAliasInput,
  type ForgetAgentMemoryInput,
  type RecordAgentResourceInput,
  type RememberAgentAliasInput,
  type SaveAgentScheduleMemoryInput,
  type SaveAgentTextMemoryInput,
  type SearchAgentScheduleEntriesInput,
  type ListAgentScheduleMemoriesInput,
  type SearchAgentResourcesInput,
  type SearchAgentTextMemoriesInput,
  type UpdateAgentScheduleEntryInput
} from "./memory-store.js";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

export interface PostgresAgentMemoryStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class PostgresAgentMemoryStore implements AgentMemoryStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    private readonly db: PgQueryable,
    options: PostgresAgentMemoryStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async recordResource(input: RecordAgentResourceInput): Promise<AgentResourceRecord> {
    const scope = scopeFromSource(input.source);
    const result = await this.db.query(
      `
      insert into agent_resources
        (id, profile_name, scope_type, scope_id, resource_type, title, query_text,
         storage_provider, drive_id, item_id, external_url, source_label, description,
         created_by, visibility, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      returning *
      `,
      [
        randomUUID(),
        input.profileName,
        scope.type,
        scope.id,
        input.resourceType,
        input.title,
        input.query ?? null,
        input.storage.provider,
        input.storage.provider === "graph" ? input.storage.driveId : null,
        input.storage.provider === "graph" ? input.storage.itemId : null,
        input.storage.provider === "external_link" ? input.storage.url : null,
        input.storage.provider === "external_link" ? (input.storage.sourceLabel ?? null) : null,
        input.storage.provider === "external_link" ? (input.storage.description ?? null) : null,
        input.createdBy ?? null,
        input.visibility ?? "private",
        input.expiresAt ?? this.defaultExpiresAt()
      ]
    );
    return mapResource(result.rows[0]);
  }

  async searchResources(input: SearchAgentResourcesInput): Promise<AgentResourceRecord[]> {
    const scope = scopeFromSource(input.source);
    const values: unknown[] = [input.profileName, scope.type, scope.id];
    const typeFilter = input.resourceTypes?.length ? "and resource_type = any($4::text[])" : "";
    if (input.resourceTypes?.length) {
      values.push(input.resourceTypes);
    }
    const visibilityFilter = visibilitySqlFilter(
      "visibility",
      scope,
      input.requesterUserId ?? input.source.userId,
      values
    );
    const limitParam = values.length + 1;
    values.push(Math.max(input.limit ?? 5, 50));
    const result = await this.db.query(
      `
      select *
      from agent_resources
      where profile_name = $1
        and scope_type = $2
        and scope_id = $3
        ${typeFilter}
        ${visibilityFilter}
        and deleted_at is null
        and expires_at > now()
      order by created_at desc
      limit $${limitParam}
      `,
      values
    );
    const query = normalizeLookupText(input.query ?? "");
    return result.rows
      .map(mapResource)
      .filter(
        (resource) => !query || normalizeLookupText(resourceSearchText(resource)).includes(query)
      )
      .slice(0, input.limit ?? 5);
  }

  async rememberAlias(input: RememberAgentAliasInput): Promise<void> {
    const scope = scopeFromSource(input.source);
    await this.db.query(
      `
      insert into agent_resource_aliases
        (id, profile_name, scope_type, scope_id, alias, normalized_alias, resource_id, created_by)
      select $1, $2, $3, $4, $5, $6, id, $8
      from agent_resources
      where id = $7
        and profile_name = $2
        and scope_type = $3
        and scope_id = $4
        and deleted_at is null
        and expires_at > now()
      `,
      [
        randomUUID(),
        input.profileName,
        scope.type,
        scope.id,
        input.alias,
        normalizeLookupText(input.alias),
        input.resourceId,
        input.createdBy ?? null
      ]
    );
  }

  async findResourceByAlias(
    input: FindAgentResourceByAliasInput
  ): Promise<AgentResourceRecord | undefined> {
    const scope = scopeFromSource(input.source);
    const values: unknown[] = [
      input.profileName,
      scope.type,
      scope.id,
      normalizeLookupText(input.alias)
    ];
    const typeFilter = input.resourceTypes?.length ? "and r.resource_type = any($5::text[])" : "";
    if (input.resourceTypes?.length) {
      values.push(input.resourceTypes);
    }
    const requesterUserId = input.requesterUserId ?? input.source.userId;
    const visibilityFilter = visibilitySqlFilter(
      "r.visibility",
      scope,
      requesterUserId,
      values,
      "r.created_by"
    );
    const aliasOwnerFilter = requesterUserId
      ? `and a.created_by = $${values.push(requesterUserId)}`
      : "and false";
    const result = await this.db.query(
      `
      select r.*
      from agent_resource_aliases a
      join agent_resources r on r.id = a.resource_id
      where a.profile_name = $1
        and a.scope_type = $2
        and a.scope_id = $3
        and a.normalized_alias = $4
        and r.deleted_at is null
        and r.expires_at > now()
        ${typeFilter}
        ${visibilityFilter}
        ${aliasOwnerFilter}
      order by a.created_at desc
      limit 1
      `,
      values
    );
    return result.rows[0] ? mapResource(result.rows[0]) : undefined;
  }

  async saveTextMemory(input: SaveAgentTextMemoryInput): Promise<AgentTextMemoryRecord> {
    const scope = scopeFromSource(input.source);
    const result = await this.db.query(
      `
      insert into agent_text_memories
        (id, profile_name, scope_type, scope_id, title, content, query_text, created_by,
         visibility, expires_at, embedding)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
      returning *
      `,
      [
        randomUUID(),
        input.profileName,
        scope.type,
        scope.id,
        input.title ?? null,
        input.content,
        input.query ?? null,
        input.createdBy ?? null,
        input.visibility ?? "private",
        input.expiresAt ?? this.defaultExpiresAt(),
        vectorParameter(input.embedding)
      ]
    );
    return mapTextMemory(result.rows[0]);
  }

  async searchTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    const scope = scopeFromSource(input.source);
    const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
    const values: unknown[] = [input.profileName, scope.type, scope.id];
    const visibilityFilter = visibilitySqlFilter(
      "visibility",
      scope,
      input.requesterUserId ?? input.source.userId,
      values
    );
    const memoryIdFilter = input.memoryId ? `and id = $${values.push(input.memoryId)}::uuid` : "";
    const queryParam = values.push(input.memoryId ? "" : normalizeLookupText(input.query ?? ""));
    const vectorParam = input.queryEmbedding?.length
      ? values.push(vectorParameter(input.queryEmbedding))
      : undefined;
    const limitParam = values.push(limit);
    const normalizedDocument =
      "regexp_replace(lower(coalesce(title, '') || ' ' || content || ' ' || coalesce(query_text, '')), '\\s+', '', 'g')";
    const lexicalMatch = `${normalizedDocument} like '%' || $${queryParam} || '%'`;
    const semanticScore = vectorParam
      ? `case when embedding is null then null else 1 - (embedding <=> $${vectorParam}::vector) end`
      : "null::double precision";
    const semanticMatch = vectorParam
      ? `embedding is not null and (embedding <=> $${vectorParam}::vector) <= 0.35`
      : "false";
    const result = await this.db.query(
      `
      with authorized_memories as materialized (
        select *
        from agent_text_memories
        where profile_name = $1
          and scope_type = $2
          and scope_id = $3
          ${visibilityFilter}
          ${memoryIdFilter}
          and deleted_at is null
          and expires_at > now()
      ), ranked as (
        select *,
          ($${queryParam} = '' or ${lexicalMatch}) as lexical_match,
          ${semanticScore} as semantic_score
        from authorized_memories
      )
      select *
      from ranked
      where $${queryParam} = '' or lexical_match or (${semanticMatch})
      order by lexical_match desc, semantic_score desc nulls last, created_at desc
      limit $${limitParam}
      `,
      values
    );
    return result.rows.map(mapTextMemory);
  }

  async listTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    return this.searchTextMemories({ ...input, query: undefined });
  }

  async listTextMemoriesMissingEmbedding(
    limit: number
  ): Promise<AgentTextMemoryEmbeddingCandidate[]> {
    const result = await this.db.query(
      `select id, title, content
       from agent_text_memories
       where embedding is null and deleted_at is null and expires_at > now()
       order by created_at asc
       limit $1`,
      [Math.max(0, Math.min(limit, 100))]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      title: optionalString(row.title),
      content: String(row.content)
    }));
  }

  async updateTextMemoryEmbedding(id: string, embedding: number[]): Promise<boolean> {
    const result = await this.db.query(
      `update agent_text_memories
       set embedding = $2::vector
       where id = $1 and embedding is null and deleted_at is null and expires_at > now()
       returning id`,
      [id, vectorParameter(embedding)]
    );
    return result.rows.length > 0;
  }

  async saveScheduleMemory(
    input: SaveAgentScheduleMemoryInput
  ): Promise<AgentScheduleMemoryRecord> {
    const scope = profileScope(input.profileName);
    const memoryId = randomUUID();
    const expiresAt = input.expiresAt ?? this.defaultExpiresAt();
    const periodKey = input.periodKey ?? input.entries[0]?.serviceDate.slice(0, 7) ?? "unknown";
    await this.db.query(
      `update agent_schedule_memories
       set deleted_at = now()
       where profile_name = $1 and schedule_type = $2 and period_key = $3 and deleted_at is null`,
      [input.profileName, input.scheduleType, periodKey]
    );
    const memoryResult = await this.db.query(
      `
      insert into agent_schedule_memories
        (id, profile_name, scope_type, scope_id, schedule_type, period_key, title, original_text, created_by, visibility, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      returning *
      `,
      [
        memoryId,
        input.profileName,
        scope.type,
        scope.id,
        input.scheduleType,
        periodKey,
        input.title,
        input.originalText,
        input.createdBy ?? null,
        "profile",
        expiresAt
      ]
    );

    const entries: AgentScheduleEntryRecord[] = [];
    for (const entry of input.entries) {
      const entryResult = await this.db.query(
        `
        insert into agent_schedule_entries
          (id, schedule_memory_id, service_date, weekday, meeting_name, role, assignee, family_name, notes)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning *
        `,
        [
          randomUUID(),
          memoryId,
          entry.serviceDate,
          entry.weekday ?? null,
          entry.meetingName,
          entry.role ?? null,
          entry.assignee,
          entry.familyName ?? null,
          entry.notes ?? null
        ]
      );
      entries.push(mapScheduleEntry({ ...entryResult.rows[0], ...memoryResult.rows[0] }));
    }

    return mapScheduleMemory(memoryResult.rows[0], entries);
  }

  async listScheduleMemories(
    input: ListAgentScheduleMemoriesInput
  ): Promise<AgentScheduleMemoryRecord[]> {
    const result = await this.db.query(
      `
      select *
      from agent_schedule_memories
      where profile_name = $1
        and scope_type = 'profile'
        and scope_id = $1
        and deleted_at is null
        and expires_at > now()
      order by created_at desc
      limit $2
      `,
      [input.profileName, input.limit ?? 10]
    );
    return result.rows.map((row) => mapScheduleMemory(row, []));
  }

  async searchScheduleEntries(
    input: SearchAgentScheduleEntriesInput
  ): Promise<AgentScheduleEntryRecord[]> {
    const values: unknown[] = [input.profileName, "profile", input.profileName];
    const filters: string[] = [];
    if (input.memoryId) {
      values.push(input.memoryId);
      filters.push(`and m.id = $${values.length}::uuid`);
    }
    if (input.scheduleType) {
      values.push(input.scheduleType);
      filters.push(`and m.schedule_type = $${values.length}`);
    }
    if (input.date) {
      values.push(input.date);
      filters.push(`and e.service_date = $${values.length}::date`);
    }
    if (input.role?.trim()) {
      values.push(`%${input.role.trim().toLowerCase()}%`);
      filters.push(`and lower(coalesce(e.role, '')) like $${values.length}`);
    }
    const limitParam = values.length + 1;
    values.push(Math.max(input.limit ?? 10, 50));
    const result = await this.db.query(
      `
      select
        e.*,
        m.id as memory_id,
        m.profile_name,
        m.scope_type,
        m.scope_id,
        m.schedule_type,
        m.title as schedule_title,
        m.visibility,
        m.created_by,
        m.created_at as memory_created_at,
        m.expires_at,
        m.deleted_at
      from agent_schedule_entries e
      join agent_schedule_memories m on m.id = e.schedule_memory_id
      where m.profile_name = $1
        and m.scope_type = $2
        and m.scope_id = $3
        and m.deleted_at is null
        and e.deleted_at is null
        and m.expires_at > now()
        ${filters.join("\n        ")}
      order by e.service_date asc, m.created_at desc, e.meeting_name asc
      limit $${limitParam}
      `,
      values
    );
    const query = normalizeLookupText(input.query ?? "");
    const meetingName = normalizeLookupText(input.meetingName ?? "");
    const role = normalizeLookupText(input.role ?? "");
    return result.rows
      .map(mapScheduleEntry)
      .filter(
        (entry) =>
          (!meetingName || normalizeLookupText(entry.meetingName).includes(meetingName)) &&
          (!role || normalizeLookupText(entry.role ?? "").includes(role)) &&
          (!query || normalizeLookupText(scheduleEntrySearchText(entry)).includes(query))
      )
      .slice(0, input.limit ?? 10);
  }

  async addScheduleEntry(
    input: AddAgentScheduleEntryInput
  ): Promise<AgentScheduleEntryRecord | undefined> {
    const result = await this.db.query(
      `
      insert into agent_schedule_entries
        (id, schedule_memory_id, service_date, weekday, meeting_name, role, assignee, family_name, notes)
      select $1, m.id, $4::date, $5, $6, $7, $8, $9, $10
      from agent_schedule_memories m
      where m.profile_name = $2
        and m.schedule_type = $3
        and m.period_key = left($4, 7)
        and m.deleted_at is null
        and m.expires_at > now()
      returning id
      `,
      [
        randomUUID(),
        input.profileName,
        input.scheduleType,
        input.entry.serviceDate,
        input.entry.weekday ?? null,
        input.entry.meetingName,
        input.entry.role ?? null,
        input.entry.assignee,
        input.entry.familyName ?? null,
        input.entry.notes ?? null
      ]
    );
    const id = result.rows[0]?.id;
    if (!id) {
      return undefined;
    }
    const entries = await this.searchScheduleEntries({
      profileName: input.profileName,
      source: { type: "user", userId: "profile" },
      date: input.entry.serviceDate,
      query: input.entry.assignee,
      limit: 10
    });
    return entries.find((entry) => entry.id === String(id));
  }

  async updateScheduleEntry(
    input: UpdateAgentScheduleEntryInput
  ): Promise<AgentScheduleEntryRecord | undefined> {
    const current = await this.db.query(
      `
      select e.*, m.id as memory_id, m.profile_name, m.scope_type, m.scope_id,
             m.schedule_type, m.title as schedule_title, m.visibility, m.created_by,
             m.created_at as memory_created_at, m.expires_at, m.deleted_at
      from agent_schedule_entries e
      join agent_schedule_memories m on m.id = e.schedule_memory_id
      where e.id = $1 and m.profile_name = $2 and e.deleted_at is null and m.deleted_at is null
      `,
      [input.entryId, input.profileName]
    );
    if (!current.rows[0]) {
      return undefined;
    }
    const existing = mapScheduleEntry(current.rows[0]);
    const next = { ...existing, ...input.changes };
    await this.db.query(
      `
      update agent_schedule_entries
      set service_date = $3::date, weekday = $4, meeting_name = $5, role = $6,
          assignee = $7, family_name = $8, notes = $9, updated_at = now()
      where id = $1 and schedule_memory_id = $2 and deleted_at is null
      `,
      [
        existing.id,
        existing.memoryId,
        next.serviceDate,
        next.weekday ?? null,
        next.meetingName,
        next.role ?? null,
        next.assignee,
        next.familyName ?? null,
        next.notes ?? null
      ]
    );
    return next;
  }

  async deleteScheduleEntry(input: DeleteAgentScheduleEntryInput): Promise<boolean> {
    const result = await this.db.query(
      `
      update agent_schedule_entries e
      set deleted_at = now(), updated_at = now()
      from agent_schedule_memories m
      where e.id = $1 and e.schedule_memory_id = m.id and m.profile_name = $2
        and e.deleted_at is null and m.deleted_at is null
      returning e.id
      `,
      [input.entryId, input.profileName]
    );
    return result.rows.length > 0;
  }

  async forgetMemory(input: ForgetAgentMemoryInput): Promise<boolean> {
    const scope = scopeFromSource(input.source);
    const result = await this.db.query(
      `
      update agent_text_memories
      set deleted_at = now()
      where profile_name = $1
        and scope_type = $2
        and scope_id = $3
        and id = $4
        and deleted_at is null
        and ($5::boolean = true or created_by = $6)
      returning id
      `,
      [
        input.profileName,
        scope.type,
        scope.id,
        input.id,
        input.isAdmin ?? false,
        input.deletedBy ?? null
      ]
    );
    return result.rows.length > 0;
  }

  async forgetResource(input: ForgetAgentMemoryInput): Promise<boolean> {
    const scope = scopeFromSource(input.source);
    const result = await this.db.query(
      `
      update agent_resources
      set deleted_at = now()
      where profile_name = $1
        and scope_type = $2
        and scope_id = $3
        and id = $4
        and deleted_at is null
        and ($5::boolean = true or created_by = $6)
      returning id
      `,
      [
        input.profileName,
        scope.type,
        scope.id,
        input.id,
        input.isAdmin ?? false,
        input.deletedBy ?? null
      ]
    );
    return result.rows.length > 0;
  }

  async forgetScheduleMemory(input: ForgetAgentMemoryInput): Promise<boolean> {
    const result = await this.db.query(
      `
      update agent_schedule_memories
      set deleted_at = now()
      where profile_name = $1
        and scope_type = $2
        and scope_id = $3
        and id = $4
        and deleted_at is null
        and ($5::boolean = true or created_by = $6)
      returning id
      `,
      [
        input.profileName,
        "profile",
        input.profileName,
        input.id,
        input.isAdmin ?? false,
        input.deletedBy ?? null
      ]
    );
    return result.rows.length > 0;
  }

  async purgeExpired(now = this.now()): Promise<AgentMemoryPurgeResult> {
    const expiresAt = now.toISOString();
    const resources = await this.db.query<{ id: string }>(
      "delete from agent_resources where expires_at <= $1 or deleted_at is not null returning id",
      [expiresAt]
    );
    const textMemories = await this.db.query<{ id: string }>(
      "delete from agent_text_memories where expires_at <= $1 or deleted_at is not null returning id",
      [expiresAt]
    );
    const scheduleMemories = await this.db.query<{ id: string }>(
      "delete from agent_schedule_memories where expires_at <= $1 or deleted_at is not null returning id",
      [expiresAt]
    );
    const aliases = await this.db.query<{ id: string }>(
      "delete from agent_resource_aliases where resource_id not in (select id from agent_resources) returning id"
    );
    return {
      resources: resources.rows.length,
      textMemories: textMemories.rows.length,
      scheduleMemories: scheduleMemories.rows.length,
      aliases: aliases.rows.length
    };
  }

  async summary(): Promise<AgentMemorySummary> {
    const result = await this.db.query<{
      resources: string;
      external_resources: string;
      text_memories: string;
      schedule_memories: string;
      schedule_entries: string;
      aliases: string;
    }>(
      `
      select
        (select count(*) from agent_resources where deleted_at is null and expires_at > now())::text as resources,
        (select count(*) from agent_resources where storage_provider = 'external_link' and deleted_at is null and expires_at > now())::text as external_resources,
        (select count(*) from agent_text_memories where deleted_at is null and expires_at > now())::text as text_memories,
        (select count(*) from agent_schedule_memories where deleted_at is null and expires_at > now())::text as schedule_memories,
        (select count(*) from agent_schedule_entries e join agent_schedule_memories m on m.id = e.schedule_memory_id where m.deleted_at is null and m.expires_at > now())::text as schedule_entries,
        (select count(*) from agent_resource_aliases)::text as aliases
      `
    );
    const row = result.rows[0];
    return {
      resources: Number(row?.resources ?? 0),
      externalResources: Number(row?.external_resources ?? 0),
      textMemories: Number(row?.text_memories ?? 0),
      scheduleMemories: Number(row?.schedule_memories ?? 0),
      scheduleEntries: Number(row?.schedule_entries ?? 0),
      aliases: Number(row?.aliases ?? 0)
    };
  }

  private defaultExpiresAt(): string {
    return new Date(this.now().getTime() + this.ttlMs).toISOString();
  }
}

function mapResource(row: Record<string, unknown>): AgentResourceRecord {
  const storageProvider = String(row.storage_provider);
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    scope: mapScope(row),
    visibility: memoryVisibility(row.visibility),
    resourceType: row.resource_type as AgentResourceType,
    title: String(row.title),
    query: optionalString(row.query_text),
    storage:
      storageProvider === "external_link"
        ? {
            provider: "external_link",
            url: String(row.external_url),
            sourceLabel: optionalString(row.source_label),
            description: optionalString(row.description)
          }
        : {
            provider: "graph",
            driveId: String(row.drive_id),
            itemId: String(row.item_id)
          },
    createdBy: optionalString(row.created_by),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    deletedAt: optionalIso(row.deleted_at)
  };
}

function mapTextMemory(row: Record<string, unknown>): AgentTextMemoryRecord {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    scope: mapScope(row),
    visibility: memoryVisibility(row.visibility),
    title: optionalString(row.title),
    content: String(row.content),
    query: optionalString(row.query_text),
    createdBy: optionalString(row.created_by),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    deletedAt: optionalIso(row.deleted_at)
  };
}

function mapScheduleMemory(
  row: Record<string, unknown>,
  entries: AgentScheduleEntryRecord[]
): AgentScheduleMemoryRecord {
  return {
    id: String(row.id),
    profileName: String(row.profile_name),
    scope: mapScope(row),
    visibility: memoryVisibility(row.visibility),
    scheduleType: row.schedule_type as AgentScheduleMemoryRecord["scheduleType"],
    periodKey: String(row.period_key ?? "unknown"),
    title: String(row.title),
    originalText: String(row.original_text),
    entries,
    createdBy: optionalString(row.created_by),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    deletedAt: optionalIso(row.deleted_at)
  };
}

function mapScheduleEntry(row: Record<string, unknown>): AgentScheduleEntryRecord {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id ?? row.schedule_memory_id),
    profileName: String(row.profile_name),
    scope: mapScope(row),
    visibility: memoryVisibility(row.visibility),
    createdBy: optionalString(row.created_by),
    scheduleType: row.schedule_type as AgentScheduleEntryRecord["scheduleType"],
    scheduleTitle: String(row.schedule_title ?? row.title),
    serviceDate: toDateKey(row.service_date),
    weekday: optionalString(row.weekday),
    meetingName: String(row.meeting_name),
    role: optionalString(row.role),
    assignee: String(row.assignee),
    familyName: optionalString(row.family_name),
    notes: optionalString(row.notes),
    createdAt: toIso(row.memory_created_at ?? row.created_at),
    expiresAt: toIso(row.expires_at),
    deletedAt: optionalIso(row.deleted_at)
  };
}

function mapScope(row: Record<string, unknown>): AgentMemoryScope {
  return {
    type: row.scope_type as AgentMemoryScope["type"],
    id: String(row.scope_id)
  };
}

function memoryVisibility(value: unknown): AgentMemoryVisibility {
  return value === "profile" ? "profile" : value === "group" ? "group" : "private";
}

function visibilitySqlFilter(
  column: string,
  scope: AgentMemoryScope,
  requesterUserId: string | undefined,
  values: unknown[],
  createdByColumn = "created_by"
): string {
  if (scope.type === "user") {
    return "";
  }
  if (!requesterUserId) {
    return `and ${column} = 'group'`;
  }
  values.push(requesterUserId);
  return `and (${column} = 'group' or ${createdByColumn} = $${values.length})`;
}

function vectorParameter(vector: number[] | undefined): string | null {
  if (!vector?.length || vector.some((value) => !Number.isFinite(value))) return null;
  return `[${vector.join(",")}]`;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalIso(value: unknown): string | undefined {
  return value ? toIso(value) : undefined;
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function toDateKey(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}
