import { randomUUID } from "node:crypto";

import { normalizeKnowledgeSourceRoutingFields } from "./routing-metadata.js";
import { knowledgeSectionKey } from "./section-key.js";

import type {
  KnowledgeChunkInput,
  KnowledgeDocumentRecord,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSnapshotDocumentInput,
  KnowledgeSourceInput,
  KnowledgeSourceRecord,
  KnowledgeStore,
  KnowledgeSyncFailureOutcome,
  KnowledgeTopPerSourceInput,
  PublishKnowledgeSourceSnapshotInput
} from "./store.js";
import { assertKnowledgeSourceScope } from "./store.js";

export interface PgKnowledgeExecutor {
  query(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface PgKnowledgeQueryable extends PgKnowledgeExecutor {
  connect?(): Promise<PgKnowledgeClient>;
}

export interface PgKnowledgeClient extends PgKnowledgeExecutor {
  release(): void;
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  constructor(private readonly db: PgKnowledgeQueryable) {}

  async upsertSource(input: KnowledgeSourceInput): Promise<KnowledgeSourceRecord> {
    const staged = normalizeKnowledgeSourceRoutingFields(input);
    const result = await this.db.query(
      `insert into knowledge_sources
       (id, profile_name, source_key, display_name, adapter_type, external_root_id, root_url,
        enabled, expires_at, staged_display_name, staged_adapter_type, staged_external_root_id,
        staged_root_url, staged_enabled, staged_expires_at, staging_revision,
        admin_aliases, admin_topics, admin_sample_queries)
       values ($1,$2,$3,$4,$5,$6,$7,false,null,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (profile_name, source_key) do update set
         staged_display_name=excluded.staged_display_name,
         staged_adapter_type=excluded.staged_adapter_type,
         staged_external_root_id=excluded.staged_external_root_id,
         staged_root_url=excluded.staged_root_url,
         staged_enabled=excluded.staged_enabled,
         staged_expires_at=excluded.staged_expires_at,
         staging_revision=excluded.staging_revision,
         admin_aliases=excluded.admin_aliases, admin_topics=excluded.admin_topics,
         admin_sample_queries=excluded.admin_sample_queries,
         updated_at=now()
       returning *`,
      [
        randomUUID(),
        input.profileName,
        staged.sourceKey,
        staged.displayName,
        input.adapterType,
        input.externalRootId,
        input.rootUrl,
        input.enabled,
        input.expiresAt ?? null,
        randomUUID(),
        staged.aliases,
        staged.topics,
        staged.sampleQueries
      ]
    );
    return requiredSource(result.rows[0]);
  }

  async listSources(input: {
    profileName: string;
    includeDisabled?: boolean;
  }): Promise<KnowledgeSourceRecord[]> {
    const result = await this.db.query(
      `select * from knowledge_sources where profile_name=$1
       and ($2::boolean or (enabled=true and (expires_at is null or expires_at > now())))
       order by source_key`,
      [input.profileName, input.includeDisabled ?? false]
    );
    return result.rows.flatMap((row) => {
      const source = safeMapSource(row);
      return source ? [source] : [];
    });
  }

  async markSourceSyncFailed(input: {
    profileName: string;
    sourceKey: string;
    expectedStagingRevision: string;
    syncErrorCode: string;
  }): Promise<KnowledgeSyncFailureOutcome> {
    const result = await this.db.query(
      `with target as (
         select 1 from knowledge_sources where profile_name=$1 and source_key=$2
       ), mark_source_failure as (
         update knowledge_sources set sync_status='failed', sync_error_code=$4, updated_at=now()
         where profile_name=$1 and source_key=$2 and staging_revision=$3::uuid returning 1
       ) select case
           when exists(select 1 from mark_source_failure) then 'updated'
           when exists(select 1 from target) then 'stale'
           else 'not_found'
         end outcome`,
      [input.profileName, input.sourceKey, input.expectedStagingRevision, input.syncErrorCode]
    );
    const outcome = result.rows[0]?.outcome;
    return outcome === "updated" || outcome === "stale" ? outcome : "not_found";
  }

  async updateSource(input: {
    profileName: string;
    sourceKey: string;
    enabled?: boolean;
    syncStatus?: KnowledgeSourceRecord["syncStatus"];
    syncErrorCode?: string;
    lastSyncedAt?: string;
    routingDisplayName?: string;
    aliases?: string[];
    topics?: string[];
    sampleQueries?: string[];
  }): Promise<KnowledgeSourceRecord | undefined> {
    let promoted;
    if (input.lastSyncedAt || input.routingDisplayName) {
      const current = (
        await this.db.query(
          "select staged_display_name, admin_aliases, admin_topics, admin_sample_queries from knowledge_sources where profile_name=$1 and source_key=$2",
          [input.profileName, input.sourceKey]
        )
      ).rows[0];
      if (!current) return undefined;
      promoted = normalizeKnowledgeSourceRoutingFields({
        sourceKey: input.sourceKey,
        displayName: input.routingDisplayName ?? String(current.staged_display_name),
        aliases: input.aliases ?? stringArray(current.admin_aliases),
        topics: input.topics ?? stringArray(current.admin_topics),
        sampleQueries: input.sampleQueries ?? stringArray(current.admin_sample_queries)
      });
    }
    const result = await this.db.query(
      `update knowledge_sources set
         display_name=case when $11 then staged_display_name else display_name end,
         adapter_type=case when $11 then staged_adapter_type else adapter_type end,
         external_root_id=case when $11 then staged_external_root_id else external_root_id end,
         root_url=case when $11 then staged_root_url else root_url end,
         expires_at=case when $11 then staged_expires_at else expires_at end,
         enabled=case when $3::boolean is not null then $3 when $11 then staged_enabled else enabled end,
         staged_enabled=coalesce($3, staged_enabled),
         disabled_at=case
           when $3::boolean=false then coalesce(disabled_at, now())
           when $3::boolean=true then null
           when $11 and staged_enabled=false then coalesce(disabled_at, now())
           when $11 and staged_enabled=true then null
           else disabled_at end,
         purge_after=case when $3::boolean=true or ($11 and staged_enabled=true) then null else purge_after end,
         sync_status=coalesce($4, sync_status),
         sync_error_code=case when $4::text is null then sync_error_code else $5 end,
         last_synced_at=coalesce($6::timestamptz, last_synced_at),
         routing_display_name=coalesce($7::text, routing_display_name),
         aliases=coalesce($8::text[], aliases), topics=coalesce($9::text[], topics),
        sample_queries=coalesce($10::text[], sample_queries), updated_at=now()
       where profile_name=$1 and source_key=$2 returning *`,
      [
        input.profileName,
        input.sourceKey,
        input.enabled ?? null,
        input.syncStatus ?? null,
        input.syncErrorCode ?? null,
        input.lastSyncedAt ?? null,
        promoted?.displayName ?? null,
        promoted?.aliases ?? null,
        promoted?.topics ?? null,
        promoted?.sampleQueries ?? null,
        Boolean(promoted)
      ]
    );
    return result.rows[0] ? safeMapSource(result.rows[0]) : undefined;
  }

  async removeSource(input: { profileName: string; sourceKey: string }): Promise<boolean> {
    const result = await this.db.query(
      "delete from knowledge_sources where profile_name=$1 and source_key=$2 returning id",
      [input.profileName, input.sourceKey]
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async publishSourceSnapshot(
    input: PublishKnowledgeSourceSnapshotInput
  ): Promise<KnowledgeSourceRecord> {
    return this.transaction(async (db) => {
      const locked = await db.query(
        "select * from knowledge_sources where id=$1 and staging_revision=$2::uuid for update",
        [input.sourceId, input.expectedStagingRevision]
      );
      if (!locked.rows[0]) throw new Error("knowledge_source_staging_changed");

      const chunkIds = new Map<string, string>();
      for (const document of input.documents) {
        const documentId = await replaceSnapshotDocument(db, input.sourceId, document, chunkIds);
        chunkIds.set(`${document.externalId}:document`, documentId);
      }
      const liveExternalIds = input.documents.map(({ externalId }) => externalId);
      await db.query(
        `update knowledge_documents set deleted_at=$3
         where source_id=$1 and deleted_at is null and not (external_id=any($2::text[]))`,
        [input.sourceId, liveExternalIds, input.syncedAt]
      );
      await db.query(
        `delete from knowledge_embeddings e using knowledge_chunks c, knowledge_documents d
         where e.chunk_id=c.id and c.document_id=d.id and d.source_id=$1
           and (d.deleted_at is not null or c.active=false)`,
        [input.sourceId]
      );
      for (const embedding of input.embeddings) {
        validateSnapshotEmbedding(embedding);
        const chunkId = chunkIds.get(`${embedding.documentExternalId}:${embedding.contentHash}`);
        if (!chunkId) throw new Error("knowledge_embedding_chunk_missing");
        await db.query(
          `insert into knowledge_embeddings (chunk_id,provider,model,dimensions,embedding,content_hash)
           values ($1,$2,$3,$4,$5::vector,$6)
           on conflict (chunk_id,provider,model) do update set dimensions=excluded.dimensions,
           embedding=excluded.embedding, content_hash=excluded.content_hash, embedded_at=now()`,
          [
            chunkId,
            embedding.provider,
            embedding.model,
            embedding.dimensions,
            vectorLiteral(embedding.embedding),
            embedding.contentHash
          ]
        );
      }
      const promoted = normalizeKnowledgeSourceRoutingFields({
        sourceKey: requiredString(locked.rows[0].source_key),
        displayName: input.routingDisplayName,
        aliases: input.aliases,
        topics: input.topics,
        sampleQueries: input.sampleQueries
      });
      const result = await db.query(
        `update knowledge_sources set
           display_name=staged_display_name, adapter_type=staged_adapter_type,
           external_root_id=staged_external_root_id, root_url=staged_root_url,
           enabled=staged_enabled, expires_at=staged_expires_at,
           disabled_at=case when staged_enabled then null else coalesce(disabled_at,$3::timestamptz) end,
           purge_after=case when staged_enabled then null else purge_after end,
           routing_display_name=$4, aliases=$5, topics=$6, sample_queries=$7,
           sync_status=$8, sync_error_code=null, last_synced_at=$3,
           staging_revision=gen_random_uuid(), updated_at=now()
         where id=$1 and staging_revision=$2::uuid returning *`,
        [
          input.sourceId,
          input.expectedStagingRevision,
          input.syncedAt,
          promoted.displayName,
          promoted.aliases,
          promoted.topics,
          promoted.sampleQueries,
          input.syncStatus
        ]
      );
      return requiredSource(result.rows[0]);
    });
  }

  async replaceDocument(input: {
    sourceId: string;
    externalId: string;
    title: string;
    url: string;
    properties?: Record<string, unknown>;
    nodes: Array<{
      externalId: string;
      parentExternalId?: string;
      type: string;
      ordinal: number;
      text: string;
      metadata?: Record<string, unknown>;
    }>;
    chunks: KnowledgeChunkInput[];
  }): Promise<KnowledgeDocumentRecord> {
    const docResult = await this.db.query(
      `insert into knowledge_documents (id, source_id, external_id, title, url, properties)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (source_id, external_id) do update set title=excluded.title, url=excluded.url,
       properties=excluded.properties, deleted_at=null, updated_at=now() returning *`,
      [
        randomUUID(),
        input.sourceId,
        input.externalId,
        input.title,
        input.url,
        JSON.stringify(input.properties ?? {})
      ]
    );
    const documentId = String(docResult.rows[0]!.id);
    await this.db.query("delete from knowledge_nodes where document_id=$1", [documentId]);
    const nodes = [];
    for (const node of input.nodes) {
      const id = randomUUID();
      await this.db.query(
        `insert into knowledge_nodes (id,document_id,external_id,parent_external_id,node_type,ordinal,text_content,metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          id,
          documentId,
          node.externalId,
          node.parentExternalId ?? null,
          node.type,
          node.ordinal,
          node.text,
          JSON.stringify(node.metadata ?? {})
        ]
      );
      nodes.push({ ...node, id });
    }
    const liveHashes: string[] = [];
    const chunks = [];
    for (const chunk of input.chunks) {
      liveHashes.push(chunk.contentHash);
      const result = await this.db.query(
        `insert into knowledge_chunks (id,document_id,heading_path,section_key,ordinal,content,content_hash,metadata,active)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
         on conflict (document_id,content_hash) do update set heading_path=excluded.heading_path,
         section_key=excluded.section_key, ordinal=excluded.ordinal, content=excluded.content,
         metadata=excluded.metadata, active=true
         returning *`,
        [
          randomUUID(),
          documentId,
          chunk.headingPath,
          knowledgeSectionKey(chunk.headingPath),
          chunk.ordinal,
          chunk.content,
          chunk.contentHash,
          JSON.stringify(chunk.metadata ?? {})
        ]
      );
      chunks.push(mapChunk(result.rows[0]!));
    }
    await this.db.query(
      "update knowledge_chunks set active=false where document_id=$1 and not (content_hash = any($2::text[]))",
      [documentId, liveHashes]
    );
    return {
      id: documentId,
      sourceId: input.sourceId,
      externalId: input.externalId,
      title: input.title,
      url: input.url,
      properties: input.properties,
      nodes,
      chunks
    };
  }

  async tombstoneMissingDocuments(input: {
    sourceId: string;
    liveExternalIds: string[];
    deletedAt: string;
  }): Promise<number> {
    const result = await this.db.query(
      "update knowledge_documents set deleted_at=$3 where source_id=$1 and deleted_at is null and not (external_id=any($2::text[])) returning id",
      [input.sourceId, input.liveExternalIds, input.deletedAt]
    );
    return result.rowCount ?? result.rows.length;
  }

  async upsertEmbedding(input: {
    chunkId: string;
    provider: string;
    model: string;
    dimensions: number;
    embedding: number[];
    contentHash: string;
  }): Promise<void> {
    await this.db.query(
      `insert into knowledge_embeddings (chunk_id,provider,model,dimensions,embedding,content_hash)
       values ($1,$2,$3,$4,$5::vector,$6)
       on conflict (chunk_id,provider,model) do update set dimensions=excluded.dimensions,
       embedding=excluded.embedding, content_hash=excluded.content_hash, embedded_at=now()`,
      [
        input.chunkId,
        input.provider,
        input.model,
        input.dimensions,
        vectorLiteral(input.embedding),
        input.contentHash
      ]
    );
  }

  async listChunksNeedingEmbedding(input: { chunkIds: string[]; provider: string; model: string }) {
    if (input.chunkIds.length === 0) return [];
    const result = await this.db.query(
      `select c.* from knowledge_chunks c left join knowledge_embeddings e
       on e.chunk_id=c.id and e.provider=$2 and e.model=$3
       where c.id=any($1::uuid[]) and c.active=true and (e.chunk_id is null or e.content_hash<>c.content_hash)`,
      [input.chunkIds, input.provider, input.model]
    );
    return result.rows.map(mapChunk);
  }

  async hasAnchor(input: {
    profileName: string;
    sourceId: string;
    documentId: string;
    sectionKey?: string;
  }): Promise<boolean> {
    const result = await this.db.query(
      `select 1 from knowledge_documents d join knowledge_sources s on s.id=d.source_id
       where s.profile_name=$1 and s.id=$2 and s.enabled=true and s.last_synced_at is not null
         and s.routing_display_name is not null
         and (s.expires_at is null or s.expires_at>now()) and d.id=$3 and d.deleted_at is null
         and ($4::text is null or exists (
           select 1 from knowledge_chunks c where c.document_id=d.id and c.active=true and c.section_key=$4
         )) limit 1`,
      [input.profileName, input.sourceId, input.documentId, input.sectionKey ?? null]
    );
    return result.rows.length > 0;
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    const vector = input.queryEmbedding ? vectorLiteral(input.queryEmbedding) : null;
    const result = await this.db.query(
      `with candidates as (
        select c.*, d.external_id, d.title, d.url, s.id source_id, s.profile_name,
          s.source_key, s.display_name, s.routing_display_name,
          s.admin_aliases, s.admin_topics, s.admin_sample_queries,
          s.aliases, s.topics, s.sample_queries,
          s.adapter_type, s.external_root_id, s.root_url,
          s.enabled, s.expires_at, s.disabled_at, s.purge_after, s.last_synced_at,
          s.sync_status, s.sync_error_code,
          case when c.content ilike '%' || $2 || '%' or d.title ilike '%' || $2 || '%' then 2.0
               else ts_rank_cd(c.search_vector, plainto_tsquery('simple',$2)) end lexical_score,
          case when $3::vector is null then 0.0 else coalesce(1-(e.embedding <=> $3::vector),0.0) end vector_score,
          case when $7::integer is null then 0.0 when c.ordinal=$7 then 2.0 else -0.5 end ordinal_score
        from knowledge_chunks c join knowledge_documents d on d.id=c.document_id
        join knowledge_sources s on s.id=d.source_id
        left join knowledge_embeddings e on e.chunk_id=c.id and ($9::integer is null or e.dimensions=$9) and ($10::text is null or e.provider=$10) and ($11::text is null or e.model=$11)
        where s.profile_name=$1 and s.enabled=true and s.last_synced_at is not null
          and s.routing_display_name is not null and (s.expires_at is null or s.expires_at>now())
          and d.deleted_at is null and c.active=true
          and ($4::uuid is null or s.id=$4) and ($5::text is null or s.source_key=$5)
          and ($6::uuid is null or d.id=$6) and ($12::text is null or c.section_key=$12)
          and ($13::uuid[] is null or s.id=any($13::uuid[]))
      ) select *, lexical_score+vector_score+ordinal_score score from candidates
        where lexical_score+vector_score+ordinal_score > 0 order by score desc, ordinal asc limit $8`,
      [
        input.profileName,
        input.query,
        vector,
        input.sourceId ?? null,
        input.sourceKey ?? null,
        input.documentId ?? null,
        input.ordinal ?? null,
        input.limit ?? 8,
        input.embeddingDimensions ?? null,
        input.embeddingProvider ?? null,
        input.embeddingModel ?? null,
        input.sectionKey ?? null,
        input.sourceIds ?? null
      ]
    );
    return result.rows.flatMap((row) => {
      try {
        return [mapSearchResult(row)];
      } catch {
        return [];
      }
    });
  }

  async searchTopPerSource(input: KnowledgeTopPerSourceInput): Promise<KnowledgeSearchResult[]> {
    assertKnowledgeSourceScope(input.sourceIds);
    const vector = input.queryEmbedding ? vectorLiteral(input.queryEmbedding) : null;
    const result = await this.db.query(
      `with candidates as (
        select c.*, d.external_id, d.title, d.url, s.id source_id, s.profile_name,
          s.source_key, s.display_name, s.routing_display_name,
          s.admin_aliases, s.admin_topics, s.admin_sample_queries,
          s.aliases, s.topics, s.sample_queries,
          s.adapter_type, s.external_root_id, s.root_url,
          s.enabled, s.expires_at, s.disabled_at, s.purge_after, s.last_synced_at,
          s.sync_status, s.sync_error_code,
          case when c.content ilike '%' || $2 || '%' or d.title ilike '%' || $2 || '%' then 2.0
               else ts_rank_cd(c.search_vector, plainto_tsquery('simple',$2)) end lexical_score,
          case when $3::vector is null then 0.0 else coalesce(1-(e.embedding <=> $3::vector),0.0) end vector_score,
          case when $7::integer is null then 0.0 when c.ordinal=$7 then 2.0 else -0.5 end ordinal_score
        from knowledge_chunks c join knowledge_documents d on d.id=c.document_id
        join knowledge_sources s on s.id=d.source_id
        left join knowledge_embeddings e on e.chunk_id=c.id and ($4::integer is null or e.dimensions=$4)
          and ($5::text is null or e.provider=$5) and ($6::text is null or e.model=$6)
        where s.profile_name=$1 and s.enabled=true and s.last_synced_at is not null
          and s.routing_display_name is not null and (s.expires_at is null or s.expires_at>now())
          and d.deleted_at is null and c.active=true and s.id=any($8::uuid[])
      ), scored as (
        select *, lexical_score+vector_score+ordinal_score score from candidates
        where lexical_score+vector_score+ordinal_score > 0
      ), ranked as (
        select *, row_number() over (partition by source_id order by score desc, ordinal asc) source_rank
        from scored
      ) select * from ranked where source_rank=1 order by score desc, source_key asc`,
      [
        input.profileName,
        input.query,
        vector,
        input.embeddingDimensions ?? null,
        input.embeddingProvider ?? null,
        input.embeddingModel ?? null,
        input.ordinal ?? null,
        input.sourceIds
      ]
    );
    return result.rows.flatMap((row) => {
      try {
        return [mapSearchResult(row)];
      } catch {
        return [];
      }
    });
  }

  async purgeExpired(now: Date): Promise<number> {
    await this.db.query(
      `update knowledge_sources set enabled=false, disabled_at=coalesce(disabled_at,$1),
       purge_after=coalesce(purge_after,$1 + interval '30 days'), updated_at=$1
       where enabled=true and expires_at <= $1`,
      [now.toISOString()]
    );
    const result = await this.db.query(
      "delete from knowledge_sources where purge_after <= $1 returning id",
      [now.toISOString()]
    );
    return result.rowCount ?? result.rows.length;
  }

  private async transaction<T>(run: (db: PgKnowledgeQueryable) => Promise<T>): Promise<T> {
    const client = this.db.connect ? await this.db.connect() : undefined;
    const db = client ?? this.db;
    let began = false;
    try {
      await db.query("begin");
      began = true;
      const result = await run(db);
      await db.query("commit");
      return result;
    } catch (error) {
      if (began) await db.query("rollback");
      throw error;
    } finally {
      client?.release();
    }
  }
}

async function replaceSnapshotDocument(
  db: PgKnowledgeQueryable,
  sourceId: string,
  input: KnowledgeSnapshotDocumentInput,
  chunkIds: Map<string, string>
): Promise<string> {
  const docResult = await db.query(
    `insert into knowledge_documents (id, source_id, external_id, title, url, properties)
     values ($1,$2,$3,$4,$5,$6::jsonb)
     on conflict (source_id, external_id) do update set title=excluded.title, url=excluded.url,
     properties=excluded.properties, deleted_at=null, updated_at=now() returning *`,
    [
      randomUUID(),
      sourceId,
      input.externalId,
      input.title,
      input.url,
      JSON.stringify(input.properties ?? {})
    ]
  );
  const documentId = requiredString(docResult.rows[0]?.id);
  await db.query("delete from knowledge_nodes where document_id=$1", [documentId]);
  for (const node of input.nodes) {
    await db.query(
      `insert into knowledge_nodes (id,document_id,external_id,parent_external_id,node_type,ordinal,text_content,metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        randomUUID(),
        documentId,
        node.externalId,
        node.parentExternalId ?? null,
        node.type,
        node.ordinal,
        node.text,
        JSON.stringify(node.metadata ?? {})
      ]
    );
  }
  const liveHashes: string[] = [];
  for (const chunk of input.chunks) {
    liveHashes.push(chunk.contentHash);
    const result = await db.query(
      `insert into knowledge_chunks (id,document_id,heading_path,section_key,ordinal,content,content_hash,metadata,active)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
       on conflict (document_id,content_hash) do update set heading_path=excluded.heading_path,
       section_key=excluded.section_key, ordinal=excluded.ordinal, content=excluded.content,
       metadata=excluded.metadata, active=true returning *`,
      [
        randomUUID(),
        documentId,
        chunk.headingPath,
        knowledgeSectionKey(chunk.headingPath),
        chunk.ordinal,
        chunk.content,
        chunk.contentHash,
        JSON.stringify(chunk.metadata ?? {})
      ]
    );
    const chunkId = requiredString(result.rows[0]?.id);
    chunkIds.set(`${input.externalId}:${chunk.contentHash}`, chunkId);
  }
  await db.query(
    "update knowledge_chunks set active=false where document_id=$1 and not (content_hash = any($2::text[]))",
    [documentId, liveHashes]
  );
  return documentId;
}

function validateSnapshotEmbedding(input: { dimensions: number; embedding: number[] }): void {
  if (
    input.dimensions <= 0 ||
    input.embedding.length !== input.dimensions ||
    input.embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("knowledge_embedding_invalid");
  }
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
function iso(value: unknown): string | undefined {
  return value ? new Date(value as string).toISOString() : undefined;
}
function mapSource(row: Record<string, unknown>): KnowledgeSourceRecord {
  const id = requiredUuid(row.id);
  const live = normalizeKnowledgeSourceRoutingFields({
    sourceKey: requiredString(row.source_key),
    displayName: requiredString(row.display_name),
    aliases: stringArray(row.admin_aliases),
    topics: stringArray(row.admin_topics),
    sampleQueries: stringArray(row.admin_sample_queries)
  });
  const routingDisplayName = optionalString(row.routing_display_name);
  const promoted = routingDisplayName
    ? normalizeKnowledgeSourceRoutingFields({
        sourceKey: live.sourceKey,
        displayName: routingDisplayName,
        aliases: stringArray(row.aliases),
        topics: stringArray(row.topics),
        sampleQueries: stringArray(row.sample_queries)
      })
    : undefined;
  return {
    id,
    profileName: requiredString(row.profile_name),
    sourceKey: live.sourceKey,
    displayName: live.displayName,
    stagedDisplayName: optionalString(row.staged_display_name) ?? live.displayName,
    stagedAdapterType: "notion",
    stagedExternalRootId:
      optionalString(row.staged_external_root_id) ?? requiredString(row.external_root_id),
    stagedRootUrl: optionalString(row.staged_root_url) ?? requiredString(row.root_url),
    stagedEnabled:
      row.staged_enabled === undefined ? Boolean(row.enabled) : Boolean(row.staged_enabled),
    stagedExpiresAt: iso(row.staged_expires_at),
    stagingRevision: optionalUuid(row.staging_revision) ?? id,
    adminAliases: live.aliases,
    adminTopics: live.topics,
    adminSampleQueries: live.sampleQueries,
    routingDisplayName: promoted?.displayName,
    aliases: promoted?.aliases ?? [],
    topics: promoted?.topics ?? [],
    sampleQueries: promoted?.sampleQueries ?? [],
    adapterType: "notion",
    externalRootId: requiredString(row.external_root_id),
    rootUrl: requiredString(row.root_url),
    enabled: Boolean(row.enabled),
    expiresAt: iso(row.expires_at),
    disabledAt: iso(row.disabled_at),
    purgeAfter: iso(row.purge_after),
    lastSyncedAt: iso(row.last_synced_at),
    syncStatus: row.sync_status as KnowledgeSourceRecord["syncStatus"],
    syncErrorCode: row.sync_error_code ? String(row.sync_error_code) : undefined
  };
}
function safeMapSource(row: Record<string, unknown>): KnowledgeSourceRecord | undefined {
  try {
    return mapSource(row);
  } catch {
    return undefined;
  }
}
function requiredSource(row: Record<string, unknown> | undefined): KnowledgeSourceRecord {
  if (!row) throw new Error("knowledge_source_write_failed");
  const source = safeMapSource(row);
  if (!source) throw new Error("knowledge_source_row_invalid");
  return source;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("knowledge_identity_invalid");
  return value;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function requiredUuid(value: unknown): string {
  const candidate = requiredString(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
  ) {
    throw new Error("knowledge_identity_invalid");
  }
  return candidate;
}
function optionalUuid(value: unknown): string | undefined {
  try {
    return value === undefined || value === null ? undefined : requiredUuid(value);
  } catch {
    return undefined;
  }
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function mapChunk(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    headingPath: (row.heading_path as string[]) ?? [],
    sectionKey: requiredString(row.section_key),
    ordinal: Number(row.ordinal),
    content: String(row.content),
    contentHash: String(row.content_hash),
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}
function mapSearchResult(row: Record<string, unknown>): KnowledgeSearchResult {
  return {
    ...mapChunk(row),
    score: Number(row.score),
    document: {
      id: String(row.document_id),
      externalId: String(row.external_id),
      title: String(row.title),
      url: String(row.url)
    },
    source: mapSource(row)
  };
}
