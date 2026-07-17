import type { ActiveTaskContext } from "./active-task.js";
import {
  FUNCTION_DEFINITIONS,
  type AgentCapabilityContract,
  type FunctionAllowedSource,
  type FunctionDefinition
} from "../functions/definitions.js";
import type { FunctionName } from "../types.js";
import { parseFunctionArguments } from "../function-arguments.js";
import { normalizeFunctionArguments } from "../functions/argument-normalization.js";
import {
  resolveKnowledgeRoutingMetadata,
  type KnowledgeRoutingMetadata
} from "../knowledge/routing-metadata.js";
import {
  hasWriteIntent,
  isConservativeKnowledgeEvidenceText,
  isInterpersonalOrSmallTalkText
} from "./knowledge-evidence-guard.js";
import { hasActiveEntityTextEvidence } from "./plan-evidence.js";
import { projectRetrievalQuery } from "./retrieval-query.js";

export interface KnowledgeSourceMetadata extends Omit<KnowledgeRoutingMetadata, "sampleQueries"> {
  sampleQueries?: string[];
}

export type CapabilityCandidateReason =
  | "explicit_intent"
  | "argument_evidence"
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
  writeCandidate: boolean;
  genericWriteFallback: boolean;
}

const REASON_SCORE: Record<CapabilityCandidateReason, number> = {
  explicit_intent: 400,
  argument_evidence: 400,
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
      definitionOrder,
      writeCandidate: definition.sideEffectLevel !== "read",
      genericWriteFallback: definition.agentCapability?.genericWriteFallback === true
    });
  }

  const hasSpecificWrite = ranked.some(
    ({ writeCandidate, genericWriteFallback }) => writeCandidate && !genericWriteFallback
  );
  const prioritized = hasSpecificWrite
    ? ranked.filter(({ writeCandidate, genericWriteFallback }) =>
        writeCandidate ? !genericWriteFallback : true
      )
    : ranked;

  return prioritized
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
    Boolean(definition.agentCapability) &&
    definition.allowedSources.includes(source)
  );
}

function strongestReason(
  definition: FunctionDefinition,
  input: BuildCapabilityCandidatesInput
): CapabilityCandidateReason | undefined {
  const contract = definition.agentCapability!;
  if (definition.sideEffectLevel !== "read") {
    return hasWriteIntent(input.text) &&
      (matchesAnyExact(input.text, contract.intents) ||
        matchesAnyHint(input.text, contract.candidateHints))
      ? "explicit_intent"
      : undefined;
  }
  if (matchesAnyExact(input.text, contract.intents)) return "explicit_intent";
  if (isInterpersonalOrSmallTalkText(input.text)) return undefined;
  if (!hasWriteIntent(input.text) && hasDeclarativeArgumentEvidence(definition, input.text)) {
    return "argument_evidence";
  }
  const knowledgeDefinition = definition.requires.includes("knowledge");
  const knowledgeEvidenceAllowed =
    !knowledgeDefinition || isConservativeKnowledgeEvidenceText(input.text);
  const taskOrRetrievalEvidenceAllowed = knowledgeDefinition
    ? knowledgeEvidenceAllowed
    : !hasWriteIntent(input.text);
  if (
    taskOrRetrievalEvidenceAllowed &&
    matchesActiveTaskEntity(definition, input.text, input.activeTask)
  ) {
    return "active_task_entity";
  }
  if (
    knowledgeDefinition &&
    knowledgeEvidenceAllowed &&
    matchesKnowledgeMetadata(input.text, input.knowledgeSources)
  ) {
    return "knowledge_metadata";
  }
  if (taskOrRetrievalEvidenceAllowed && input.retrievalEvidence?.includes(definition.name)) {
    return "retrieval_evidence";
  }
  if (taskOrRetrievalEvidenceAllowed && matchesAnyHint(input.text, contract.candidateHints)) {
    return "capability_hint";
  }
  return undefined;
}

export function hasDeclarativeArgumentEvidence(
  definition: FunctionDefinition,
  text: string
): boolean {
  const rule = definition.agentCapability?.argumentEvidence;
  if (!rule) return false;
  const normalized = normalizeFunctionArguments(
    definition.name,
    { [rule.queryArgument]: text },
    { text, inferStructuredEvidence: true }
  );
  const parsed = parseFunctionArguments(definition.name, normalized);
  if (!parsed || !rule.allOf.every((field) => hasArgumentValue(parsed[field]))) return false;
  return !rule.anyOf?.length || rule.anyOf.some((field) => hasArgumentValue(parsed[field]));
}

function hasArgumentValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return Array.isArray(value) && value.length > 0;
}

function matchesActiveTaskEntity(
  definition: FunctionDefinition,
  text: string,
  activeTask: ActiveTaskContext | undefined
): boolean {
  const contract = definition.agentCapability;
  if (
    !activeTask ||
    !contract ||
    activeTask.currentCapability !== definition.name ||
    !activeTask.allowedCapabilities.includes(definition.name)
  ) {
    return false;
  }
  if (
    !contract.operations?.some((operation) => activeTask.supportedOperations.includes(operation))
  ) {
    return false;
  }
  const entityTypes = new Set(contract.entityTypes ?? []);
  return (
    activeTask.entities.some(
      (entity) =>
        entityTypes.has(entity.type) &&
        matchesAnyExact(text, [entity.key, entity.label, ...(entity.aliases ?? [])])
    ) || hasActiveEntityTextEvidence(text, contract, activeTask)
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

export function retrievalEvidenceRequests(input: {
  text: string;
  enabledFunctions: readonly FunctionName[];
  source: FunctionAllowedSource;
}): Array<{ capability: FunctionName; provider: string; query: string }> {
  if (!isConservativeKnowledgeEvidenceText(input.text)) return [];
  const enabled = new Set(input.enabledFunctions);
  return FUNCTION_DEFINITIONS.flatMap((definition) => {
    if (!isEligibleDefinition(definition, enabled, input.source)) return [];
    const provider = definition.agentCapability?.retrievalEvidence?.provider.trim();
    if (!provider) return [];
    const query = projectRetrievalQuery({ text: input.text, definition });
    return query ? [{ capability: definition.name, provider, query }] : [];
  });
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
    semanticDescription: contract.semanticDescription,
    ...(contract.arguments
      ? {
          arguments: Object.fromEntries(
            Object.entries(contract.arguments).map(([key, argument]) => [
              key,
              {
                type: argument.type,
                authority: argument.authority,
                ...(argument.values ? { values: [...argument.values] } : {})
              }
            ])
          )
        }
      : {}),
    operations: [...contract.operations],
    responseProjection: {
      defaultMode: contract.responseProjection.defaultMode,
      fields: Object.fromEntries(
        Object.entries(contract.responseProjection.fields).map(([key, field]) => [
          key,
          { label: field.label, aliases: [...field.aliases] }
        ])
      )
    },
    ...(contract.handoffs
      ? {
          handoffs: contract.handoffs.map((handoff) => ({
            on: handoff.on,
            to: handoff.to,
            map: { ...handoff.map },
            ...(handoff.when ? { when: { ...handoff.when } } : {})
          }))
        }
      : {}),
    ...(contract.genericWriteFallback ? { genericWriteFallback: true } : {}),
    ...(contract.entityTypes ? { entityTypes: [...contract.entityTypes] } : {}),
    ...(contract.argumentEvidence
      ? {
          argumentEvidence: {
            queryArgument: contract.argumentEvidence.queryArgument,
            allOf: [...contract.argumentEvidence.allOf],
            ...(contract.argumentEvidence.anyOf
              ? { anyOf: [...contract.argumentEvidence.anyOf] }
              : {})
          }
        }
      : {}),
    ...(contract.refinableFields ? { refinableFields: [...contract.refinableFields] } : {}),
    ...(contract.retrievalEvidence
      ? {
          retrievalEvidence: {
            provider: contract.retrievalEvidence.provider,
            ...(contract.retrievalEvidence.queryStopWords
              ? { queryStopWords: [...contract.retrievalEvidence.queryStopWords] }
              : {})
          }
        }
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
