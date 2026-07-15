import { z } from "zod";

import type { ActiveTaskContext } from "./active-task.js";
import type { CapabilityCandidateReason } from "./capability-candidates.js";
import { getFunctionDefinition, type AgentCapabilityContract } from "../functions/definitions.js";
import {
  AGENT_PLAN_DISPOSITIONS,
  FUNCTION_NAMES,
  isFunctionName,
  type AgentPlanProposal,
  type AgentPlannerAttemptDiagnostic,
  type AgentPlannerAttemptReason,
  type AgentPlannerResult,
  type ChatProvider,
  type FunctionName,
  type ModelProviderName
} from "../types.js";

const LIMITS = {
  candidates: 5,
  queryCharacters: 2_000,
  promptCharacters: 12_000,
  argumentKeys: 16,
  referenceKeys: 16,
  keyCharacters: 80,
  stringCharacters: 500,
  arrayItems: 10,
  arrayStringCharacters: 200,
  metadataItems: 6,
  metadataCharacters: 60,
  descriptionCharacters: 300,
  contractFields: 20,
  activeTaskEntityScan: 20,
  activeTaskEntities: 6,
  timeoutMs: 8_000,
  maxTimeoutMs: 30_000,
  maxDiagnosticDurationMs: 60_000
} as const;

const candidateReasonSchema = z.enum([
  "explicit_intent",
  "argument_evidence",
  "active_task_entity",
  "knowledge_metadata",
  "retrieval_evidence",
  "capability_hint"
]);
const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const boundedNumberSchema = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const boundedPrimitiveSchema = z.union([
  z.string().max(LIMITS.stringCharacters),
  boundedNumberSchema,
  z.boolean()
]);
const boundedArrayPrimitiveSchema = z.union([
  z.string().max(LIMITS.arrayStringCharacters),
  boundedNumberSchema,
  z.boolean()
]);
const boundedValueSchema = z.union([
  boundedPrimitiveSchema,
  z.array(boundedArrayPrimitiveSchema).max(LIMITS.arrayItems)
]);

function boundedRecordSchema(maxKeys: number): z.ZodType<Record<string, unknown>> {
  return z
    .record(z.string().min(1).max(LIMITS.keyCharacters), boundedValueSchema)
    .superRefine((record, context) => {
      if (Object.keys(record).length > maxKeys) {
        context.addIssue({ code: "custom", message: "too_many_keys" });
      }
    });
}

const proposalSchema = z
  .object({
    version: z.literal(1),
    disposition: z.enum(AGENT_PLAN_DISPOSITIONS),
    capability: z.enum(FUNCTION_NAMES).optional(),
    arguments: boundedRecordSchema(LIMITS.argumentKeys),
    references: boundedRecordSchema(LIMITS.referenceKeys).optional(),
    confidence: z.number().finite().min(0).max(1)
  })
  .strict();

export interface AgentPlannerCandidate {
  capability: FunctionName;
  reason: CapabilityCandidateReason;
  score: number;
  contract?: AgentCapabilityContract;
}

export interface AgentPlannerInput {
  profileName: string;
  text: string;
  candidates: readonly AgentPlannerCandidate[];
  activeTask?: ActiveTaskContext;
}

export interface AgentPlanner {
  propose(input: AgentPlannerInput): Promise<AgentPlannerResult>;
}

export interface CreateAgentPlannerOptions {
  primary: ChatProvider;
  fallback: ChatProvider;
  timeoutMs?: number;
}

interface CandidateSummary {
  capability: FunctionName;
  reason: CapabilityCandidateReason;
  score: number;
  contract?: {
    semanticDescription?: string;
    requiredSlots?: string[];
    responseFields?: string[];
    entityTypes?: string[];
    refinableFields?: string[];
    operations?: string[];
    ambiguity?: "clarify";
  };
}

interface ProviderAttempt {
  diagnostic: AgentPlannerAttemptDiagnostic;
  proposal?: AgentPlanProposal;
}

class PlannerTimeoutError extends Error {
  constructor() {
    super("planner_timeout");
    this.name = "PlannerTimeoutError";
  }
}

export function createAgentPlanner(options: CreateAgentPlannerOptions): AgentPlanner {
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  return {
    async propose(input): Promise<AgentPlannerResult> {
      const candidates = summarizeCandidates(input.candidates);
      if (candidates.length === 0) {
        return { status: "no_plan", reasonCode: "no_candidates", attempts: [] };
      }

      const text = sanitizeText(input.text, LIMITS.queryCharacters);
      const prompt = buildPrompt(candidates, input.activeTask);
      const request = {
        profileName: input.profileName,
        text,
        enabledFunctions: candidates.map(({ capability }) => capability),
        prompt
      };
      const candidateNames = new Set(request.enabledFunctions);
      const attempts: AgentPlannerAttemptDiagnostic[] = [];

      const primaryName = providerName(options.primary, input.profileName, "deepseek");
      const primaryAttempt = await attemptProvider({
        provider: options.primary,
        providerName: primaryName,
        request,
        candidateNames,
        candidateCount: candidates.length,
        timeoutMs
      });
      attempts.push(primaryAttempt.diagnostic);
      if (primaryAttempt.proposal) {
        return proposed(primaryAttempt.proposal, primaryName, attempts);
      }

      const fallbackName = providerName(options.fallback, input.profileName, "ollama");
      if (fallbackName !== primaryName) {
        const fallbackAttempt = await attemptProvider({
          provider: options.fallback,
          providerName: fallbackName,
          request,
          candidateNames,
          candidateCount: candidates.length,
          timeoutMs
        });
        attempts.push(fallbackAttempt.diagnostic);
        if (fallbackAttempt.proposal) {
          return proposed(fallbackAttempt.proposal, fallbackName, attempts);
        }
      }

      return {
        status: "no_plan",
        reasonCode: attempts.some(({ status }) => status === "invalid_output")
          ? "invalid_output"
          : "providers_unavailable",
        attempts
      };
    }
  };
}

function proposed(
  proposal: AgentPlanProposal,
  provider: ModelProviderName,
  attempts: AgentPlannerAttemptDiagnostic[]
): AgentPlannerResult {
  return {
    status: "proposed",
    ...proposal,
    provider,
    attempts
  };
}

async function attemptProvider(input: {
  provider: ChatProvider;
  providerName: ModelProviderName;
  request: {
    profileName: string;
    text: string;
    enabledFunctions: FunctionName[];
    prompt: string;
  };
  candidateNames: ReadonlySet<FunctionName>;
  candidateCount: number;
  timeoutMs: number;
}): Promise<ProviderAttempt> {
  const startedAt = performance.now();
  const controller = new AbortController();
  try {
    const raw = await withTimeout(
      input.provider.completeJson({ ...input.request, signal: controller.signal }),
      input.timeoutMs,
      controller
    );
    const parsed = parseProposal(raw, input.candidateNames);
    return {
      diagnostic: diagnostic(
        input.providerName,
        parsed.reason ? "invalid_output" : "accepted",
        parsed.reason ?? "valid_proposal",
        startedAt,
        input.candidateCount
      ),
      proposal: parsed.proposal
    };
  } catch (error) {
    const timeout = error instanceof PlannerTimeoutError;
    return {
      diagnostic: diagnostic(
        input.providerName,
        timeout ? "timeout" : "unavailable",
        timeout ? "timeout" : "provider_unavailable",
        startedAt,
        input.candidateCount
      )
    };
  }
}

function parseProposal(
  raw: string,
  candidateNames: ReadonlySet<FunctionName>
): { proposal?: AgentPlanProposal; reason?: AgentPlannerAttemptReason } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { reason: "invalid_json" };
  }
  if (hasReservedPlannerRecordKey(json)) {
    return { reason: "invalid_schema" };
  }
  const parsed = proposalSchema.safeParse(json);
  if (!parsed.success) {
    return { reason: "invalid_schema" };
  }
  if (parsed.data.capability && !candidateNames.has(parsed.data.capability)) {
    return { reason: "candidate_not_allowed" };
  }
  return { proposal: parsed.data as AgentPlanProposal };
}

function hasReservedPlannerRecordKey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  return [proposal.arguments, proposal.references].some(
    (record) =>
      record !== undefined &&
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      Object.keys(record).some((key) =>
        RESERVED_RECORD_KEYS.has(key.normalize("NFKC").toLocaleLowerCase("en-US"))
      )
  );
}

function diagnostic(
  provider: ModelProviderName,
  status: AgentPlannerAttemptDiagnostic["status"],
  reason: AgentPlannerAttemptReason,
  startedAt: number,
  candidateCount: number
): AgentPlannerAttemptDiagnostic {
  return {
    provider,
    status,
    reason,
    durationMs: Math.min(
      LIMITS.maxDiagnosticDurationMs,
      Math.max(0, Math.round(performance.now() - startedAt))
    ),
    candidateCount: Math.min(LIMITS.candidates, Math.max(0, candidateCount))
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new PlannerTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function providerName(
  provider: ChatProvider,
  profileName: string,
  defaultName: ModelProviderName
): ModelProviderName {
  try {
    return provider.providerNameForProfile?.(profileName) ?? provider.providerName ?? defaultName;
  } catch {
    return defaultName;
  }
}

function summarizeCandidates(candidates: readonly AgentPlannerCandidate[]): CandidateSummary[] {
  const summaries: CandidateSummary[] = [];
  const seen = new Set<FunctionName>();
  for (const candidate of candidates) {
    if (
      summaries.length >= LIMITS.candidates ||
      !isFunctionName(candidate.capability) ||
      seen.has(candidate.capability) ||
      !candidateReasonSchema.safeParse(candidate.reason).success ||
      !Number.isFinite(candidate.score)
    ) {
      continue;
    }
    seen.add(candidate.capability);
    const contract = summarizeContract(candidate.capability, candidate.contract);
    summaries.push({
      capability: candidate.capability,
      reason: candidate.reason,
      score: Math.max(-1_000_000_000, Math.min(1_000_000_000, candidate.score)),
      ...(contract ? { contract } : {})
    });
  }
  return summaries;
}

function summarizeContract(
  capability: FunctionName,
  contract: AgentCapabilityContract | undefined
): CandidateSummary["contract"] {
  if (!contract) return undefined;
  const summary: NonNullable<CandidateSummary["contract"]> = {};
  const semanticDescription = sanitizeText(
    contract.semanticDescription ?? "",
    LIMITS.descriptionCharacters
  );
  const requiredSlots = getFunctionDefinition(capability)
    ?.requiredSlots.slice(0, LIMITS.contractFields)
    .map(({ name }) => sanitizeText(name, LIMITS.metadataCharacters))
    .filter(Boolean);
  const responseFields = Object.keys(contract.responseProjection?.fields ?? {})
    .slice(0, LIMITS.contractFields)
    .map((field) => sanitizeText(field, LIMITS.metadataCharacters))
    .filter(Boolean);
  const entityTypes = summarizeMetadata(contract.entityTypes);
  const refinableFields = summarizeMetadata(contract.refinableFields);
  const operations = summarizeMetadata(contract.operations);
  if (semanticDescription) summary.semanticDescription = semanticDescription;
  if (requiredSlots?.length) summary.requiredSlots = requiredSlots;
  if (responseFields.length) summary.responseFields = responseFields;
  if (entityTypes.length > 0) summary.entityTypes = entityTypes;
  if (refinableFields.length > 0) summary.refinableFields = refinableFields;
  if (operations.length > 0) summary.operations = operations;
  if (contract.ambiguity === "clarify") summary.ambiguity = "clarify";
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizeMetadata(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .slice(0, LIMITS.metadataItems)
    .map((value) => sanitizeText(value, LIMITS.metadataCharacters))
    .filter(Boolean);
}

function summarizeActiveTask(
  activeTask: ActiveTaskContext | undefined,
  candidates: readonly CandidateSummary[]
): unknown {
  if (!activeTask) return undefined;
  const candidate = candidates.find(({ capability }) => capability === activeTask.capability);
  if (!candidate) return undefined;

  const summary: {
    version: 2;
    capability: FunctionName;
    supportedOperations?: string[];
    entities?: Array<{ ref: string; type: string }>;
  } = {
    version: activeTask.version,
    capability: activeTask.capability
  };
  const declaredOperations = declaredCategoricalValues(candidate.contract?.operations);
  const supportedOperations = uniqueDeclaredMatches(
    activeTask.supportedOperations,
    declaredOperations
  );
  if (supportedOperations.length > 0) summary.supportedOperations = supportedOperations;

  const declaredEntityTypes = declaredCategoricalValues(candidate.contract?.entityTypes);
  const entities: Array<{ ref: string; type: string }> = [];
  for (const entity of activeTask.entities.slice(0, LIMITS.activeTaskEntityScan)) {
    const safeType = declaredEntityTypes.get(normalizeCategoricalValue(entity.type));
    if (!safeType) continue;
    entities.push({ ref: `entity-${entities.length + 1}`, type: safeType });
    if (entities.length >= LIMITS.activeTaskEntities) break;
  }
  if (entities.length > 0) summary.entities = entities;
  return summary;
}

function declaredCategoricalValues(values: readonly string[] | undefined): Map<string, string> {
  return new Map(
    (values ?? [])
      .slice(0, LIMITS.metadataItems)
      .map((value) => sanitizeText(value, LIMITS.metadataCharacters))
      .filter(Boolean)
      .map((value) => [normalizeCategoricalValue(value), value])
  );
}

function uniqueDeclaredMatches(
  values: readonly string[],
  declared: ReadonlyMap<string, string>
): string[] {
  const matches: string[] = [];
  for (const value of values) {
    const safeValue = declared.get(normalizeCategoricalValue(value));
    if (safeValue && !matches.includes(safeValue)) matches.push(safeValue);
    if (matches.length >= LIMITS.metadataItems) break;
  }
  return matches;
}

function normalizeCategoricalValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function buildPrompt(
  candidates: readonly CandidateSummary[],
  activeTask: ActiveTaskContext | undefined
): string {
  const activeTaskSummary = summarizeActiveTask(activeTask, candidates);
  const prompt = [
    "You are a constrained semantic planner for a restricted LINE bot.",
    "Return exactly one JSON object matching schema version 1. No prose, markdown, code fences, or trailing text.",
    "Candidate actions are the only permitted functions. Never invent or expand a capability.",
    "Current-message evidence overrides active-task context.",
    "Ambiguity requires disposition clarify.",
    "Write actions are unavailable unless deterministic candidates include them.",
    `Allowed dispositions: ${AGENT_PLAN_DISPOSITIONS.join("|")}.`,
    'Required JSON: {"version":1,"disposition":"...","capability":"candidate function name or omit","arguments":{},"references":{},"confidence":0.0}.',
    `Candidate summaries: ${JSON.stringify(candidates)}`,
    `Active-task summary: ${activeTaskSummary ? JSON.stringify(activeTaskSummary) : "none"}`
  ].join("\n");
  return Array.from(prompt).slice(0, LIMITS.promptCharacters).join("");
}

function sanitizeText(value: string, maxCharacters: number): string {
  const withoutControlCharacters = Array.from(value.normalize("NFKC"))
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127
        ? " "
        : character;
    })
    .join("");
  const sanitized = withoutControlCharacters
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, "[redacted-url]")
    .replace(
      /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[bp]-)[A-Za-z0-9_-]{12,}\b/gu,
      "[redacted-secret]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/giu, "[redacted-secret]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[redacted-secret]"
    );
  return Array.from(sanitized).slice(0, maxCharacters).join("");
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return LIMITS.timeoutMs;
  return Math.min(LIMITS.maxTimeoutMs, Math.max(1, Math.floor(value)));
}
