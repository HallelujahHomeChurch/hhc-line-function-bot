import { isConservativeKnowledgeEvidenceText } from "../agent/knowledge-evidence-guard.js";
import type { RetrievalEvidenceProvider } from "../agent/controlled-agent-router.js";
import { listKnowledgeRoutingMetadata } from "./routing-metadata.js";
import type { KnowledgeStore } from "./store.js";

const MAX_ELIGIBLE_SOURCES = 20;

export function createKnowledgeRetrievalEvidenceProvider(
  store: KnowledgeStore
): RetrievalEvidenceProvider {
  return {
    async probe(input) {
      if (!isConservativeKnowledgeEvidenceText(input.text)) {
        return { matched: false, count: 0, opaqueIds: [] };
      }
      const limit = Math.max(0, Math.min(MAX_ELIGIBLE_SOURCES, Math.floor(input.maxResults)));
      if (limit === 0) return { matched: false, count: 0, opaqueIds: [] };
      const [metadata, activeSources] = await Promise.all([
        listKnowledgeRoutingMetadata(store, input.profileName, limit),
        store.listSources({ profileName: input.profileName, includeDisabled: false })
      ]);
      const sourceIds = metadata.flatMap((item) => {
        const source = activeSources.find(({ sourceKey }) => sourceKey === item.sourceKey);
        return source ? [source.id] : [];
      });
      if (sourceIds.length === 0) return { matched: false, count: 0, opaqueIds: [] };
      const matches = await store.searchTopPerSource({
        profileName: input.profileName,
        query: input.text,
        sourceIds
      });
      return {
        matched: matches.length > 0,
        count: Math.min(matches.length, limit),
        opaqueIds: matches.slice(0, limit).map(({ source }) => source.id)
      };
    }
  };
}
