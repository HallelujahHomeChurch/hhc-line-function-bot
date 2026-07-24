import type { EmbeddingClient } from "../clients/embedding.js";
import type { NotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { chunkKnowledgeNodes } from "./chunker.js";
import { deriveKnowledgeRoutingMetadata } from "./routing-metadata.js";
import type { KnowledgeSourceRecord, KnowledgeStore } from "./store.js";

export interface KnowledgeSyncResult {
  documents: number;
  chunks: number;
  embedded: number;
  status: "ready" | "embedding_pending";
}

export async function markKnowledgeSyncFailure(input: {
  source: KnowledgeSourceRecord;
  store: KnowledgeStore;
  syncErrorCode: string;
}) {
  return input.store.markSourceSyncFailed({
    profileName: input.source.profileName,
    sourceKey: input.source.sourceKey,
    expectedStagingRevision: input.source.stagingRevision,
    syncErrorCode: input.syncErrorCode
  });
}

export async function syncKnowledgeSource(input: {
  source: KnowledgeSourceRecord;
  store: KnowledgeStore;
  notion: NotionKnowledgeClient;
  embedding?: EmbeddingClient;
  batchSize?: number;
  now?: () => Date;
}): Promise<KnowledgeSyncResult> {
  const now = input.now ?? (() => new Date());
  const documents = await input.notion.fetchRoot(input.source.stagedExternalRootId);
  const preparedDocuments = documents.map((document) => ({
    externalId: document.externalId,
    title: document.title,
    url: document.url,
    properties: document.properties,
    nodes: document.nodes,
    chunks: chunkKnowledgeNodes(document.nodes)
  }));
  const derivedMetadata = deriveKnowledgeRoutingMetadata(input.source.stagedDisplayName, documents);
  const preparedChunks = preparedDocuments.flatMap((document) =>
    document.chunks.map((chunk) => ({ documentExternalId: document.externalId, chunk }))
  );

  let embedded = 0;
  let status: KnowledgeSyncResult["status"] = "ready";
  const embeddings = [];
  if (input.embedding) {
    const batchSize = input.batchSize ?? 16;
    try {
      for (let offset = 0; offset < preparedChunks.length; offset += batchSize) {
        const batch = preparedChunks.slice(offset, offset + batchSize);
        const vectors = await input.embedding.embed(batch.map(({ chunk }) => chunk.content));
        for (let index = 0; index < batch.length; index += 1) {
          const prepared = batch[index]!;
          embeddings.push({
            documentExternalId: prepared.documentExternalId,
            contentHash: prepared.chunk.contentHash,
            provider: input.embedding.provider,
            model: input.embedding.model,
            dimensions: input.embedding.dimensions,
            embedding: vectors[index]!
          });
          embedded += 1;
        }
      }
    } catch {
      status = "embedding_pending";
      embeddings.length = 0;
      embedded = 0;
    }
  }
  await input.store.publishSourceSnapshot({
    sourceId: input.source.id,
    expectedStagingRevision: input.source.stagingRevision,
    syncedAt: now().toISOString(),
    syncStatus: status,
    routingDisplayName: input.source.stagedDisplayName,
    aliases: [...input.source.adminAliases, ...derivedMetadata.aliases],
    topics: [...input.source.adminTopics, ...derivedMetadata.topics],
    sampleQueries: input.source.adminSampleQueries,
    documents: preparedDocuments,
    embeddings
  });
  return { documents: documents.length, chunks: preparedChunks.length, embedded, status };
}
