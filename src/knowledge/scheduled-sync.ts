import type { EmbeddingClient } from "../clients/ollama-embedding.js";
import type { NotionKnowledgeClient } from "../clients/notion-knowledge.js";
import { markKnowledgeSyncFailure, syncKnowledgeSource } from "./sync-service.js";
import type { KnowledgeSourceRecord, KnowledgeStore } from "./store.js";

export interface ScheduledKnowledgeSyncResult {
  sources: number;
  synced: number;
  failed: number;
  stale: number;
  documents: number;
  chunks: number;
  embedded: number;
}

export async function syncScheduledKnowledgeSources(input: {
  sources: KnowledgeSourceRecord[];
  store: KnowledgeStore;
  notion: NotionKnowledgeClient;
  embedding?: EmbeddingClient;
  batchSize?: number;
}): Promise<ScheduledKnowledgeSyncResult> {
  const result: ScheduledKnowledgeSyncResult = {
    sources: input.sources.length,
    synced: 0,
    failed: 0,
    stale: 0,
    documents: 0,
    chunks: 0,
    embedded: 0
  };
  for (const source of input.sources) {
    try {
      const synced = await syncKnowledgeSource({
        source,
        store: input.store,
        notion: input.notion,
        embedding: input.embedding,
        batchSize: input.batchSize
      });
      result.synced += 1;
      result.documents += synced.documents;
      result.chunks += synced.chunks;
      result.embedded += synced.embedded;
    } catch {
      const outcome = await markKnowledgeSyncFailure({
        source,
        store: input.store,
        syncErrorCode: "scheduled_sync_failed"
      });
      if (outcome === "stale") result.stale += 1;
      else result.failed += 1;
    }
  }
  return result;
}
