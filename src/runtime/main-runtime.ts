import { createHash, randomUUID } from "node:crypto";

import { buildAgentJobScope, type AgentJobStore } from "../agent/jobs.js";
import {
  applyPendingSlotAnswer,
  createSlotClarificationResult
} from "../agent/slot-clarification.js";
import { normalizeFunctionArguments } from "../functions/argument-normalization.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import { messages } from "../messages.js";
import type { SessionStore } from "../state/session-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  FunctionRegistry,
  JsonRecord
} from "../types.js";
import { createActionExecutor, hashReviewArguments } from "./action-executor.js";
import type {
  ProfileActionReviewInput,
  ProfileActionReviewResult,
  ProfileRuntime,
  ProfileTurnInput
} from "./profile-runtime.js";

const REVIEW_TTL_MS = 5 * 60_000;
const RESULT_TTL_MS = 30 * 60_000;

export interface MainRuntimeOptions {
  handlers: FunctionRegistry;
  sessions: SessionStore;
  jobs: AgentJobStore;
  now?: () => Date;
  idFactory?: () => string;
}

function reviewPostbackData(
  reviewId: string,
  decision: "approve" | "reject",
  resultJobId: string
): string {
  return `action=helper_action_review&reviewId=${encodeURIComponent(reviewId)}&resultJobId=${encodeURIComponent(resultJobId)}&decision=${decision}`;
}

export function createMainRuntime(options: MainRuntimeOptions): ProfileRuntime {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  const handleActionReview = async (
    input: ProfileActionReviewInput
  ): Promise<ProfileActionReviewResult | undefined> => {
    const scope = buildAgentJobScope(input.profile.name, input.event.source);
    if (input.profile.name !== "main" || !scope || !input.event.source.userId) return undefined;
    const pending = await options.sessions.findActionReview({
      profileName: input.profile.name,
      source: input.event.source,
      requesterUserId: input.event.source.userId
    });
    if (!pending || pending.id !== input.reviewId || pending.resultJobId !== input.resultJobId) {
      return existingResult(options.jobs, input.resultJobId, scope);
    }
    const decision = input.text.trim();
    if (decision !== "確認" && decision !== "取消") {
      return reviewResult({ ok: true, replyText: "請選擇確認或取消。" });
    }
    const job = await options.jobs.get(input.resultJobId, scope);
    if (job?.status === "completed" && job.result) return reviewResult(job.result);
    if (job?.status !== "pending") return reviewResult(unavailableReview());
    const review = await options.sessions.takeActionReview({
      id: input.reviewId,
      profileName: input.profile.name,
      source: input.event.source,
      requesterUserId: input.event.source.userId
    });
    if (!review) return existingResult(options.jobs, input.resultJobId, scope);
    const stored = review.threadId ? await options.sessions.take(review.threadId) : undefined;
    if (
      stored?.type !== "pending_function" ||
      stored.action !== "update_own_profile" ||
      stored.reviewId !== review.id
    ) {
      await options.jobs.fail(review.resultJobId, "review_arguments_missing");
      return reviewResult(unavailableReview());
    }
    if (decision === "取消") {
      await options.jobs.fail(review.resultJobId, "review_rejected");
      return reviewResult({ ok: true, replyText: "已取消修改姓名。" });
    }
    if (!(await authorized(input))) {
      await options.jobs.fail(review.resultJobId, "authorization_denied");
      return reviewResult({ ok: true, replyText: messages.permissionDenied });
    }
    const authorizedInput = withUpdateCapability(input);
    const context = handlerContext(authorizedInput);
    const executor = createActionExecutor({
      handlers: options.handlers,
      jobs: options.jobs,
      authorize: () => authorized(input),
      currentPolicyKey: () => mainPolicyKey(input)
    });
    const outcome = await executor.execute({
      review,
      arguments: stored.arguments,
      context
    });
    return reviewResult(
      outcome.status === "approved" ? outcome.result : unavailableReview(),
      outcome.status === "approved"
    );
  };

  return {
    async handleTextTurn(input) {
      if (input.profile.name !== "main" || input.event.source.type !== "user") return undefined;
      const text = input.event.message?.text?.trim() ?? "";
      if (!text) return undefined;
      const requesterUserId = input.event.source.userId;
      if (!requesterUserId) return undefined;
      const review = await options.sessions.findActionReview({
        profileName: "main",
        source: input.event.source,
        requesterUserId
      });
      if (review) {
        return (
          await handleActionReview({
            ...input,
            reviewId: review.id,
            resultJobId: review.resultJobId,
            text
          })
        )?.result;
      }
      if (
        input.profile.enabledFunctions.includes("download_weekly_paper") &&
        matchesWeeklyPaper(text)
      ) {
        return options.handlers.download_weekly_paper?.(
          normalizeFunctionArguments("download_weekly_paper", {}, { text }),
          handlerContext(input)
        );
      }
      const pending = await options.sessions.findPendingFunction({
        profileName: "main",
        source: input.event.source,
        requesterUserId,
        action: "update_own_profile"
      });
      if (!pending && !matchesOwnProfileUpdate(text)) {
        return { ok: true, replyText: messages.unsupported };
      }
      if (
        !(input.configuredFunctions ?? input.profile.enabledFunctions).includes(
          "update_own_profile"
        )
      ) {
        return { ok: true, replyText: messages.permissionDenied };
      }
      if (!(await authorized(input))) return { ok: true, replyText: messages.permissionDenied };
      const authorizedInput = withUpdateCapability(input);
      if (/^(?:取消|不要|先不要|不用)$/u.test(text)) {
        if (pending) await options.sessions.delete(pending.id);
        return { ok: true, replyText: "已取消這次操作。" };
      }
      const args = pending
        ? normalizeFunctionArguments(
            "update_own_profile",
            applyPendingSlotAnswer("update_own_profile", pending.arguments, text),
            { text }
          )
        : {};
      if (pending) await options.sessions.delete(pending.id);
      const context = handlerContext(authorizedInput);
      const clarification = await createSlotClarificationResult({
        sessionStore: options.sessions,
        action: "update_own_profile",
        arguments: args,
        context,
        requestId: input.requestId,
        now: now()
      });
      if (clarification) return clarification;
      return createUpdateReview(authorizedInput, args, context);
    },
    handleActionReview
  };

  async function createUpdateReview(
    input: ProfileTurnInput,
    args: JsonRecord,
    context: FunctionHandlerContext
  ) {
    if (!(await authorized(input))) return { ok: true, replyText: messages.permissionDenied };
    const handler = options.handlers.update_own_profile;
    const requesterUserId = input.event.source.userId;
    const scope = buildAgentJobScope(input.profile.name, input.event.source);
    if (!handler || !requesterUserId || !scope) return unavailableReview();
    const preview = await handler(args, { ...context, agentTool: true });
    if (preview.writePhase !== "preview") return unavailableReview();
    const job = await options.jobs.createPending({
      scope,
      capability: "update_own_profile",
      label: "action-review",
      ttlMs: RESULT_TTL_MS
    });
    const reviewId = idFactory();
    const checkpointId = `${reviewId}:arguments`;
    const expiresAt = new Date(now().getTime() + REVIEW_TTL_MS).toISOString();
    try {
      await options.sessions.set({
        id: reviewId,
        type: "action_review",
        profileName: "main",
        requesterUserId,
        source: input.event.source,
        threadId: checkpointId,
        interruptId: reviewId,
        toolName: "update_own_profile",
        argumentsHash: hashReviewArguments(args),
        policyKey: mainPolicyKey(input),
        resultJobId: job.id,
        expiresAt
      });
      await options.sessions.set({
        id: checkpointId,
        type: "pending_function",
        action: "update_own_profile",
        profileName: "main",
        requesterUserId,
        source: input.event.source,
        arguments: args,
        reviewId,
        expiresAt
      });
    } catch {
      await options.sessions.delete(reviewId).catch(() => undefined);
      await options.sessions.delete(checkpointId).catch(() => undefined);
      await options.jobs.fail(job.id, "review_state_unavailable");
      return unavailableReview();
    }
    return {
      ...preview,
      quickReplies: [
        buildPostbackQuickReply("確認", reviewPostbackData(reviewId, "approve", job.id), "確認"),
        buildPostbackQuickReply("取消", reviewPostbackData(reviewId, "reject", job.id), "取消")
      ]
    };
  }
}

function handlerContext(input: ProfileTurnInput): FunctionHandlerContext {
  return {
    profile: input.profile,
    event: input.event,
    requestId: input.requestId,
    requesterDisplayName: input.requesterDisplayName,
    requesterIsAdmin: input.accountAdministrator?.() || input.requesterIsAdmin
  };
}

async function authorized(input: ProfileTurnInput): Promise<boolean> {
  try {
    return (
      (await input.authorizeFunctions?.(["update_own_profile"]))?.includes("update_own_profile") ===
      true
    );
  } catch {
    return false;
  }
}

function mainPolicyKey(input: ProfileTurnInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profile: input.profile.name,
        configured: [...(input.configuredFunctions ?? input.profile.enabledFunctions)].sort()
      })
    )
    .digest("hex");
}

function withUpdateCapability<T extends ProfileTurnInput>(input: T): T {
  return input.profile.enabledFunctions.includes("update_own_profile")
    ? input
    : {
        ...input,
        profile: {
          ...input.profile,
          enabledFunctions: [...input.profile.enabledFunctions, "update_own_profile"]
        }
      };
}

function matchesWeeklyPaper(text: string): boolean {
  return (
    !/(?:不要|不用|取消)/u.test(text) &&
    /(?:下載|最新|第\s*\d+\s*期).*週報|週報.*(?:下載|最新|第\s*\d+\s*期)/u.test(
      text.normalize("NFKC")
    )
  );
}

function matchesOwnProfileUpdate(text: string): boolean {
  return /^(?:\/profile|修改個人資料|修改姓名|更新姓名)$/u.test(text.normalize("NFKC").trim());
}

async function existingResult(
  jobs: AgentJobStore,
  resultJobId: string,
  scope: NonNullable<ReturnType<typeof buildAgentJobScope>>
) {
  const job = await jobs.get(resultJobId, scope).catch(() => undefined);
  if (job?.status === "completed" && job.result) return reviewResult(job.result);
  if (job?.status === "pending")
    return reviewResult({ ok: true, replyText: "這項操作仍在處理中。" });
  return reviewResult(unavailableReview());
}

function reviewResult(
  result: FunctionExecutionResult,
  freshExecution = false
): ProfileActionReviewResult {
  return { result, freshExecution };
}

function unavailableReview() {
  return { ok: true, replyText: "這項確認已失效，請重新提出。" };
}
