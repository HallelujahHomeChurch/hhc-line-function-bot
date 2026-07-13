import type { KnowledgeNodeInput, KnowledgeSourceRecord, KnowledgeStore } from "./store.js";

export interface KnowledgeRoutingMetadata {
  sourceKey: string;
  displayName: string;
  aliases: string[];
  topics: string[];
  sampleQueries: string[];
}

export interface DerivedKnowledgeRoutingMetadata {
  displayName: string;
  aliases: string[];
  topics: string[];
  sampleQueries: string[];
}

export interface KnowledgeMetadataDocument {
  title: string;
  nodes?: Array<Pick<KnowledgeNodeInput, "type" | "text">>;
  chunks?: Array<{ headingPath: string[] }>;
}

export const KNOWLEDGE_ROUTING_LIMITS = {
  sources: 20,
  itemsPerField: 20,
  itemCharacters: 100,
  totalCharacters: 6_200
} as const;

const UNSAFE_METADATA_PATTERNS = [
  /(?:https?:\/\/|www\.)/iu,
  /\bBearer\s+\S+/iu,
  /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[bp]-)[A-Za-z0-9_-]{8,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu
];

export function deriveKnowledgeRoutingMetadata(
  displayName: string,
  documents: readonly KnowledgeMetadataDocument[]
): DerivedKnowledgeRoutingMetadata {
  const titles = documents.map(({ title }) => title);
  const headings = documents.flatMap((document) => [
    ...(document.nodes ?? [])
      .filter(({ type }) => /^heading_[1-3]$/u.test(type))
      .map(({ text }) => text),
    ...(document.chunks ?? []).flatMap(({ headingPath }) => headingPath)
  ]);
  const aliases = [displayName, ...titles].flatMap(titleVariants);
  return normalizeKnowledgeRoutingMetadata({
    sourceKey: "derived",
    displayName,
    aliases,
    topics: [...titles, ...headings],
    sampleQueries: []
  });
}

export function normalizeKnowledgeRoutingMetadata(
  input: KnowledgeRoutingMetadata
): KnowledgeRoutingMetadata {
  const budget = { remaining: KNOWLEDGE_ROUTING_LIMITS.totalCharacters };
  const sourceKey = boundedText(input.sourceKey, budget);
  const displayName = boundedText(input.displayName, budget);
  if (!sourceKey || !displayName) throw new Error("knowledge_routing_metadata_invalid");
  return {
    sourceKey,
    displayName,
    aliases: boundedList(input.aliases, budget, [displayName]),
    topics: boundedList(input.topics, budget),
    sampleQueries: boundedList(input.sampleQueries, budget)
  };
}

export function normalizeKnowledgeSourceRoutingFields(input: {
  sourceKey: string;
  displayName: string;
  aliases?: readonly string[];
  topics?: readonly string[];
  sampleQueries?: readonly string[];
}): KnowledgeRoutingMetadata {
  return normalizeKnowledgeRoutingMetadata({
    sourceKey: input.sourceKey,
    displayName: input.displayName,
    aliases: [...(input.aliases ?? [])],
    topics: [...(input.topics ?? [])],
    sampleQueries: [...(input.sampleQueries ?? [])]
  });
}

export async function listKnowledgeRoutingMetadata(
  store: KnowledgeStore,
  profileName: string,
  limit: number
): Promise<KnowledgeRoutingMetadata[]> {
  const boundedLimit = Math.max(
    0,
    Math.min(KNOWLEDGE_ROUTING_LIMITS.sources, Math.floor(Number.isFinite(limit) ? limit : 0))
  );
  if (!boundedLimit) return [];
  const sources = await store.listSources({ profileName, includeDisabled: false });
  return sources
    .filter(lastKnownGoodSource)
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
    .flatMap((source) => {
      try {
        return [sourceRoutingMetadata(source)];
      } catch {
        return [];
      }
    })
    .slice(0, boundedLimit);
}

export function matchingKnowledgeRoutingMetadata(
  text: string,
  sources: readonly KnowledgeRoutingMetadata[]
): KnowledgeRoutingMetadata[] {
  const result = resolveKnowledgeRoutingMetadata(text, sources);
  return result.status === "unique" ? [result.source] : [];
}

export type KnowledgeRoutingMatch =
  | { status: "none" }
  | { status: "unique"; source: KnowledgeRoutingMetadata }
  | { status: "ambiguous"; sources: KnowledgeRoutingMetadata[] };

export function resolveKnowledgeRoutingMetadata(
  text: string,
  sources: readonly KnowledgeRoutingMetadata[]
): KnowledgeRoutingMatch {
  const normalizedText = comparable(text);
  if (!normalizedText) return { status: "none" };
  const matches = sources.filter((source) => matchesRoutingSource(text, normalizedText, source));
  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1) return { status: "unique", source: matches[0]! };
  return { status: "ambiguous", sources: matches };
}

function sourceRoutingMetadata(source: KnowledgeSourceRecord): KnowledgeRoutingMetadata {
  if (!source.routingDisplayName) throw new Error("knowledge_routing_snapshot_missing");
  return normalizeKnowledgeSourceRoutingFields({
    sourceKey: source.sourceKey,
    displayName: source.routingDisplayName,
    aliases: source.aliases,
    topics: source.topics,
    sampleQueries: source.sampleQueries
  });
}

function lastKnownGoodSource(source: KnowledgeSourceRecord): boolean {
  return Boolean(source.enabled && source.lastSyncedAt && source.routingDisplayName);
}

function matchesRoutingSource(
  rawText: string,
  normalizedText: string,
  source: KnowledgeRoutingMetadata
): boolean {
  const normalizedSourceKey = comparable(source.sourceKey);
  if (normalizedText === normalizedSourceKey) return true;
  if (containsContiguousTokens(latinTokens(rawText), latinTokens(source.sourceKey))) {
    return false;
  }
  return [source.displayName, ...source.aliases, ...source.topics, ...source.sampleQueries].some(
    (term) => matchesConservativeTerm(rawText, normalizedText, term)
  );
}

function matchesConservativeTerm(rawText: string, normalizedText: string, term: string): boolean {
  const normalizedTerm = comparable(term);
  if (!normalizedTerm || !longEnough(normalizedTerm)) return false;
  if (/^[a-z0-9]+$/u.test(normalizedTerm)) {
    const textTokens = latinTokens(rawText);
    const termTokens = latinTokens(term);
    if (termTokens.length > 1) return containsContiguousTokens(textTokens, termTokens);
    return textTokens.some((token) => token === normalizedTerm);
  }
  return normalizedText.includes(normalizedTerm);
}

function longEnough(term: string): boolean {
  const length = Array.from(term).length;
  return /^[a-z0-9]+$/u.test(term) ? length >= 3 : length >= 2;
}

function latinTokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
}

function containsContiguousTokens(text: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > text.length) return false;
  return text.some((_, offset) => phrase.every((token, index) => text[offset + index] === token));
}

function titleVariants(value: string): string[] {
  const normalized = safeText(value);
  if (!normalized) return [];
  const withoutYear = normalized.replace(/^\d{4}(?:\s*[-–—年]\s*|\s+)/u, "").trim();
  return withoutYear && comparable(withoutYear) !== comparable(normalized)
    ? [normalized, withoutYear]
    : [normalized];
}

function boundedList(
  values: readonly string[],
  budget: { remaining: number },
  omit: string[] = []
) {
  const seen = new Set(omit.map(comparable));
  const output: string[] = [];
  for (const value of values) {
    if (output.length >= KNOWLEDGE_ROUTING_LIMITS.itemsPerField || budget.remaining <= 0) break;
    const normalized = safeText(value);
    if (!normalized) continue;
    const key = comparable(normalized);
    if (!key || seen.has(key)) continue;
    const bounded = Array.from(normalized)
      .slice(0, Math.min(KNOWLEDGE_ROUTING_LIMITS.itemCharacters, budget.remaining))
      .join("");
    if (!bounded) break;
    seen.add(comparable(bounded));
    output.push(bounded);
    budget.remaining -= Array.from(bounded).length;
  }
  return output;
}

function boundedText(value: string, budget: { remaining: number }): string {
  const normalized = safeText(value);
  if (!normalized || budget.remaining <= 0) return "";
  const bounded = Array.from(normalized)
    .slice(0, Math.min(KNOWLEDGE_ROUTING_LIMITS.itemCharacters, budget.remaining))
    .join("");
  budget.remaining -= Array.from(bounded).length;
  return bounded;
}

function safeText(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"))
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim()
    .replace(/\s+/gu, " ");
  return UNSAFE_METADATA_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(normalized);
  })
    ? ""
    : normalized;
}

function comparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}
