import { randomUUID } from "node:crypto";

import { Command } from "@langchain/langgraph";
import type { HITLRequest } from "langchain";

import { buildPostbackQuickReply } from "../line-reply.js";
import { hashReviewArguments, type ActionExecution } from "../runtime/action-executor.js";
import type {
  ActionReviewSession,
  HelperWriteToolName,
  SessionStore
} from "../state/session-store.js";
import type { FunctionExecutionResult, JsonRecord, LineSource } from "../types.js";

const REVIEW_TTL_MS = 5 * 60_000;
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
  | { status: "approved"; state: unknown }
  | { status: "rejected"; state: unknown }
  | { status: "denied" };

export interface CreateActionReviewInput {
  state: unknown;
  sessions: SessionStore;
  profileName: string;
  source: LineSource;
  requesterUserId: string;
  threadId: string;
  policyKey: string;
  preview(toolName: HelperWriteToolName, args: JsonRecord): Promise<string | undefined>;
  now?: Date;
  idFactory?: () => string;
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
    expiresAt: new Date((input.now ?? new Date()).getTime() + REVIEW_TTL_MS).toISOString()
  };
  await input.sessions.set(review);
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
        buildPostbackQuickReply("確認", reviewPostbackData(id, "approve"), "確認"),
        buildPostbackQuickReply("取消", reviewPostbackData(id, "reject"), "取消")
      ]
    }
  };
}

export interface ResumeHelperReviewInput {
  sessions: SessionStore;
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
  getExecutionOutcome?: () => ActionExecution | undefined;
}

export async function resumeHelperReview(input: ResumeHelperReviewInput): Promise<ReviewResult> {
  const review = await input.sessions.takeActionReview({
    id: input.reviewId,
    profileName: input.profileName,
    source: input.source,
    requesterUserId: input.requesterUserId
  });
  if (!review?.threadId) return { status: "denied" };
  const normalized = input.text.trim();
  const approve = normalized === "確認";
  const reject = normalized === "取消";
  const state = await input.agent.invoke(
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
  if (approve) {
    const outcome = input.getExecutionOutcome?.();
    return outcome && outcome.status !== "approved"
      ? { status: "denied" }
      : { status: "approved", state };
  }
  if (reject) return { status: "rejected", state };
  if (!input.preview || !input.policyKey) return { status: "rejected", state };
  return createActionReview({
    state,
    sessions: input.sessions,
    profileName: input.profileName,
    source: input.source,
    requesterUserId: input.requesterUserId,
    threadId: review.threadId,
    policyKey: input.policyKey,
    preview: input.preview,
    now: input.now,
    idFactory: input.idFactory
  });
}

export { hashReviewArguments } from "../runtime/action-executor.js";

export function reviewPostbackData(reviewId: string, decision: "approve" | "reject"): string {
  return `action=helper_action_review&reviewId=${encodeURIComponent(reviewId)}&decision=${decision}`;
}

function capabilityFor(toolName: HelperWriteToolName) {
  if (toolName === "propose_save_schedule") return "save_schedule" as const;
  if (toolName === "propose_save_memory") return "save_memory" as const;
  if (toolName === "propose_save_resource") return "save_resource" as const;
  return "update_own_profile" as const;
}
