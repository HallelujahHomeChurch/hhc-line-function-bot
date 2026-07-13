import { parseFunctionArguments } from "../function-arguments.js";
import {
  hasExplicitWriteEvidence,
  normalizeFunctionArguments
} from "../functions/argument-normalization.js";
import {
  FUNCTION_DEFINITIONS,
  getFunctionDefinition,
  type FunctionAllowedSource,
  type FunctionDefinition
} from "../functions/definitions.js";
import type { AgentPlanDisposition, FunctionName, JsonRecord } from "../types.js";
import { isFunctionName } from "../types.js";
import type { ActiveTaskContext } from "./active-task.js";
import {
  hasDeclarativeArgumentEvidence,
  type CapabilityCandidateReason
} from "./capability-candidates.js";
import { groundPlanRecord, hasActiveEntityTextEvidence, liveActiveTask } from "./plan-evidence.js";
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
        | "invalid_policy"
        | "planner_denied"
        | "source_not_allowed"
        | "write_evidence_missing";
    };

export function validateAgentPlan(input: ValidateAgentPlanInput): ValidatedAgentPlan {
  if (!validConfidence(input.minConfidence)) {
    return { disposition: "deny", reasonCode: "invalid_policy" };
  }
  if (input.proposal.status === "no_plan") {
    return validateNoPlan(input);
  }

  const proposal = input.proposal;
  if (!validConfidence(proposal.confidence)) {
    return {
      disposition: "clarify",
      ...(proposal.capability ? { capability: proposal.capability } : {}),
      reasonCode: "low_confidence"
    };
  }
  if (proposal.disposition === "clarify") {
    return { disposition: "clarify", reasonCode: "planner_clarification" };
  }
  if (proposal.disposition === "deny") {
    return { disposition: "deny", reasonCode: "planner_denied" };
  }

  const liveTask = liveActiveTask(input.activeTask, input.now ?? new Date());
  const explicitCandidates = revalidatedExplicitCandidates(input);
  if (proposal.disposition === "chat") {
    return explicitCandidates.length === 0 && !hasAnyActiveEvidence(input, liveTask)
      ? { disposition: "chat", reasonCode: "no_capability_evidence" }
      : { disposition: "clarify", reasonCode: "capability_evidence_unresolved" };
  }

  const selected = selectedCandidate(input.candidates, proposal.capability);
  if (!selected) return { disposition: "deny", reasonCode: "candidate_not_allowed" };
  const capability = selected.capability;
  const definition = getFunctionDefinition(capability);
  const policyFailure = validateCapabilityPolicy(input, definition, capability);
  if (policyFailure) return policyFailure;
  const authoritativeDefinition = definition!;

  const rawArguments = proposal.arguments ?? {};
  if (
    authoritativeDefinition.sideEffectLevel !== "read" &&
    !hasExplicitWriteEvidence(input.text, rawArguments)
  ) {
    return { disposition: "deny", reasonCode: "write_evidence_missing" };
  }
  if (authoritativeDefinition.deprecated || !authoritativeDefinition.agentCapability) {
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

  const activeAuthority = selected.reason === "active_task_entity";
  if (selected.reason === "explicit_intent" && explicitCapability !== capability) {
    return {
      disposition: "clarify",
      capability,
      reasonCode: "capability_evidence_unresolved"
    };
  }
  if (activeAuthority) {
    const activeFailure = validateActiveAuthority(
      input.text,
      capability,
      authoritativeDefinition,
      liveTask,
      proposal.disposition
    );
    if (activeFailure) return activeFailure;
  }
  if (proposal.disposition === "switch" && explicitCapability !== capability) {
    return {
      disposition: "clarify",
      capability,
      reasonCode: "capability_evidence_unresolved"
    };
  }
  if (proposal.confidence < input.minConfidence) {
    return { disposition: "clarify", capability, reasonCode: "low_confidence" };
  }

  const groundedArguments = groundPlanRecord({
    record: rawArguments,
    text: input.text,
    rules: authoritativeDefinition.agentCapability.activeEvidence?.arguments,
    activeTask: activeAuthority ? liveTask : undefined,
    activeAuthority
  });
  if (groundedArguments.ambiguous) {
    return { disposition: "clarify", capability, reasonCode: "ambiguous_entity" };
  }
  const validatedArguments = parseAndNormalizeArguments(
    capability,
    groundedArguments.value,
    input.text,
    authoritativeDefinition,
    activeAuthority ? liveTask : undefined,
    activeAuthority
  );
  if (!validatedArguments) {
    return { disposition: "clarify", capability, reasonCode: "invalid_arguments" };
  }
  if (findMissingRequiredSlot(capability, validatedArguments)) {
    return { disposition: "clarify", capability, reasonCode: "missing_required_slot" };
  }

  const groundedReferences = groundPlanRecord({
    record: proposal.references ?? {},
    text: input.text,
    rules: authoritativeDefinition.agentCapability.activeEvidence?.references,
    activeTask: activeAuthority ? liveTask : undefined,
    activeAuthority
  });
  return {
    disposition: "execute",
    capability,
    arguments: validatedArguments,
    ...(Object.keys(groundedReferences.value).length > 0
      ? { references: groundedReferences.value }
      : {}),
    reasonCode: executionReason(selected.reason, proposal.disposition)
  };
}

function validateNoPlan(input: ValidateAgentPlanInput): ValidatedAgentPlan {
  const explicitCandidates = revalidatedExplicitCandidates(input);
  const disabledExplicitCandidates = revalidatedDisabledExplicitCandidates(input);
  if (explicitCandidates.length === 0 && disabledExplicitCandidates.length > 0) {
    return { disposition: "deny", reasonCode: "function_disabled" };
  }
  if (explicitCandidates.length !== 1) {
    return input.candidates.length === 0
      ? { disposition: "chat", reasonCode: "no_capability_evidence" }
      : { disposition: "clarify", reasonCode: "planner_unavailable" };
  }

  const capability = explicitCandidates[0];
  const definition = getFunctionDefinition(capability)!;
  const rawArguments = definition.requiredSlots.some(({ argument }) => argument === "query")
    ? { query: input.text }
    : {};
  const validatedArguments = parseAndNormalizeArguments(
    capability,
    rawArguments,
    input.text,
    definition
  );
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

function validateCapabilityPolicy(
  input: ValidateAgentPlanInput,
  definition: FunctionDefinition | undefined,
  capability: FunctionName
): Extract<ValidatedAgentPlan, { disposition: "deny" }> | undefined {
  if (!input.enabledFunctions.includes(capability)) {
    return { disposition: "deny", reasonCode: "function_disabled" };
  }
  if (!definition || !sourceAllowed(definition, input.sourceType)) {
    return { disposition: "deny", reasonCode: "source_not_allowed" };
  }
  return undefined;
}

function validateActiveAuthority(
  text: string,
  capability: FunctionName,
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext | undefined,
  disposition: AgentPlanDisposition
): Extract<ValidatedAgentPlan, { disposition: "clarify" }> | undefined {
  if (
    !activeTask ||
    activeTask.capability !== capability ||
    !definition.agentCapability ||
    !hasActiveEntityTextEvidence(text, definition.agentCapability, activeTask)
  ) {
    return { disposition: "clarify", capability, reasonCode: "active_task_unavailable" };
  }
  const requiredOperation = requiredActiveOperation(disposition);
  if (requiredOperation && !operationAllowed(definition, activeTask, requiredOperation)) {
    return { disposition: "clarify", capability, reasonCode: "operation_not_allowed" };
  }
  return undefined;
}

function requiredActiveOperation(
  disposition: AgentPlanDisposition
): "continue" | "refine" | "advance" | "select" | undefined {
  if (disposition === "execute") return "continue";
  return disposition === "continue" ||
    disposition === "refine" ||
    disposition === "advance" ||
    disposition === "select"
    ? disposition
    : undefined;
}

function parseAndNormalizeArguments(
  capability: FunctionName,
  argumentsValue: JsonRecord,
  text: string,
  definition: FunctionDefinition,
  activeTask?: ActiveTaskContext,
  activeAuthority = false
): JsonRecord | undefined {
  const parsed = parseFunctionArguments(capability, argumentsValue);
  if (!parsed) return undefined;
  const normalized = parseFunctionArguments(
    capability,
    normalizeFunctionArguments(capability, parsed, { text, inferStructuredEvidence: true })
  );
  if (!normalized) return undefined;
  const grounded = groundPlanRecord({
    record: normalized,
    text,
    rules: definition.agentCapability?.activeEvidence?.arguments,
    activeTask,
    activeAuthority
  });
  return grounded.ambiguous ? undefined : parseFunctionArguments(capability, grounded.value);
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
      (definition.agentCapability.intents.some((intent) => textContains(input.text, intent)) ||
        hasDeclarativeArgumentEvidence(definition, input.text))
    );
  });
}

function revalidatedDisabledExplicitCandidates(input: ValidateAgentPlanInput): FunctionName[] {
  const enabled = new Set(input.enabledFunctions);
  return FUNCTION_DEFINITIONS.filter(
    (definition) =>
      !enabled.has(definition.name) &&
      !definition.deprecated &&
      definition.sideEffectLevel === "read" &&
      Boolean(definition.agentCapability) &&
      sourceAllowed(definition, input.sourceType) &&
      (definition.agentCapability?.intents.some((intent) => textContains(input.text, intent)) ||
        hasDeclarativeArgumentEvidence(definition, input.text))
  ).map(({ name }) => name);
}

function hasAnyActiveEvidence(
  input: ValidateAgentPlanInput,
  activeTask: ActiveTaskContext | undefined
): boolean {
  if (!activeTask) return false;
  const candidate = input.candidates.find(
    ({ capability, reason }) =>
      capability === activeTask.capability && reason === "active_task_entity"
  );
  const definition = getFunctionDefinition(activeTask.capability);
  return Boolean(
    candidate &&
    definition?.agentCapability &&
    input.enabledFunctions.includes(activeTask.capability) &&
    sourceAllowed(definition, input.sourceType) &&
    hasActiveEntityTextEvidence(input.text, definition.agentCapability, activeTask)
  );
}

function selectedCandidate(
  candidates: readonly AgentPlanValidationCandidate[],
  capability: FunctionName | undefined
): AgentPlanValidationCandidate | undefined {
  if (!capability || !isFunctionName(capability)) return undefined;
  const matches = candidates.filter(
    (candidate) => isFunctionName(candidate.capability) && candidate.capability === capability
  );
  return matches.length === 1 ? matches[0] : undefined;
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

function operationAllowed(
  definition: FunctionDefinition,
  activeTask: ActiveTaskContext,
  operation: "continue" | "refine" | "advance" | "select"
): boolean {
  return (
    (definition.agentCapability?.operations ?? []).includes(operation) &&
    activeTask.supportedOperations.includes(operation)
  );
}

function executionReason(
  candidateReason: CapabilityCandidateReason,
  disposition: AgentPlanDisposition
): "explicit_intent" | "active_task_refinement" | "explicit_capability_switch" {
  if (candidateReason === "active_task_entity") return "active_task_refinement";
  return disposition === "switch" ? "explicit_capability_switch" : "explicit_intent";
}

function sourceAllowed(definition: FunctionDefinition, sourceType: string): boolean {
  return definition.allowedSources.includes(sourceType as FunctionAllowedSource);
}

function validConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
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
