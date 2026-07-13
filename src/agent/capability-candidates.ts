import type { ActiveTaskContext } from "./active-task.js";
import {
  FUNCTION_DEFINITIONS,
  type AgentCapabilityContract,
  type FunctionAllowedSource,
  type FunctionDefinition
} from "../functions/definitions.js";
import type { FunctionName } from "../types.js";

export interface KnowledgeSourceMetadata {
  sourceKey: string;
  displayName: string;
  aliases: string[];
  topics: string[];
}

export type CapabilityCandidateReason =
  "explicit_intent" | "active_task_entity" | "knowledge_metadata" | "capability_hint";

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
  maxCandidates: number;
  source?: FunctionAllowedSource;
}

interface RankedCandidate extends CapabilityCandidate {
  definitionOrder: number;
}

const REASON_SCORE: Record<CapabilityCandidateReason, number> = {
  explicit_intent: 400,
  active_task_entity: 300,
  knowledge_metadata: 200,
  capability_hint: 100
};

const METADATA_LIMITS = {
  sources: 20,
  aliasesPerSource: 10,
  topicsPerSource: 20,
  termCharacters: 200
} as const;

export function buildCapabilityCandidates(
  input: BuildCapabilityCandidatesInput
): CapabilityCandidate[] {
  const limit = candidateLimit(input.maxCandidates);
  if (limit === 0 || !normalize(input.text)) return [];

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
  source: FunctionAllowedSource | undefined
): boolean {
  return (
    enabled.has(definition.name) &&
    definition.sideEffectLevel === "read" &&
    !definition.deprecated &&
    Boolean(definition.agentCapability) &&
    (!source || definition.allowedSources.includes(source))
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
  return sources
    .slice(0, METADATA_LIMITS.sources)
    .some((source) =>
      matchesAnyExact(text, [
        boundedTerm(source.sourceKey),
        boundedTerm(source.displayName),
        ...source.aliases
          .slice(0, METADATA_LIMITS.aliasesPerSource)
          .map((alias) => boundedTerm(alias)),
        ...source.topics
          .slice(0, METADATA_LIMITS.topicsPerSource)
          .map((topic) => boundedTerm(topic))
      ])
    );
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
    if (normalizedText.includes(normalizedHint)) return true;
    return oneEditWindowMatch(normalizedText, normalizedHint);
  });
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

function hasWriteIntent(text: string): boolean {
  const normalized = normalize(text).replace(/^小哈/u, "");
  const writeAction = "記住|保存|儲存|存下|新增|修改|更新|刪除|移除|上傳|建立";
  return (
    new RegExp(`^(?:請|我要|要)?(?:幫我|替我)?(?:${writeAction})`, "u").test(normalized) ||
    new RegExp(`(?:幫我|替我)(?:${writeAction})`, "u").test(normalized)
  );
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
    ...(contract.ambiguity ? { ambiguity: contract.ambiguity } : {})
  };
}
