import { randomUUID } from "node:crypto";

import type { AgentResourceType } from "../types.js";
import {
  normalizeLookupText,
  scopeFromSource,
  type AgentMemoryScope,
  type AgentMemoryStore,
  type AgentMemorySummary,
  type AgentResourceRecord,
  type AgentTextMemoryRecord,
  type FindAgentResourceByAliasInput,
  type FindRecentAgentResourceInput,
  type ForgetAgentMemoryInput,
  type RecordAgentResourceInput,
  type RememberAgentAliasInput,
  type SaveAgentTextMemoryInput,
  type SearchAgentResourcesInput,
  type SearchAgentTextMemoriesInput
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
         created_by, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
        input.expiresAt ?? this.defaultExpiresAt()
      ]
    );
    return mapResource(result.rows[0]);
  }

  async findRecentResource(
    input: FindRecentAgentResourceInput
  ): Promise<AgentResourceRecord | undefined> {
    const scope = scopeFromSource(input.source);
    const typeFilter = input.resourceTypes?.length ? "and resource_type = any($4::text[])" : "";
    const requesterFilter = input.requesterUserId
      ? `and created_by = $${input.resourceTypes?.length ? 5 : 4}`
      : "";
    const values: unknown[] = [input.profileName, scope.type, scope.id];
    if (input.resourceTypes?.length) {
      values.push(input.resourceTypes);
    }
    if (input.requesterUserId) {
      values.push(input.requesterUserId);
    }
    const result = await this.db.query(
      `
      select *
      from agent_resources
      where profile_name = $1
        and scope_type = $2
        and scope_id = $3
        ${typeFilter}
        ${requesterFilter}
        and deleted_at is null
        and expires_at > now()
      order by created_at desc
      limit 1
      `,
      values
    );
    return result.rows[0] ? mapResource(result.rows[0]) : undefined;
  }

  async searchResources(input: SearchAgentResourcesInput): Promise<AgentResourceRecord[]> {
    const scope = scopeFromSource(input.source);
    const values: unknown[] = [input.profileName, scope.type, scope.id];
    const typeFilter = input.resourceTypes?.length ? "and resource_type = any($4::text[])" : "";
    if (input.resourceTypes?.length) {
      values.push(input.resourceTypes);
    }
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
        (id, profile_name, scope_type, scope_id, title, content, query_text, created_by, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        input.expiresAt ?? this.defaultExpiresAt()
      ]
    );
    return mapTextMemory(result.rows[0]);
  }

  async searchTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    const scope = scopeFromSource(input.source);
    const limit = Math.max(input.limit ?? 5, 5);
    const result = await this.db.query(
      `
      select *
      from agent_text_memories
      where profile_name = $1
        and scope_type = $2
        and scope_id = $3
        and deleted_at is null
        and expires_at > now()
      order by created_at desc
      limit $4
      `,
      [input.profileName, scope.type, scope.id, Math.max(limit, 50)]
    );
    const query = normalizeLookupText(input.query ?? "");
    return result.rows
      .map(mapTextMemory)
      .filter((memory) => !query || normalizeLookupText(memorySearchText(memory)).includes(query))
      .slice(0, input.limit ?? 5);
  }

  async listTextMemories(input: SearchAgentTextMemoriesInput): Promise<AgentTextMemoryRecord[]> {
    return this.searchTextMemories({ ...input, query: undefined });
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
      returning id
      `,
      [input.profileName, scope.type, scope.id, input.id]
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
      returning id
      `,
      [input.profileName, scope.type, scope.id, input.id]
    );
    return result.rows.length > 0;
  }

  async summary(): Promise<AgentMemorySummary> {
    const result = await this.db.query<{
      resources: string;
      external_resources: string;
      text_memories: string;
      aliases: string;
    }>(
      `
      select
        (select count(*) from agent_resources where deleted_at is null and expires_at > now())::text as resources,
        (select count(*) from agent_resources where storage_provider = 'external_link' and deleted_at is null and expires_at > now())::text as external_resources,
        (select count(*) from agent_text_memories where deleted_at is null and expires_at > now())::text as text_memories,
        (select count(*) from agent_resource_aliases)::text as aliases
      `
    );
    const row = result.rows[0];
    return {
      resources: Number(row?.resources ?? 0),
      externalResources: Number(row?.external_resources ?? 0),
      textMemories: Number(row?.text_memories ?? 0),
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
    title: optionalString(row.title),
    content: String(row.content),
    query: optionalString(row.query_text),
    createdBy: optionalString(row.created_by),
    createdAt: toIso(row.created_at),
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
