import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  RedisConversationWindowStore,
  type ConversationWindowScope
} from "../../../agent/context-manager.js";
import {
  RedisAgentTraceStore,
  type AgentTurnTraceRecord,
  type AgentTurnTraceStep
} from "../../../agent/trace-store.js";
import { createRedisRuntime } from "../../../redis.js";
import { FUNCTION_NAMES } from "../../../types.js";
import {
  RedisKernelLocalLiveChannel,
  type KernelLocalLiveObservation,
  type KernelLocalLiveRedisClient
} from "../../../testing/kernel-local-live/redis-channel.js";
import {
  KERNEL_LOCAL_LIVE_CASES,
  selectKernelLocalLiveCases,
  validateKernelLocalLiveCost
} from "./cases.js";
import type { KernelLocalLiveCaseId } from "./contracts.js";
import { selectKernelLocalLiveJourneys } from "./journeys.js";
import {
  createKernelLocalLiveReport,
  type KernelLocalLiveCaseReport,
  type KernelLocalLiveReport
} from "./report.js";
import { createSignedLineWebhook } from "./webhook.js";

export interface KernelLocalLiveSuiteResult {
  schemaVersion: 1;
  caseSetVersion: 1;
  startedAt: string;
  completedAt: string;
  commit: string;
  selectedCaseIds: KernelLocalLiveCaseId[];
  passed: boolean;
  cases: KernelLocalLiveCaseReport[];
  providers: {
    deepSeekRequests: number;
    embeddingBatches: number;
  };
  cleanup: {
    namespace: boolean;
  };
  infrastructureFailureCode?: KernelLocalLiveInfrastructureFailureCode;
}

export type KernelLocalLiveInfrastructureFailureCode =
  | "app_unhealthy"
  | "invalid_signature_failed"
  | "webhook_failed"
  | "webhook_ack_invalid"
  | "reply_missing"
  | "duplicate_failed"
  | "duplicate_reply_detected"
  | "dependency_unavailable";

const SUITE_RESULT_KEYS = new Set([
  "schemaVersion",
  "caseSetVersion",
  "startedAt",
  "completedAt",
  "commit",
  "selectedCaseIds",
  "passed",
  "cases",
  "providers",
  "cleanup",
  "infrastructureFailureCode"
]);
const SUITE_CLEANUP_KEYS = new Set(["namespace"]);

type InternalCaseReport = KernelLocalLiveCaseReport & {
  providerCounts?: { deepseek: number; azure_openai: number };
};

export async function runKernelLocalLiveDriver(
  environment: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<0 | 1 | 2> {
  const startedAt = new Date().toISOString();
  const runId = requiredRunId(environment.KERNEL_LOCAL_LIVE_RUN_ID);
  const commit = requiredCommit(environment.KERNEL_LOCAL_LIVE_COMMIT);
  const appBaseUrl = requiredLocalAppUrl(environment.KERNEL_LOCAL_LIVE_APP_URL);
  const redisUrl = requiredLocalRedisUrl(environment.KERNEL_LOCAL_LIVE_REDIS_URL);
  const selectedCases = selectKernelLocalLiveCases(
    environment.KERNEL_LOCAL_LIVE_CASE_ID?.trim() || undefined
  );
  const selectedJourneys = selectKernelLocalLiveJourneys(
    environment.KERNEL_LOCAL_LIVE_CASE_ID?.trim() || undefined
  );
  const limits = validateKernelLocalLiveCost(selectedCases);
  const keyPrefix = `kernel-local-live:${runId}`;
  const redis = await createRedisRuntime(
    { url: redisUrl, keyPrefix },
    { onError: () => undefined }
  );
  if (!redis) return 2;
  const channel = new RedisKernelLocalLiveChannel(
    redis.client as unknown as KernelLocalLiveRedisClient,
    runId
  );
  const traceStore = new RedisAgentTraceStore({
    client: redis.client,
    keyPrefix,
    maxEntries: 100
  });
  const conversationStore = new RedisConversationWindowStore({
    client: redis.client,
    keyPrefix
  });
  const caseReports: InternalCaseReport[] = [];
  let namespaceCleanup = false;
  let infrastructureFailure = false;
  let infrastructureFailureCode: KernelLocalLiveInfrastructureFailureCode | undefined;

  try {
    const health = await fetchImpl(new URL("/healthz", appBaseUrl));
    if (!health.ok) throw new Error("kernel_local_live_app_unhealthy");
    let entranceChecked = false;
    for (const journey of selectedJourneys) {
      if (journey.caseId === "group-requester-isolation") {
        await seedRequesterAActiveTask(conversationStore);
      }
      const traces: AgentTurnTraceRecord[] = [];
      const replyQuickReplyLabels: string[][] = [];
      let preFinalQueueDetected = false;
      for (const turn of journey.turns) {
        const request = createSignedLineWebhook(turn, "kernel-local-live-channel-secret");
        if (!entranceChecked) {
          await assertInvalidSignature(fetchImpl, appBaseUrl, request.body);
        }
        await traceStore.clear();
        const response = await fetchImpl(new URL("/api/line/webhook/acceptance", appBaseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-line-signature": request.signature
          },
          body: request.body
        });
        if (!response.ok) throw new Error("kernel_local_live_webhook_failed");
        const acknowledgement = (await response.json()) as {
          ok?: unknown;
          allowedEvents?: unknown;
        };
        if (acknowledgement.ok !== true || acknowledgement.allowedEvents !== 1) {
          throw new Error("kernel_local_live_webhook_ack_invalid");
        }
        const captured = await channel.readReply(request.replyToken);
        if (!captured) throw new Error("kernel_local_live_reply_missing");
        replyQuickReplyLabels.push(captured.quickReplyLabels);
        traces.push(...(await traceStore.list(1)));
        const currentObservations = await channel.readObservations();
        if (
          journey.caseId === "write-preview-confirm" &&
          turn.turnIndex < journey.turns.length - 1 &&
          currentObservations.some(
            ({ caseId, kind, outcome }) =>
              caseId === journey.caseId && kind === "queue" && outcome === "queued"
          )
        ) {
          preFinalQueueDetected = true;
        }
        if (
          currentObservations.some(
            ({ caseId, kind, outcome }) =>
              caseId === journey.caseId &&
              kind === "provider" &&
              (outcome === "failed" || outcome === "budget_exhausted")
          )
        ) {
          break;
        }
        if (!entranceChecked) {
          await assertDuplicate(fetchImpl, appBaseUrl, request, channel);
          entranceChecked = true;
        }
      }
      const observations = await channel.readObservations();
      const result = evaluateKernelLocalLiveOutcome({
        caseId: journey.caseId,
        traces,
        observations,
        replyQuickReplyLabels,
        preFinalQueueDetected
      });
      caseReports.push(result);
      if (!result.passed) break;
    }
  } catch (error) {
    infrastructureFailure = true;
    infrastructureFailureCode = classifyKernelLocalLiveInfrastructureFailure(error);
  } finally {
    try {
      await channel.cleanup();
      namespaceCleanup = await namespaceIsEmpty(
        redis.client as unknown as KernelLocalLiveRedisClient,
        keyPrefix
      );
    } catch {
      namespaceCleanup = false;
    }
    await redis.close().catch(() => undefined);
  }

  // Provider counts are copied into case evidence before namespace cleanup by the app observations.
  // Reconstruct them from a bounded sidecar supplied by evaluateKernelLocalLiveOutcome.
  const deepSeekRequests = caseReports.reduce(
    (sum, entry) => sum + providerCount(entry, "deepseek"),
    0
  );
  const embeddingBatches = caseReports.reduce(
    (sum, entry) => sum + providerCount(entry, "azure_openai"),
    0
  );
  const allSelectedRan = caseReports.length === selectedJourneys.length;
  const passed =
    !infrastructureFailure &&
    allSelectedRan &&
    caseReports.every(({ passed }) => passed) &&
    deepSeekRequests <= limits.deepSeekMax &&
    embeddingBatches <= limits.embeddingBatchMax &&
    namespaceCleanup;
  const suiteResult: KernelLocalLiveSuiteResult = {
    schemaVersion: 1,
    caseSetVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    commit,
    selectedCaseIds: selectedCases.map(({ id }) => id as KernelLocalLiveCaseId),
    passed,
    cases: caseReports.map(stripInternalProviderCounts),
    providers: { deepSeekRequests, embeddingBatches },
    cleanup: { namespace: namespaceCleanup },
    ...(infrastructureFailureCode ? { infrastructureFailureCode } : {})
  };
  await writeSuiteResult(suiteResult, environment.KERNEL_LOCAL_LIVE_ARTIFACT_ROOT ?? "/app");
  return infrastructureFailure ? 2 : passed ? 0 : 1;
}

export function classifyKernelLocalLiveInfrastructureFailure(
  error: unknown
): KernelLocalLiveInfrastructureFailureCode {
  const code =
    error instanceof Error
      ? SAFE_INFRASTRUCTURE_FAILURES[error.message as keyof typeof SAFE_INFRASTRUCTURE_FAILURES]
      : undefined;
  return code ?? "dependency_unavailable";
}

const SAFE_INFRASTRUCTURE_FAILURES = {
  kernel_local_live_app_unhealthy: "app_unhealthy",
  kernel_local_live_invalid_signature_failed: "invalid_signature_failed",
  kernel_local_live_webhook_failed: "webhook_failed",
  kernel_local_live_webhook_ack_invalid: "webhook_ack_invalid",
  kernel_local_live_reply_missing: "reply_missing",
  kernel_local_live_duplicate_failed: "duplicate_failed",
  kernel_local_live_duplicate_reply_detected: "duplicate_reply_detected"
} as const;

export function evaluateKernelLocalLiveOutcome(input: {
  caseId: KernelLocalLiveCaseId;
  traces: AgentTurnTraceRecord[];
  observations: KernelLocalLiveObservation[];
  replyQuickReplyLabels?: string[][];
  preFinalQueueDetected?: boolean;
}): InternalCaseReport {
  const steps = input.traces.flatMap(({ steps }) => steps);
  const disposition = lastValue(steps, "disposition");
  const capability =
    lastValue(steps, "action") ??
    (input.caseId === "write-preview-confirm" ? "save_resource" : undefined);
  const validatorReason = lastValue(steps, "validatorReason");
  const resultClass = lastValue(steps, "resultStatus");
  const lifecycleOutcome = lastValue(steps, "lifecycleOutcome");
  const caseObservations = input.observations.filter(({ caseId }) => caseId === input.caseId);
  const providerCounts = {
    deepseek: caseObservations.filter(
      ({ kind, provider, outcome }) =>
        kind === "provider" && provider === "deepseek" && outcome === "success"
    ).length,
    azure_openai: caseObservations.filter(
      ({ kind, provider, outcome }) =>
        kind === "provider" && provider === "azure_openai" && outcome === "success"
    ).length
  };
  const evidence = {
    steps,
    disposition,
    capability,
    validatorReason,
    resultClass,
    lifecycleOutcome,
    caseObservations,
    providerCounts,
    turns: input.traces.map(({ steps: turnSteps }) => turnEvidence(turnSteps)),
    replyQuickReplyLabels: input.replyQuickReplyLabels ?? [],
    preFinalQueueDetected: input.preFinalQueueDetected === true
  };
  const passed = outcomePassed(input.caseId, evidence);
  return {
    caseId: input.caseId,
    passed,
    ...(passed ? {} : { failureCode: outcomeFailureCode(input.caseId, evidence) }),
    ...(disposition ? { disposition } : {}),
    ...(capability && FUNCTION_NAMES.includes(capability as (typeof FUNCTION_NAMES)[number])
      ? { capability }
      : {}),
    ...(validatorReason ? { validatorReason } : {}),
    ...(resultClass ? { resultClass } : {}),
    ...(lifecycleOutcome ? { lifecycleOutcome } : {}),
    providerCounts
  };
}

function outcomeFailureCode(
  caseId: KernelLocalLiveCaseId,
  evidence: Parameters<typeof outcomePassed>[1]
): string {
  if (caseId !== "schedule-refinement") return "journey_assertion_failed";
  const declaredCase = KERNEL_LOCAL_LIVE_CASES.find(({ id }) => id === caseId)!;
  if (
    evidence.caseObservations.some(
      ({ kind, outcome }) => kind === "provider" && outcome !== "success"
    ) ||
    evidence.providerCounts.deepseek !== declaredCase.deepSeekMax ||
    evidence.providerCounts.azure_openai !== declaredCase.embeddingBatchMax
  ) {
    return "provider_evidence_failed";
  }
  if (evidence.turns.length !== 2) return "turn_count_failed";
  if (!turnSucceeded(evidence.turns[0], "query_schedule")) return "initial_turn_failed";
  if (!turnSucceeded(evidence.turns[1], "query_schedule")) return "continuation_turn_failed";
  if (evidence.turns[1]?.validatorReason !== "active_task_refinement") {
    return "continuation_reason_failed";
  }
  return "journey_assertion_failed";
}

export function finalizeKernelLocalLiveSuiteResult(
  input: unknown,
  cleanup: { compose: boolean; secretFiles: boolean }
): KernelLocalLiveReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("kernel_local_live_suite_result_invalid");
  }
  const suite = input as Record<string, unknown>;
  if (
    Object.keys(suite).some((key) => !SUITE_RESULT_KEYS.has(key)) ||
    suite.schemaVersion !== 1 ||
    suite.caseSetVersion !== 1 ||
    !suite.cleanup ||
    typeof suite.cleanup !== "object" ||
    Array.isArray(suite.cleanup)
  ) {
    throw new Error("kernel_local_live_suite_result_invalid");
  }
  const suiteCleanup = suite.cleanup as Record<string, unknown>;
  if (
    Object.keys(suiteCleanup).some((key) => !SUITE_CLEANUP_KEYS.has(key)) ||
    typeof suiteCleanup.namespace !== "boolean"
  ) {
    throw new Error("kernel_local_live_suite_result_invalid");
  }
  const cleanupPassed =
    suiteCleanup.namespace && cleanup.compose === true && cleanup.secretFiles === true;
  return createKernelLocalLiveReport({
    startedAt: suite.startedAt,
    completedAt: suite.completedAt,
    commit: suite.commit,
    selectedCaseIds: suite.selectedCaseIds,
    passed: suite.passed === true && cleanupPassed,
    cases: suite.cases,
    providers: suite.providers,
    cleanup: {
      namespace: suiteCleanup.namespace,
      compose: cleanup.compose,
      secretFiles: cleanup.secretFiles,
      passed: cleanupPassed
    }
  });
}

function outcomePassed(
  caseId: KernelLocalLiveCaseId,
  evidence: {
    steps: AgentTurnTraceStep[];
    disposition?: string;
    capability?: string;
    validatorReason?: string;
    resultClass?: string;
    lifecycleOutcome?: string;
    caseObservations: KernelLocalLiveObservation[];
    providerCounts: { deepseek: number; azure_openai: number };
    turns: ReturnType<typeof turnEvidence>[];
    replyQuickReplyLabels: string[][];
    preFinalQueueDetected: boolean;
  }
): boolean {
  const declaredCase = KERNEL_LOCAL_LIVE_CASES.find(({ id }) => id === caseId)!;
  if (
    evidence.caseObservations.some(
      ({ kind, outcome }) => kind === "provider" && outcome !== "success"
    ) ||
    evidence.providerCounts.deepseek !== declaredCase.deepSeekMax ||
    evidence.providerCounts.azure_openai !== declaredCase.embeddingBatchMax
  ) {
    return false;
  }
  switch (caseId) {
    case "schedule-explicit":
      return evidence.turns.length === 1 && turnSucceeded(evidence.turns[0], "query_schedule");
    case "schedule-refinement":
      return (
        evidence.turns.length === 2 &&
        turnSucceeded(evidence.turns[0], "query_schedule") &&
        turnSucceeded(evidence.turns[1], "query_schedule") &&
        evidence.turns[1]?.validatorReason === "active_task_refinement"
      );
    case "schedule-ambiguity":
      return (
        evidence.turns.length === 1 &&
        (evidence.disposition === "collect" || evidence.resultClass === "ambiguous")
      );
    case "capability-switch":
      return (
        evidence.turns.length === 2 &&
        turnSucceeded(evidence.turns[0], "query_schedule") &&
        turnSucceeded(evidence.turns[1], "query_knowledge") &&
        (evidence.turns[1]?.validatorReason === "explicit_capability_switch" ||
          evidence.turns[1]?.validatorReason === "explicit_intent")
      );
    case "knowledge-follow-up":
      return (
        evidence.turns.length === 2 &&
        turnSucceeded(evidence.turns[0], "query_knowledge") &&
        turnSucceeded(evidence.turns[1], "query_knowledge") &&
        evidence.turns[1]?.validatorReason === "active_task_refinement" &&
        evidence.providerCounts.azure_openai === 2
      );
    case "group-requester-isolation":
      return (
        evidence.turns.length === 1 &&
        evidence.steps.some(
          ({ phase, outcome }) => phase === "active_task" && outcome === "missing"
        ) &&
        evidence.capability === "query_schedule" &&
        evidence.validatorReason === "explicit_intent" &&
        evidence.resultClass === "success" &&
        !evidence.steps.some(
          ({ phase, validatorReason }) =>
            phase === "plan_validation" && validatorReason === "active_task_refinement"
        )
      );
    case "provider-unavailable":
      return (
        evidence.turns.length === 1 &&
        evidence.validatorReason === "planner_unavailable" &&
        evidence.providerCounts.deepseek === 0
      );
    case "write-preview-confirm":
      return (
        evidence.caseObservations.filter(
          ({ kind, outcome }) => kind === "queue" && outcome === "queued"
        ).length === 1 &&
        evidence.caseObservations.filter(
          ({ kind, outcome }) => kind === "scan_work" && outcome === "queued"
        ).length === 1 &&
        evidence.turns.length === 5 &&
        evidence.turns.every(({ steps }) => steps.length > 0) &&
        matchesWriteReplyStates(evidence.replyQuickReplyLabels) &&
        !evidence.preFinalQueueDetected
      );
  }
}

function matchesWriteReplyStates(labels: string[][]): boolean {
  return (
    labels.length === 5 &&
    sameLabels(labels[0], ["是", "否"]) &&
    sameLabels(labels[1], ["投影片", "流行歌譜", "詩歌歌譜", "小哈資料庫"]) &&
    sameLabels(labels[2], []) &&
    sameLabels(labels[3], ["保存", "取消"]) &&
    sameLabels(labels[4], ["查看結果"])
  );
}

function sameLabels(actual: string[] | undefined, expected: string[]): boolean {
  return (
    actual?.length === expected.length && actual.every((label, index) => label === expected[index])
  );
}

function turnEvidence(steps: AgentTurnTraceStep[]) {
  return {
    steps,
    capability: lastValue(steps, "action"),
    validatorReason: lastValue(steps, "validatorReason"),
    resultClass: lastValue(steps, "resultStatus")
  };
}

function turnSucceeded(
  turn: ReturnType<typeof turnEvidence> | undefined,
  capability: string
): boolean {
  return turn?.capability === capability && turn.resultClass === "success";
}

async function assertInvalidSignature(
  fetchImpl: typeof fetch,
  appBaseUrl: URL,
  body: Buffer
): Promise<void> {
  const response = await fetchImpl(new URL("/api/line/webhook/acceptance", appBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-line-signature": "invalid-signature"
    },
    body
  });
  if (response.status !== 401) throw new Error("kernel_local_live_invalid_signature_failed");
}

async function assertDuplicate(
  fetchImpl: typeof fetch,
  appBaseUrl: URL,
  request: ReturnType<typeof createSignedLineWebhook>,
  channel: RedisKernelLocalLiveChannel
): Promise<void> {
  const response = await fetchImpl(new URL("/api/line/webhook/acceptance", appBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-line-signature": request.signature
    },
    body: request.body
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok || !isKernelLocalLiveDuplicateAcknowledgement(payload)) {
    throw new Error("kernel_local_live_duplicate_failed");
  }
  if (await channel.readReply(request.replyToken)) {
    throw new Error("kernel_local_live_duplicate_reply_detected");
  }
}

export function isKernelLocalLiveDuplicateAcknowledgement(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    value.ok === true && value.allowedEvents === 1 && value.ignored === "duplicate_webhook_event"
  );
}

async function seedRequesterAActiveTask(store: RedisConversationWindowStore): Promise<void> {
  const now = new Date();
  const scope: ConversationWindowScope = {
    profileName: "acceptance",
    sourceKey: "group:G_KERNEL_GROUP",
    requesterUserId: "U_KERNEL_USER_A"
  };
  await store.recordActiveTask({
    scope,
    ttlMs: 600_000,
    task: {
      version: 2,
      currentCapability: "query_schedule",
      allowedCapabilities: ["query_schedule"],
      anchors: { role: "Projection" },
      entities: [{ type: "role", key: "projection", label: "Projection" }],
      supportedOperations: ["continue", "refine"],
      responseContext: {
        availableFields: ["date", "meeting", "role"],
        defaultProjection: "focused"
      },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString()
    }
  });
}

async function namespaceIsEmpty(
  client: KernelLocalLiveRedisClient,
  keyPrefix: string
): Promise<boolean> {
  for await (const batch of client.scanIterator({ MATCH: `${keyPrefix}:*` })) {
    if (batch.length > 0) return false;
  }
  return true;
}

function lastValue<K extends keyof AgentTurnTraceStep>(
  steps: AgentTurnTraceStep[],
  key: K
): AgentTurnTraceStep[K] | undefined {
  return [...steps].reverse().find((step) => step[key] !== undefined)?.[key];
}

function providerCount(
  report: KernelLocalLiveCaseReport,
  provider: "deepseek" | "azure_openai"
): number {
  return (report as InternalCaseReport).providerCounts?.[provider] ?? 0;
}

function stripInternalProviderCounts(report: InternalCaseReport): KernelLocalLiveCaseReport {
  const safe = { ...report };
  delete safe.providerCounts;
  return safe;
}

async function writeSuiteResult(result: KernelLocalLiveSuiteResult, root: string): Promise<void> {
  const directory = path.join(root, "artifacts/kernel-v1");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "local-live-suite-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function requiredRunId(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate || !/^[a-z0-9-]{1,64}$/u.test(candidate)) {
    throw new Error("kernel_local_live_run_id_invalid");
  }
  return candidate;
}

function requiredCommit(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate || !/^[a-f0-9]{40}$/u.test(candidate)) {
    throw new Error("kernel_local_live_commit_invalid");
  }
  return candidate;
}

function requiredLocalAppUrl(value: string | undefined): URL {
  const url = new URL(value ?? "");
  if (
    url.protocol !== "http:" ||
    url.hostname !== "acceptance-app" ||
    url.port !== "3000" ||
    url.pathname !== "/"
  ) {
    throw new Error("kernel_local_live_app_url_invalid");
  }
  return url;
}

function requiredLocalRedisUrl(value: string | undefined): string {
  const url = new URL(value ?? "");
  if (
    url.protocol !== "redis:" ||
    url.hostname !== "redis" ||
    url.port !== "6379" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("kernel_local_live_redis_url_invalid");
  }
  return url.toString();
}
