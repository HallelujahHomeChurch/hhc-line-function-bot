import { helperThreadIdleTtlMs } from "./state.js";
import { randomUUID } from "node:crypto";

import { buildAgentJobScope, type AgentJobStore } from "../agent/jobs.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import { hashReviewArguments } from "../runtime/action-executor.js";
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

export type ReviewResult =
  | {
      status: "review";
      reviewId: string;
      argumentsHash: string;
      result: FunctionExecutionResult;
    }
  | { status: "denied" };

export interface CreateActionReviewInput {
  proposal: { toolName: HelperWriteToolName; args: JsonRecord; operationId: string };
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
  const { toolName, args, operationId } = input.proposal;
  if (!operationId || !helperWriteTools.has(toolName)) return { status: "denied" };
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
    interruptId: operationId,
    toolName,
    argumentsHash,
    draftArguments: args,
    approvalExpiresAt: new Date((input.now ?? new Date()).getTime() + REVIEW_TTL_MS).toISOString(),
    policyKey: input.policyKey,
    resultJobId: job.id,
    expiresAt: new Date(
      (input.now ?? new Date()).getTime() + helperThreadIdleTtlMs(input.source)
    ).toISOString()
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
      resultAuthority: {
        kind: "capabilities",
        capabilities: [capability],
        expiresAt: review.approvalExpiresAt ?? review.expiresAt
      },
      replyText: preview,
      quickReplies: [
        buildPostbackQuickReply("確認", reviewPostbackData(id, "approve", job.id), "確認"),
        buildPostbackQuickReply("取消", reviewPostbackData(id, "reject", job.id), "取消")
      ]
    }
  };
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
