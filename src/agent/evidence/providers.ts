import type { AgentMemoryStore, AgentScheduleEntryRecord } from "../memory-store.js";
import { normalizeLookupText } from "../memory-store.js";
import type { CatalogStore } from "../../catalog/store.js";
import type { AgentResourceType, LineSource } from "../../types.js";
import type { AgentEvidenceProvider, AgentEvidenceProbeInput } from "./types.js";

const MAX_EVIDENCE_RESULTS = 20;

export function createCatalogEvidenceProvider(
  catalog: CatalogStore,
  filter: { domains?: string[]; itemKinds?: string[] }
): AgentEvidenceProvider {
  return {
    async probe(input) {
      const limit = boundedLimit(input.maxResults);
      if (limit === 0 || !normalizeLookupText(input.text)) return emptyEvidence();
      const records = await catalog.searchItems({
        profileName: input.profileName,
        query: input.text,
        domains: filter.domains,
        itemKinds: filter.itemKinds,
        limit
      });
      return opaqueEvidence(
        records.map(({ id }) => id),
        limit
      );
    }
  };
}

export function createMemoryEvidenceProvider(memory: AgentMemoryStore): AgentEvidenceProvider {
  return {
    async probe(input) {
      const limit = boundedLimit(input.maxResults);
      const source = scopedLineSource(input);
      if (limit === 0 || !source || !normalizeLookupText(input.text)) return emptyEvidence();
      const records = await memory.searchTextMemories({
        profileName: input.profileName,
        source,
        requesterUserId: input.requesterUserId,
        query: input.text,
        limit
      });
      return opaqueEvidence(
        records.map(({ id }) => id),
        limit
      );
    }
  };
}

export function createResourceMemoryEvidenceProvider(
  memory: AgentMemoryStore,
  resourceTypes: AgentResourceType[]
): AgentEvidenceProvider {
  return {
    async probe(input) {
      const limit = boundedLimit(input.maxResults);
      const source = scopedLineSource(input);
      if (limit === 0 || !source || !normalizeLookupText(input.text)) return emptyEvidence();
      const records = await memory.searchResources({
        profileName: input.profileName,
        source,
        requesterUserId: input.requesterUserId,
        query: input.text,
        resourceTypes,
        limit
      });
      return opaqueEvidence(
        records.map(({ id }) => id),
        limit
      );
    }
  };
}

export function createCombinedEvidenceProvider(
  ...providers: AgentEvidenceProvider[]
): AgentEvidenceProvider {
  return {
    async probe(input) {
      const limit = boundedLimit(input.maxResults);
      const results = await Promise.all(providers.map((provider) => provider.probe(input)));
      return opaqueEvidence([...new Set(results.flatMap(({ opaqueIds }) => opaqueIds))], limit);
    }
  };
}

export function createScheduleEvidenceProvider(memory: AgentMemoryStore): AgentEvidenceProvider {
  return {
    async probe(input) {
      const limit = boundedLimit(input.maxResults);
      const source = scopedLineSource(input);
      if (limit === 0 || !source || !normalizeLookupText(input.text)) return emptyEvidence();
      const direct = await memory.searchScheduleEntries({
        profileName: input.profileName,
        source,
        requesterUserId: input.requesterUserId,
        query: input.text,
        limit
      });
      if (direct.length > 0)
        return opaqueEvidence(
          direct.map(({ id }) => id),
          limit
        );

      // Date punctuation and conversational words frequently differ from stored ISO dates.
      // A bounded local comparison provides evidence only; actual execution still performs
      // authoritative argument extraction, policy validation, and handler-side filtering.
      const candidates = await memory.searchScheduleEntries({
        profileName: input.profileName,
        source,
        requesterUserId: input.requesterUserId,
        limit: MAX_EVIDENCE_RESULTS
      });
      const tokens = evidenceTokens(input.text);
      const matched = candidates.filter((record) => scheduleMatchesTokens(record, tokens));
      return opaqueEvidence(
        matched.map(({ id }) => id),
        limit
      );
    }
  };
}

function scopedLineSource(input: AgentEvidenceProbeInput): LineSource | undefined {
  if (!input.sourceId) return undefined;
  if (input.source === "group") {
    return { type: "group", groupId: input.sourceId, userId: input.requesterUserId };
  }
  return { type: "user", userId: input.requesterUserId ?? input.sourceId };
}

function boundedLimit(value: number): number {
  return Math.max(0, Math.min(MAX_EVIDENCE_RESULTS, Math.floor(value)));
}

function opaqueEvidence(ids: readonly string[], limit: number) {
  const opaqueIds = ids.slice(0, limit);
  return { matched: opaqueIds.length > 0, count: opaqueIds.length, opaqueIds };
}

function emptyEvidence() {
  return { matched: false, count: 0, opaqueIds: [] };
}

function evidenceTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const words = normalized.match(/[\p{Script=Han}a-z]+|\d+/gu) ?? [];
  const ignored = new Set(["幫我", "請", "查", "找", "搜尋", "給我", "的", "是", "誰", "什麼"]);
  return words.map(normalizeLookupText).filter((word) => word && !ignored.has(word));
}

function scheduleMatchesTokens(
  record: AgentScheduleEntryRecord,
  tokens: readonly string[]
): boolean {
  if (tokens.length === 0) return false;
  const text = normalizeLookupText(
    [
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
      .join(" ")
  );
  return tokens.every((token) => text.includes(token));
}
