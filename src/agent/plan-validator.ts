import { parseFunctionArguments } from "../function-arguments.js";
import {
  hasExplicitWriteEvidence,
  normalizeFunctionArguments
} from "../functions/argument-normalization.js";
import {
  getFunctionDefinition,
  type FunctionAllowedSource,
  type FunctionDefinition
} from "../functions/definitions.js";
import type { AgentPlanDisposition, FunctionName, JsonRecord } from "../types.js";
import { isFunctionName } from "../types.js";
import type { ActiveTaskContext } from "./active-task.js";
import type { CapabilityCandidateReason } from "./capability-candidates.js";
import { findMissingRequiredSlot } from "./slot-clarification.js";

export interface AgentPlanValidationCandidate {
  capability: FunctionName;
  reason: CapabilityCandidateReason;
  score: number;
}

export type AgentPlanProposalInput =
  | {
      status?: "proposed";
      version?: 1;
      disposition: AgentPlanDisposition;
      capability?: FunctionName;
      arguments?: Record<string, unknown>;
      references?: Record<string, unknown>;
      confidence: number;
    }
  | {
      status: "no_plan";
      reasonCode?: "no_candidates" | "providers_unavailable" | "invalid_output";
    };

export interface ValidateAgentPlanInput {
  text: string;
  enabledFunctions: readonly FunctionName[];
  candidates: readonly AgentPlanValidationCandidate[];
  proposal: AgentPlanProposalInput;
  activeTask?: ActiveTaskContext;
  minConfidence: number;
  sourceType: string;
  now?: Date;
}

export type ValidatedAgentPlan =
  | {
      disposition: "execute";
      capability: FunctionName;
      arguments: JsonRecord;
      references?: JsonRecord;
      reasonCode:
        | "explicit_intent"
        | "active_task_refinement"
        | "explicit_capability_switch"
        | "deterministic_explicit_intent";
    }
  | {
      disposition: "clarify";
      capability?: FunctionName;
      reasonCode:
        | "active_task_unavailable"
        | "ambiguous_entity"
        | "capability_evidence_unresolved"
        | "explicit_switch_required"
        | "invalid_arguments"
        | "low_confidence"
        | "missing_required_slot"
        | "operation_not_allowed"
        | "planner_clarification"
        | "planner_unavailable";
    }
  | { disposition: "chat"; reasonCode: "no_capability_evidence" }
  | {
      disposition: "deny";
      reasonCode:
        | "candidate_not_allowed"
        | "capability_not_agent_enabled"
        | "function_disabled"
        | "planner_denied"
        | "source_not_allowed"
        | "write_evidence_missing";
    };

interface GroundedRecord {
  value: JsonRecord;
  ambiguous: boolean;
}

const RELATIVE_VALUE_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  today: ["今天", "今日"],
  tomorrow: ["明天", "明日"],
  day_after_tomorrow: ["後天"],
  this_week: ["本週", "這週", "本周", "這周"],
  next_meeting: ["下一場", "下場", "下一次", "下次", "最近一場"],
  upcoming: ["近期", "接下來"],
  morning_prayer_family: ["晨更", "晨更家族"],
  street_sign_service: ["舉牌", "為耶穌舉牌"],
  custom_service_schedule: ["自訂服事", "其他服事"],
  ppt_slide: ["投影片", "簡報", "ppt"],
  sheet_music: ["歌譜", "樂譜"],
  private: ["私人", "自己"],
  group: ["群組", "大家", "共用"]
};

export function validateAgentPlan(input: ValidateAgentPlanInput): ValidatedAgentPlan {
  if (input.proposal.status === "no_plan") {
    return validateNoPlan(input);
  }

  const proposal = input.proposal;
  if (proposal.disposition === "clarify") {
    return { disposition: "clarify", reasonCode: "planner_clarification" };
  }
  if (proposal.disposition === "deny") {
    return { disposition: "deny", reasonCode: "planner_denied" };
  }

  const liveTask = liveActiveTask(input.activeTask, input.now ?? new Date());
  const explicitCandidates = revalidatedExplicitCandidates(input);
  const hasActiveEvidence = revalidatedActiveCandidates(input, liveTask).length > 0;

  if (proposal.disposition === "chat") {
    return explicitCandidates.length === 0 && !hasActiveEvidence
      ? { disposition: "chat", reasonCode: "no_capability_evidence" }
      : { disposition: "clarify", reasonCode: "capability_evidence_unresolved" };
  }

  if (!proposal.capability || !candidateIncludes(input.candidates, proposal.capability)) {
    return { disposition: "deny", reasonCode: "candidate_not_allowed" };
  }
  const capability = proposal.capability;
  const definition = getFunctionDefinition(capability);
  if (!input.enabledFunctions.includes(capability)) {
    return { disposition: "deny", reasonCode: "function_disabled" };
  }
  if (!definition || !sourceAllowed(definition, input.sourceType)) {
    return { disposition: "deny", reasonCode: "source_not_allowed" };
  }
  const rawArguments = proposal.arguments ?? {};
  if (
    definition.sideEffectLevel !== "read" &&
    !hasExplicitWriteEvidence(input.text, rawArguments)
  ) {
    return { disposition: "deny", reasonCode: "write_evidence_missing" };
  }
  if (definition.deprecated || !definition.agentCapability) {
    return { disposition: "deny", reasonCode: "capability_not_agent_enabled" };
  }

  if (explicitCandidates.length > 1) {
    return { disposition: "clarify", reasonCode: "capability_evidence_unresolved" };
  }
  const explicitCapability = explicitCandidates[0];
  if (explicitCapability && explicitCapability !== capability) {
    return {
      disposition: "clarify",
      capability: explicitCapability,
      reasonCode: "explicit_switch_required"
    };
  }
  if (proposal.disposition === "switch" && explicitCapability !== capability) {
    return {
      disposition: "clarify",
      capability,
      reasonCode: "capability_evidence_unresolved"
    };
  }

  const activeDisposition = isActiveTaskDisposition(proposal.disposition);
  if (activeDisposition) {
    if (!liveTask || liveTask.capability !== capability) {
      return { disposition: "clarify", capability, reasonCode: "active_task_unavailable" };
    }
    if (!operationAllowed(definition, liveTask, proposal.disposition)) {
      return { disposition: "clarify", capability, reasonCode: "operation_not_allowed" };
    }
  }

  if (!Number.isFinite(proposal.confidence) || proposal.confidence < input.minConfidence) {
    return { disposition: "clarify", capability, reasonCode: "low_confidence" };
  }

  const groundedArguments = groundRecord(
    rawArguments,
    input.text,
    definition,
    activeDisposition ? liveTask : undefined,
    false
  );
  if (groundedArguments.ambiguous) {
    return { disposition: "clarify", capability, reasonCode: "ambiguous_entity" };
  }
  const parsedArguments = parseFunctionArguments(capability, groundedArguments.value);
  if (!parsedArguments) {
    return { disposition: "clarify", capability, reasonCode: "invalid_arguments" };
  }
  const normalizedArguments = normalizeFunctionArguments(capability, parsedArguments, {
    text: input.text
  });
  const validatedArguments = parseFunctionArguments(capability, normalizedArguments);
  if (!validatedArguments) {
    return { disposition: "clarify", capability, reasonCode: "invalid_arguments" };
  }
  if (findMissingRequiredSlot(capability, validatedArguments)) {
    return { disposition: "clarify", capability, reasonCode: "missing_required_slot" };
  }

  const groundedReferences = groundRecord(
    proposal.references ?? {},
    input.text,
    definition,
    activeDisposition ? liveTask : undefined,
    true
  );
  const reasonCode = executionReason(proposal.disposition, capability, input.activeTask);
  return {
    disposition: "execute",
    capability,
    arguments: validatedArguments,
    ...(Object.keys(groundedReferences.value).length > 0
      ? { references: groundedReferences.value }
      : {}),
    reasonCode
  };
}

function validateNoPlan(input: ValidateAgentPlanInput): ValidatedAgentPlan {
  const explicitCandidates = revalidatedExplicitCandidates(input);
  if (explicitCandidates.length !== 1) {
    return input.candidates.length === 0
      ? { disposition: "chat", reasonCode: "no_capability_evidence" }
      : { disposition: "clarify", reasonCode: "planner_unavailable" };
  }

  const capability = explicitCandidates[0];
  const definition = getFunctionDefinition(capability);
  if (!definition) {
    return { disposition: "deny", reasonCode: "candidate_not_allowed" };
  }
  const rawArguments = definition.requiredSlots.some(({ argument }) => argument === "query")
    ? { query: input.text }
    : {};
  const parsedArguments = parseFunctionArguments(capability, rawArguments);
  if (!parsedArguments) {
    return { disposition: "clarify", capability, reasonCode: "invalid_arguments" };
  }
  const normalizedArguments = normalizeFunctionArguments(capability, parsedArguments, {
    text: input.text
  });
  const validatedArguments = parseFunctionArguments(capability, normalizedArguments);
  if (!validatedArguments || findMissingRequiredSlot(capability, validatedArguments)) {
    return { disposition: "clarify", capability, reasonCode: "missing_required_slot" };
  }
  return {
    disposition: "execute",
    capability,
    arguments: validatedArguments,
    reasonCode: "deterministic_explicit_intent"
  };
}

function revalidatedExplicitCandidates(input: ValidateAgentPlanInput): FunctionName[] {
  const enabled = new Set(input.enabledFunctions);
  return uniqueCapabilities(input.candidates).filter((capability) => {
    if (!enabled.has(capability)) return false;
    const definition = getFunctionDefinition(capability);
    return Boolean(
      definition &&
      !definition.deprecated &&
      definition.sideEffectLevel === "read" &&
      definition.agentCapability &&
      sourceAllowed(definition, input.sourceType) &&
      definition.agentCapability.intents.some((intent) => textContains(input.text, intent))
    );
  });
}

function revalidatedActiveCandidates(
  input: ValidateAgentPlanInput,
  activeTask: ActiveTaskContext | undefined
): FunctionName[] {
  if (!activeTask || !candidateIncludes(input.candidates, activeTask.capability)) return [];
  const definition = getFunctionDefinition(activeTask.capability);
  if (
    !definition?.agentCapability ||
    definition.deprecated ||
    !input.enabledFunctions.includes(activeTask.capability) ||
    !sourceAllowed(definition, input.sourceType)
  ) {
    return [];
  }
  const entityTypes = new Set(definition.agentCapability.entityTypes ?? []);
  return activeTask.entities.some(
    (entity) =>
      entityTypes.has(entity.type) &&
      [entity.key, entity.label, ...(entity.aliases ?? [])].some((term) =>
        textContains(input.text, term)
      )
  )
    ? [activeTask.capability]
    : [];
}

function groundRecord(
  record: Record<string, unknown>,
  text: string,
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext | undefined,
  reference: boolean
): GroundedRecord {
  const value: JsonRecord = {};
  for (const [key, proposedValue] of Object.entries(record)) {
    const grounded = groundValue(key, proposedValue, text, definition, activeTask, reference);
    if (grounded.ambiguous) return { value: {}, ambiguous: true };
    if (grounded.value !== undefined) value[key] = grounded.value;
  }
  return { value, ambiguous: false };
}

function groundValue(
  key: string,
  value: unknown,
  text: string,
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext | undefined,
  reference: boolean
): { value?: unknown; ambiguous: boolean } {
  if (Array.isArray(value)) {
    const grounded = value.map((entry) =>
      groundValue(key, entry, text, definition, activeTask, reference)
    );
    if (grounded.some(({ ambiguous }) => ambiguous)) return { ambiguous: true };
    if (grounded.some((entry) => entry.value === undefined)) return { ambiguous: false };
    return { value: grounded.map((entry) => entry.value), ambiguous: false };
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { ambiguous: false };
  }

  const entityMatches = reference ? [] : matchingEntities(key, text, definition, activeTask);
  if (entityMatches.length > 1) return { ambiguous: true };
  if (entityMatches.length === 1 && entityContains(entityMatches[0], value)) {
    return { value: canonicalEntityValue(key, entityMatches[0]), ambiguous: false };
  }
  if (scalarHasTextEvidence(text, value)) return { value, ambiguous: false };
  if (activeTask && activeValueAllowed(key, value, definition, activeTask, reference)) {
    return { value, ambiguous: false };
  }
  return { ambiguous: false };
}

function matchingEntities(
  key: string,
  text: string,
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext | undefined
) {
  if (!activeTask || !fieldAllowedByContract(key, definition)) return [];
  const expectedType = entityTypeForField(key);
  const contractTypes = new Set(definition.agentCapability?.entityTypes ?? []);
  return activeTask.entities.filter(
    (entity) =>
      contractTypes.has(entity.type) &&
      (!expectedType || entity.type === expectedType) &&
      [entity.key, entity.label, ...(entity.aliases ?? [])].some((term) => textContains(text, term))
  );
}

function activeValueAllowed(
  key: string,
  value: string | number | boolean,
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext,
  reference: boolean
): boolean {
  if (reference) {
    return Object.values(activeTask.references ?? {}).some((candidate) =>
      valuesEqual(candidate, value)
    );
  }
  if (!fieldAllowedByContract(key, definition)) return false;
  if (valuesEqual(activeTask.anchors[key], value)) return true;
  return activeTask.entities.some(
    (entity) =>
      (definition.agentCapability?.entityTypes ?? []).includes(entity.type) &&
      entityContains(entity, value)
  );
}

function fieldAllowedByContract(key: string, definition: FunctionDefinition): boolean {
  const fields = definition.agentCapability?.refinableFields ?? [];
  return fields.includes(key) || (key === "query" && fields.includes("selection"));
}

function entityTypeForField(key: string): string | undefined {
  return {
    date: "date",
    specificDate: "date",
    dateIntent: "date",
    meeting: "meeting",
    role: "role",
    scheduleType: "scheduleType",
    sourceKey: "source",
    documentId: "document",
    ordinal: "ordinal",
    selection: "selection",
    query: "selection"
  }[key];
}

function entityContains(
  entity: { key: string; label: string; aliases?: string[] },
  value: unknown
): boolean {
  return (
    typeof value === "string" &&
    [entity.key, entity.label, ...(entity.aliases ?? [])].some(
      (term) => normalize(term) === normalize(value)
    )
  );
}

function canonicalEntityValue(key: string, entity: { key: string; label: string }): string {
  return key === "sourceKey" || key === "documentId" ? entity.key : entity.label;
}

function scalarHasTextEvidence(text: string, value: string | number | boolean): boolean {
  if (typeof value === "boolean") {
    return value ? /(?:確認|確定|同意|可以保存)/u.test(text) : /(?:取消|不要|先不要)/u.test(text);
  }
  const stringValue = String(value);
  if (textContains(text, stringValue)) return true;
  if (typeof value === "number") return false;
  const date = stringValue.match(/^\d{4}-(\d{2})-(\d{2})$/u);
  if (date && textContains(text, `${Number(date[1])}/${Number(date[2])}`)) return true;
  return (RELATIVE_VALUE_EVIDENCE[stringValue] ?? []).some((term) => textContains(text, term));
}

function candidateIncludes(
  candidates: readonly AgentPlanValidationCandidate[],
  capability: FunctionName
): boolean {
  return candidates.some(
    (candidate) => isFunctionName(candidate.capability) && candidate.capability === capability
  );
}

function uniqueCapabilities(candidates: readonly AgentPlanValidationCandidate[]): FunctionName[] {
  return [
    ...new Set(
      candidates
        .map(({ capability }) => capability)
        .filter((capability): capability is FunctionName => isFunctionName(capability))
    )
  ];
}

function sourceAllowed(definition: FunctionDefinition, sourceType: string): boolean {
  return definition.allowedSources.includes(sourceType as FunctionAllowedSource);
}

function liveActiveTask(
  activeTask: ActiveTaskContext | undefined,
  now: Date
): ActiveTaskContext | undefined {
  if (!activeTask) return undefined;
  const createdAt = Date.parse(activeTask.createdAt);
  const expiresAt = Date.parse(activeTask.expiresAt);
  return Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt &&
    createdAt <= now.getTime() &&
    expiresAt > now.getTime()
    ? activeTask
    : undefined;
}

function operationAllowed(
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext,
  disposition: AgentPlanDisposition
): boolean {
  return (
    (definition.agentCapability?.operations ?? []).includes(
      disposition as "continue" | "refine" | "advance" | "select"
    ) && activeTask.supportedOperations.includes(disposition)
  );
}

function isActiveTaskDisposition(
  disposition: AgentPlanDisposition
): disposition is "continue" | "refine" | "advance" | "select" {
  return ["continue", "refine", "advance", "select"].includes(disposition);
}

function executionReason(
  disposition: AgentPlanDisposition,
  capability: FunctionName,
  activeTask: ActiveTaskContext | undefined
): "explicit_intent" | "active_task_refinement" | "explicit_capability_switch" {
  if (disposition === "switch") return "explicit_capability_switch";
  return isActiveTaskDisposition(disposition) && activeTask?.capability === capability
    ? "active_task_refinement"
    : "explicit_intent";
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return (
    (typeof left === "string" || typeof left === "number" || typeof left === "boolean") &&
    normalize(String(left)) === normalize(String(right))
  );
}

function textContains(text: string, term: string): boolean {
  const normalizedTerm = normalize(term);
  return normalizedTerm.length > 0 && normalize(text).includes(normalizedTerm);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}
