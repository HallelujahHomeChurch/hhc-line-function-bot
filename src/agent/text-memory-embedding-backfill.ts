import type { EmbeddingClient } from "../clients/embedding.js";
import type { AgentMemoryStore } from "./memory-store.js";

export interface AgentTextMemoryEmbeddingBackfillResult {
  scanned: number;
  updated: number;
  failed: number;
}

export async function backfillAgentTextMemoryEmbeddings(input: {
  store: AgentMemoryStore;
  embedding: EmbeddingClient;
  batchSize: number;
}): Promise<AgentTextMemoryEmbeddingBackfillResult> {
  const candidates = await input.store.listTextMemoriesMissingEmbedding(
    Math.max(1, Math.min(input.batchSize, 100))
  );
  if (candidates.length === 0) return { scanned: 0, updated: 0, failed: 0 };

  let vectors: number[][];
  try {
    vectors = await input.embedding.embed(
      candidates.map(({ title, content }) => `${title ?? "已保存資訊"}\n${content}`)
    );
  } catch {
    return { scanned: candidates.length, updated: 0, failed: candidates.length };
  }

  let updated = 0;
  for (const [index, candidate] of candidates.entries()) {
    const vector = vectors[index];
    if (!vector?.length) continue;
    try {
      if (await input.store.updateTextMemoryEmbedding(candidate.id, vector)) updated += 1;
    } catch {
      // Continue the bounded batch without exposing memory content.
    }
  }
  return { scanned: candidates.length, updated, failed: candidates.length - updated };
}
