import type { ActiveTaskContext } from "./active-task.js";
import {
  FUNCTION_DEFINITIONS,
  type AgentCapabilityContract,
  type FunctionAllowedSource,
  type FunctionDefinition
} from "../functions/definitions.js";
import type { FunctionName } from "../types.js";
import {
  resolveKnowledgeRoutingMetadata,
  type KnowledgeRoutingMetadata
} from "../knowledge/routing-metadata.js";

export interface KnowledgeSourceMetadata extends Omit<KnowledgeRoutingMetadata, "sampleQueries"> {
  sampleQueries?: string[];
}

export type CapabilityCandidateReason =
  | "explicit_intent"
  | "active_task_entity"
  | "knowledge_metadata"
  | "retrieval_evidence"
  | "capability_hint";

export interface CapabilityCandidate {
  capability: FunctionName;
  contract: AgentCapabilityContract;
  reason: CapabilityCandidateReason;
  score: number;
}

export interface BuildCapabilityCandidatesInput {
  text: string;
  enabledFunctions: readonly FunctionName[];
  activeTask?: ActiveTaskContext;
  knowledgeSources: readonly KnowledgeSourceMetadata[];
  retrievalEvidence?: readonly FunctionName[];
  maxCandidates: number;
  source: FunctionAllowedSource;
}

type CandidateSourceIsRequired =
  Pick<BuildCapabilityCandidatesInput, "source"> extends Required<
    Pick<BuildCapabilityCandidatesInput, "source">
  >
    ? true
    : never;
// Keep `source` required at compile time in addition to the runtime fail-closed guard.
const CANDIDATE_SOURCE_IS_REQUIRED: CandidateSourceIsRequired = true;

interface RankedCandidate extends CapabilityCandidate {
  definitionOrder: number;
}

const REASON_SCORE: Record<CapabilityCandidateReason, number> = {
  explicit_intent: 400,
  active_task_entity: 300,
  knowledge_metadata: 200,
  retrieval_evidence: 150,
  capability_hint: 100
};

const METADATA_LIMITS = {
  sources: 20,
  aliasesPerSource: 20,
  topicsPerSource: 20,
  sampleQueriesPerSource: 20,
  termCharacters: 100
} as const;

export function buildCapabilityCandidates(
  input: BuildCapabilityCandidatesInput
): CapabilityCandidate[] {
  const limit = candidateLimit(input.maxCandidates);
  if (!CANDIDATE_SOURCE_IS_REQUIRED || !input.source || limit === 0 || !normalize(input.text)) {
    return [];
  }

  const enabled = new Set(input.enabledFunctions);
  const ranked: RankedCandidate[] = [];

  for (const [definitionOrder, definition] of FUNCTION_DEFINITIONS.entries()) {
    if (!isEligibleDefinition(definition, enabled, input.source)) continue;
    const reason = strongestReason(definition, input);
    if (!reason) continue;
    ranked.push({
      capability: definition.name,
      contract: cloneContract(definition.agentCapability!),
      reason,
      score: REASON_SCORE[reason],
      definitionOrder
    });
  }

  return ranked
    .sort((left, right) => right.score - left.score || left.definitionOrder - right.definitionOrder)
    .slice(0, limit)
    .map(({ capability, contract, reason, score }) => ({ capability, contract, reason, score }));
}

function isEligibleDefinition(
  definition: FunctionDefinition,
  enabled: ReadonlySet<FunctionName>,
  source: FunctionAllowedSource
): boolean {
  return (
    enabled.has(definition.name) &&
    definition.sideEffectLevel === "read" &&
    !definition.deprecated &&
    Boolean(definition.agentCapability) &&
    definition.allowedSources.includes(source)
  );
}

function strongestReason(
  definition: FunctionDefinition,
  input: BuildCapabilityCandidatesInput
): CapabilityCandidateReason | undefined {
  const contract = definition.agentCapability!;
  if (matchesAnyExact(input.text, contract.intents)) return "explicit_intent";
  if (
    !hasWriteIntent(input.text) &&
    matchesActiveTaskEntity(definition, input.text, input.activeTask)
  ) {
    return "active_task_entity";
  }
  if (
    definition.requires.includes("knowledge") &&
    matchesKnowledgeMetadata(input.text, input.knowledgeSources)
  ) {
    return "knowledge_metadata";
  }
  if (!hasWriteIntent(input.text) && input.retrievalEvidence?.includes(definition.name)) {
    return "retrieval_evidence";
  }
  if (matchesAnyHint(input.text, contract.candidateHints)) return "capability_hint";
  return undefined;
}

function matchesActiveTaskEntity(
  definition: FunctionDefinition,
  text: string,
  activeTask: ActiveTaskContext | undefined
): boolean {
  const contract = definition.agentCapability;
  if (!activeTask || !contract || activeTask.capability !== definition.name) return false;
  if (
    !contract.operations?.some((operation) => activeTask.supportedOperations.includes(operation))
  ) {
    return false;
  }
  const entityTypes = new Set(contract.entityTypes ?? []);
  return activeTask.entities.some(
    (entity) =>
      entityTypes.has(entity.type) &&
      matchesAnyExact(text, [entity.key, entity.label, ...(entity.aliases ?? [])])
  );
}

function matchesKnowledgeMetadata(
  text: string,
  sources: readonly KnowledgeSourceMetadata[]
): boolean {
  const boundedSources = sources.slice(0, METADATA_LIMITS.sources).map((source) => ({
    sourceKey: boundedTerm(source.sourceKey),
    displayName: boundedTerm(source.displayName),
    aliases: source.aliases
      .slice(0, METADATA_LIMITS.aliasesPerSource)
      .map((alias) => boundedTerm(alias)),
    topics: source.topics
      .slice(0, METADATA_LIMITS.topicsPerSource)
      .map((topic) => boundedTerm(topic)),
    sampleQueries: (source.sampleQueries ?? [])
      .slice(0, METADATA_LIMITS.sampleQueriesPerSource)
      .map((query) => boundedTerm(query))
  }));
  return resolveKnowledgeRoutingMetadata(text, boundedSources).status !== "none";
}

function boundedTerm(value: string): string {
  return Array.from(value).slice(0, METADATA_LIMITS.termCharacters).join("");
}

function matchesAnyExact(text: string, terms: readonly string[]): boolean {
  const normalizedText = normalize(text);
  return terms.some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length > 0 && normalizedText.includes(normalizedTerm);
  });
}

function matchesAnyHint(text: string, hints: readonly string[]): boolean {
  const normalizedText = normalize(text);
  return hints.some((hint) => {
    const normalizedHint = normalize(hint);
    if (!normalizedHint) return false;
    if (Array.from(normalizedHint).length <= 3) {
      return matchesShortHint(text, normalizedText, normalizedHint);
    }
    if (normalizedText.includes(normalizedHint)) return true;
    return oneEditWindowMatch(normalizedText, normalizedHint);
  });
}

function matchesShortHint(text: string, normalizedText: string, hint: string): boolean {
  const hintCharacters = Array.from(hint);
  if (/^[a-z0-9]+$/u.test(hint)) {
    return latinWordTokens(text).some((token) => {
      const tokenCharacters = Array.from(token);
      return (
        tokenCharacters.length === hintCharacters.length &&
        editDistanceAtMostOne(tokenCharacters, hintCharacters)
      );
    });
  }
  if (normalizedText.includes(hint)) return true;
  if (hintCharacters.length < 3) return false;
  return sameLengthWindowMatch(normalizedText, hintCharacters);
}

function latinWordTokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
}

function sameLengthWindowMatch(text: string, hint: string[]): boolean {
  const textCharacters = Array.from(text);
  if (hint.length > textCharacters.length) return false;
  for (let start = 0; start <= textCharacters.length - hint.length; start += 1) {
    if (editDistanceAtMostOne(textCharacters.slice(start, start + hint.length), hint)) {
      return true;
    }
  }
  return false;
}

function oneEditWindowMatch(text: string, hint: string): boolean {
  const textCharacters = Array.from(text);
  const hintCharacters = Array.from(hint);
  if (hintCharacters.length < 3 || hintCharacters.length > 24) return false;
  for (const length of [
    hintCharacters.length - 1,
    hintCharacters.length,
    hintCharacters.length + 1
  ]) {
    if (length < 1 || length > textCharacters.length) continue;
    for (let start = 0; start <= textCharacters.length - length; start += 1) {
      if (editDistanceAtMostOne(textCharacters.slice(start, start + length), hintCharacters)) {
        return true;
      }
    }
  }
  return false;
}

function editDistanceAtMostOne(left: string[], right: string[]): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

export function hasWriteIntent(text: string): boolean {
  const normalized = normalize(text).replace(/^小哈/u, "");
  const writeAction = "記住|保存|儲存|存下|新增|修改|更新|刪除|移除|上傳|建立";
  return (
    new RegExp(`^(?:請|我要|要)?(?:幫我|替我)?(?:${writeAction})`, "u").test(normalized) ||
    new RegExp(`(?:幫我|替我)(?:${writeAction})`, "u").test(normalized)
  );
}

export function retrievalEvidenceRequests(input: {
  text: string;
  enabledFunctions: readonly FunctionName[];
  source: FunctionAllowedSource;
}): Array<{ capability: FunctionName; provider: string }> {
  if (!isConservativeRetrievalEvidenceText(input.text)) return [];
  const enabled = new Set(input.enabledFunctions);
  return FUNCTION_DEFINITIONS.flatMap((definition) => {
    if (!isEligibleDefinition(definition, enabled, input.source)) return [];
    const provider = definition.agentCapability?.retrievalEvidence?.provider.trim();
    return provider ? [{ capability: definition.name, provider }] : [];
  });
}

export function isConservativeRetrievalEvidenceText(text: string): boolean {
  if (hasWriteIntent(text)) return false;
  const normalized = normalize(text).replace(/^小哈/u, "");
  if (Array.from(normalized).length < 2) return false;
  return !new Set([
    "你好",
    "哈囉",
    "嗨",
    "早安",
    "午安",
    "晚安",
    "謝謝",
    "感謝",
    "再見",
    "掰掰",
    "hello",
    "hi",
    "hey",
    "thanks",
    "thankyou",
    "bye"
  ]).has(normalized);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function candidateLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cloneContract(contract: AgentCapabilityContract): AgentCapabilityContract {
  return {
    intents: [...contract.intents],
    candidateHints: [...contract.candidateHints],
    ...(contract.entityTypes ? { entityTypes: [...contract.entityTypes] } : {}),
    ...(contract.refinableFields ? { refinableFields: [...contract.refinableFields] } : {}),
    ...(contract.operations ? { operations: [...contract.operations] } : {}),
    ...(contract.retrievalEvidence
      ? { retrievalEvidence: { provider: contract.retrievalEvidence.provider } }
      : {}),
    ...(contract.ambiguity ? { ambiguity: contract.ambiguity } : {}),
    ...(contract.activeEvidence
      ? {
          activeEvidence: {
            ...(contract.activeEvidence.arguments
              ? { arguments: cloneEvidenceRules(contract.activeEvidence.arguments) }
              : {}),
            ...(contract.activeEvidence.references
              ? { references: cloneEvidenceRules(contract.activeEvidence.references) }
              : {})
          }
        }
      : {})
  };
}

function cloneEvidenceRules(
  rules: NonNullable<AgentCapabilityContract["activeEvidence"]>["arguments"]
) {
  return Object.fromEntries(
    Object.entries(rules ?? {}).map(([key, rule]) => [
      key,
      {
        ...(rule.entityTypes ? { entityTypes: [...rule.entityTypes] } : {}),
        ...(rule.anchorKeys ? { anchorKeys: [...rule.anchorKeys] } : {}),
        ...(rule.referenceKeys ? { referenceKeys: [...rule.referenceKeys] } : {})
      }
    ])
  );
}
