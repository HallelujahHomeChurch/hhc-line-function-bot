import type { FunctionAllowedSource } from "../functions/definitions.js";
import type { AgentPlannerResult, FunctionName } from "../types.js";
import type { ActiveTaskContext } from "./active-task.js";
import {
  buildCapabilityCandidates,
  retrievalEvidenceRequests,
  type KnowledgeSourceMetadata
} from "./capability-candidates.js";
import type { AgentPlanner } from "./planner.js";
import { validateAgentPlan, type ValidatedAgentPlan } from "./plan-validator.js";
import type { AgentTurnTraceStep, AgentValidatorReason } from "./trace-store.js";
import type { AgentEvidenceProvider } from "./evidence/types.js";

export interface DynamicKnowledgeMetadataProvider {
  list(profileName: string, limit: number): Promise<readonly KnowledgeSourceMetadata[]>;
}

export type RetrievalEvidenceProvider = AgentEvidenceProvider;

export interface ControlledAgentRouterInput {
  profileName: string;
  text: string;
  enabledFunctions: readonly FunctionName[];
  sourceType: string;
  sourceId?: string;
  requesterUserId?: string;
  activeTask?: ActiveTaskContext;
  maxCandidates: number;
  minPlannerConfidence: number;
}

export interface ControlledAgentRouter {
  resolve(
    input: ControlledAgentRouterInput,
    observe?: (step: AgentTurnTraceStep) => void
  ): Promise<ValidatedAgentPlan>;
}

export function createControlledAgentRouter(options: {
  planner: AgentPlanner;
  knowledgeMetadata?: DynamicKnowledgeMetadataProvider;
  retrievalEvidenceProviders?: Readonly<Record<string, RetrievalEvidenceProvider>>;
  now?: () => Date;
}): ControlledAgentRouter {
  const now = options.now ?? (() => new Date());

  return {
    async resolve(input, observe): Promise<ValidatedAgentPlan> {
      const source = allowedSource(input.sourceType);
      if (!source) {
        return { disposition: "deny", reasonCode: "source_not_allowed" };
      }

      const knowledgeSources = await readKnowledgeMetadata(
        options.knowledgeMetadata,
        input.profileName
      );
      const retrievalEvidence = await readRetrievalEvidence(
        options.retrievalEvidenceProviders,
        input,
        source
      );
      const candidates = buildCapabilityCandidates({
        text: input.text,
        enabledFunctions: input.enabledFunctions,
        activeTask: input.activeTask,
        knowledgeSources,
        retrievalEvidence: retrievalEvidence.matched,
        maxCandidates: input.maxCandidates,
        source
      });
      emitDiagnostic(observe, {
        phase: "capability_candidates",
        candidates: candidates.map(({ capability }) => capability),
        candidateCount: candidates.length
      });
      if (candidates.length === 0 && retrievalEvidence.unavailable.length > 0) {
        emitDiagnostic(observe, {
          phase: "plan_validation",
          outcome: "unavailable",
          disposition: "clarify",
          validatorReason: "retrieval_unavailable"
        });
        return { disposition: "clarify", reasonCode: "retrieval_unavailable" };
      }
      const proposal = await proposeOrNoPlan(options.planner, {
        profileName: input.profileName,
        text: input.text,
        candidates,
        activeTask: input.activeTask
      });
      emitDiagnostic(observe, plannerTraceStep(proposal));

      const validatedPlan = validateAgentPlan({
        text: input.text,
        enabledFunctions: input.enabledFunctions,
        candidates,
        proposal,
        activeTask: input.activeTask,
        minConfidence: input.minPlannerConfidence,
        sourceType: source,
        now: now()
      });
      const plan =
        validatedPlan.disposition === "clarify" &&
        validatedPlan.reasonCode === "capability_evidence_unresolved" &&
        candidates.length > 1
          ? {
              ...validatedPlan,
              candidateCapabilities: candidates.map(({ capability }) => capability)
            }
          : validatedPlan;
      emitDiagnostic(observe, {
        phase: "plan_validation",
        outcome: "accepted",
        action:
          plan.disposition === "execute" ||
          plan.disposition === "collect" ||
          plan.disposition === "clarify"
            ? plan.capability
            : undefined,
        disposition: plan.disposition,
        validatorReason: plan.reasonCode as AgentValidatorReason
      });
      return plan;
    }
  };
}

function emitDiagnostic(
  observe: ((step: AgentTurnTraceStep) => void) | undefined,
  step: AgentTurnTraceStep
): void {
  try {
    observe?.(step);
  } catch {
    // Diagnostics are best-effort and never change routing authority.
  }
}

function plannerTraceStep(proposal: AgentPlannerResult): AgentTurnTraceStep {
  if (proposal.status === "no_plan") {
    return {
      phase: "planner",
      outcome: "no_plan",
      provider: proposal.attempts.at(-1)?.provider
    };
  }
  return {
    phase: "planner",
    outcome: "proposed",
    provider: proposal.provider,
    disposition: proposal.disposition,
    confidenceBucket: confidenceBucket(proposal.confidence)
  };
}

function confidenceBucket(confidence: number): "low" | "medium" | "high" {
  if (confidence < 0.5) return "low";
  return confidence < 0.8 ? "medium" : "high";
}

async function readRetrievalEvidence(
  providers: Readonly<Record<string, RetrievalEvidenceProvider>> | undefined,
  input: ControlledAgentRouterInput,
  source: FunctionAllowedSource
): Promise<{ matched: FunctionName[]; unavailable: FunctionName[] }> {
  if (!providers) return { matched: [], unavailable: [] };
  const requests = retrievalEvidenceRequests({
    text: input.text,
    enabledFunctions: input.enabledFunctions,
    source
  });
  const byProviderAndQuery = new Map<
    string,
    { provider: string; query: string; capabilities: FunctionName[] }
  >();
  for (const request of requests) {
    const key = `${request.provider}\u0000${request.query}`;
    const entry = byProviderAndQuery.get(key) ?? {
      provider: request.provider,
      query: request.query,
      capabilities: []
    };
    entry.capabilities.push(request.capability);
    byProviderAndQuery.set(key, entry);
  }
  const matched = new Set<FunctionName>();
  const unavailable = new Set<FunctionName>();
  for (const { provider: providerName, query, capabilities } of byProviderAndQuery.values()) {
    const provider = providers[providerName];
    if (!provider) continue;
    try {
      const evidence = await provider.probe({
        profileName: input.profileName,
        text: query,
        source,
        sourceId: input.sourceId,
        requesterUserId: input.requesterUserId,
        maxResults: KNOWLEDGE_METADATA_LIMIT
      });
      if (evidence.matched) for (const capability of capabilities) matched.add(capability);
    } catch {
      for (const capability of capabilities) unavailable.add(capability);
    }
  }
  return { matched: Array.from(matched), unavailable: Array.from(unavailable) };
}

const KNOWLEDGE_METADATA_LIMIT = 20;

async function readKnowledgeMetadata(
  provider: DynamicKnowledgeMetadataProvider | undefined,
  profileName: string
): Promise<readonly KnowledgeSourceMetadata[]> {
  if (!provider) return [];
  try {
    return await provider.list(profileName, KNOWLEDGE_METADATA_LIMIT);
  } catch {
    return [];
  }
}

async function proposeOrNoPlan(
  planner: AgentPlanner,
  input: Parameters<AgentPlanner["propose"]>[0]
): Promise<AgentPlannerResult> {
  try {
    return await planner.propose(input);
  } catch {
    return { status: "no_plan", reasonCode: "providers_unavailable", attempts: [] };
  }
}

function allowedSource(sourceType: string): FunctionAllowedSource | undefined {
  return sourceType === "user" || sourceType === "group" ? sourceType : undefined;
}
