import { randomUUID } from "node:crypto";

import { Command } from "@langchain/langgraph";
import type { HITLRequest } from "langchain";

import { buildAgentJobScope, type AgentJobStore } from "../agent/jobs.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import { emitProductEvent } from "../observability/product-events.js";
import type { RouteObserver } from "../application/contracts/routing.js";
import { hashReviewArguments, type ActionExecution } from "../runtime/action-executor.js";
import type {
  ActionReviewSession,
  HelperWriteToolName,
  SessionStore
} from "../state/session-store.js";
import type { FunctionExecutionResult, JsonRecord, LineSource } from "../types.js";

const REVIEW_TTL_MS = 5 * 60_000;
const DEFAULT_RESULT_TTL_MS = 30 * 60_000;
const helperWriteTools = new Set<HelperWriteToolName>([
  "propose_save_schedule",
  "propose_save_memory",
  "propose_save_resource"
]);

interface InterruptState {
  __interrupt__?: Array<{ id?: string; value?: HITLRequest }>;
}

export type ReviewResult =
  | {
      status: "review";
      reviewId: string;
      argumentsHash: string;
      result: FunctionExecutionResult;
    }
  | { status: "approved"; result: FunctionExecutionResult }
  | { status: "rejected"; state: unknown }
  | { status: "denied" };

export interface CreateActionReviewInput {
  state: unknown;
  sessions: SessionStore;
  jobs: AgentJobStore;
  profileName: string;
  source: LineSource;
  requesterUserId: string;
  threadId: string;
  policyKey: string;
  preview(toolName: HelperWriteToolName, args: JsonRecord): Promise<string | undefined>;
  now?: Date;
  idFactory?: () => string;
  resultTtlMs?: number;
}

export async function createActionReview(input: CreateActionReviewInput): Promise<ReviewResult> {
  const interrupt = (input.state as InterruptState).__interrupt__?.[0];
  const requests = interrupt?.value?.actionRequests;
  if (!interrupt?.id || requests?.length !== 1) return { status: "denied" };
  const request = requests[0];
  if (!helperWriteTools.has(request.name as HelperWriteToolName)) return { status: "denied" };
  const toolName = request.name as HelperWriteToolName;
  const args = request.args as JsonRecord;
  const preview = await input.preview(toolName, args);
  if (!preview) return { status: "denied" };
  const scope = buildAgentJobScope(input.profileName, input.source);
  if (!scope || scope.requesterUserId !== input.requesterUserId) return { status: "denied" };
  const capability = capabilityFor(toolName);
  const job = await input.jobs.createPending({
    scope,
    capability,
    label: "action-review",
    ttlMs: Math.max(input.resultTtlMs ?? 0, DEFAULT_RESULT_TTL_MS)
  });
  const id = (input.idFactory ?? randomUUID)();
  const argumentsHash = hashReviewArguments(args);
  const review: ActionReviewSession = {
    id,
    type: "action_review",
    profileName: input.profileName,
    requesterUserId: input.requesterUserId,
    source: input.source,
    threadId: input.threadId,
    interruptId: interrupt.id,
    toolName,
    argumentsHash,
    policyKey: input.policyKey,
    resultJobId: job.id,
    expiresAt: new Date((input.now ?? new Date()).getTime() + REVIEW_TTL_MS).toISOString()
  };
  try {
    await input.sessions.set(review);
  } catch (error) {
    await input.jobs.fail(job.id, "review_state_unavailable");
    throw error;
  }
  return {
    status: "review",
    reviewId: id,
    argumentsHash,
    result: {
      ok: true,
      executedAction: capabilityFor(toolName),
      writePhase: "preview",
      replyText: preview,
      quickReplies: [
        buildPostbackQuickReply("確認", reviewPostbackData(id, "approve", job.id), "確認"),
        buildPostbackQuickReply("取消", reviewPostbackData(id, "reject", job.id), "取消")
      ]
    }
  };
}

export interface ResumeHelperReviewInput {
  sessions: SessionStore;
  jobs: AgentJobStore;
  reviewId: string;
  profileName: string;
  source: LineSource;
  requesterUserId: string;
  text: string;
  agent: { invoke(input: unknown, config: unknown): Promise<unknown> };
  policyKey?: string;
  preview?: CreateActionReviewInput["preview"];
  now?: Date;
  idFactory?: () => string;
  resultTtlMs?: number;
  getExecutionOutcome?: () => ActionExecution | undefined;
  onLifecycle?: ActionReviewLifecycleObserver;
}

export type ActionReviewLifecycleStatus =
  "approved" | "rejected" | "expired_or_missing" | "execution_denied" | "unavailable";

export type ActionReviewLifecycleObserver = (event: {
  status: ActionReviewLifecycleStatus;
  action?: FunctionExecutionResult["executedAction"];
}) => void | Promise<void>;

export function createActionReviewLifecycleObserver(input: {
  routeObserver?: RouteObserver;
  requestId: string;
  profileName: string;
  source: LineSource;
  hmacKey?: string;
}): ActionReviewLifecycleObserver {
  return ({ status, action }) =>
    emitProductEvent(input.routeObserver, {
      eventName: status === "approved" ? "write_committed" : "write_previewed",
      requestId: input.requestId,
      profileName: input.profileName,
      source: input.source,
      hmacKey: input.hmacKey,
      action,
      resultClass: status === "approved" || status === "rejected" ? "success" : "unavailable",
      finalStatus: `review_${status}`
    });
}

export async function resumeHelperReview(input: ResumeHelperReviewInput): Promise<ReviewResult> {
  const review = await input.sessions.takeActionReview({
    id: input.reviewId,
    profileName: input.profileName,
    source: input.source,
    requesterUserId: input.requesterUserId
  });
  if (!review?.threadId) {
    await observe(input.onLifecycle, { status: "expired_or_missing" });
    return { status: "denied" };
  }
  const normalized = input.text.trim();
  const approve = normalized === "確認";
  const reject = normalized === "取消";
  if (!approve) {
    await failPendingResult(
      input.jobs,
      review,
      input.source,
      reject ? "review_rejected" : "review_revised"
    );
  }
  let state: unknown;
  try {
    state = await input.agent.invoke(
      new Command({
        resume: {
          decisions: [
            approve
              ? { type: "approve" as const }
              : {
                  type: "reject" as const,
                  message: reject ? "使用者取消這次操作。" : normalized
                }
          ]
        }
      }),
      { configurable: { thread_id: review.threadId } }
    );
  } catch (error) {
    const completed = await completedResult(input.jobs, review, input.source);
    if (completed?.status === "completed" && completed.result) {
      await observe(input.onLifecycle, {
        status: "approved",
        action: capabilityFor(review.toolName)
      });
      return { status: "approved", result: completed.result };
    }
    await failPendingResult(input.jobs, review, input.source, "review_unavailable");
    await observe(input.onLifecycle, {
      status: "unavailable",
      action: capabilityFor(review.toolName)
    });
    throw error;
  }
  if (approve) {
    const outcome = input.getExecutionOutcome?.();
    if (outcome?.status === "approved") {
      await observe(input.onLifecycle, {
        status: "approved",
        action: capabilityFor(review.toolName)
      });
      return { status: "approved", result: outcome.result };
    }
    const status = outcome?.status === "unavailable" ? "unavailable" : "execution_denied";
    await failPendingResult(input.jobs, review, input.source, status);
    await observe(input.onLifecycle, { status, action: capabilityFor(review.toolName) });
    return { status: "denied" };
  }
  if (reject) {
    await observe(input.onLifecycle, {
      status: "rejected",
      action: capabilityFor(review.toolName)
    });
    return { status: "rejected", state };
  }
  if (!input.preview || !input.policyKey) {
    await observe(input.onLifecycle, {
      status: "rejected",
      action: capabilityFor(review.toolName)
    });
    return { status: "rejected", state };
  }
  return createActionReview({
    state,
    sessions: input.sessions,
    jobs: input.jobs,
    profileName: input.profileName,
    source: input.source,
    requesterUserId: input.requesterUserId,
    threadId: review.threadId,
    policyKey: input.policyKey,
    preview: input.preview,
    now: input.now,
    idFactory: input.idFactory,
    resultTtlMs: input.resultTtlMs
  });
}

export { hashReviewArguments } from "../runtime/action-executor.js";

export function reviewPostbackData(
  reviewId: string,
  decision: "approve" | "reject",
  resultJobId: string
): string {
  return `action=helper_action_review&reviewId=${encodeURIComponent(reviewId)}&resultJobId=${encodeURIComponent(resultJobId)}&decision=${decision}`;
}

function capabilityFor(toolName: HelperWriteToolName) {
  if (toolName === "propose_save_schedule") return "save_schedule" as const;
  if (toolName === "propose_save_memory") return "save_memory" as const;
  if (toolName === "propose_save_resource") return "save_resource" as const;
  return "update_own_profile" as const;
}

async function observe(
  observer: ActionReviewLifecycleObserver | undefined,
  event: Parameters<ActionReviewLifecycleObserver>[0]
): Promise<void> {
  try {
    await observer?.(event);
  } catch {
    // Observability must never change review behavior.
  }
}

async function completedResult(
  jobs: AgentJobStore,
  review: ActionReviewSession,
  source: LineSource
) {
  const scope = buildAgentJobScope(review.profileName, source);
  if (!scope) return undefined;
  try {
    const job = await jobs.get(review.resultJobId, scope);
    return job?.status === "completed" ? job : undefined;
  } catch {
    return undefined;
  }
}

async function failPendingResult(
  jobs: AgentJobStore,
  review: ActionReviewSession,
  source: LineSource,
  error: string
): Promise<void> {
  const scope = buildAgentJobScope(review.profileName, source);
  if (!scope) return;
  try {
    const current = await jobs.get(review.resultJobId, scope);
    if (current?.status === "pending") await jobs.fail(review.resultJobId, error);
  } catch {
    // The review outcome still fails closed if result persistence is unavailable.
  }
}
