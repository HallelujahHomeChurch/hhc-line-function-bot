import type { QuoteContext, QuoteToken } from "../../quotes/types.js";
import { createHash, randomUUID } from "node:crypto";
import type { WebhookReceipt } from "./webhook-receipt.js";
import type { CapabilityName } from "../../capabilities/names.js";
import type { ProfileRuntime } from "../../runtime/profile-runtime.js";
import type { AgentJobScope, AgentJobStore } from "../../agent/jobs.js";
import { getFunctionDefinition } from "../../capabilities/catalog.js";
import { buildPostbackQuickReply } from "../../line-reply.js";
import { messages } from "../../messages.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  LineEvent,
  PostbackHandlerRegistry,
  PostbackRequest
} from "../../types.js";

export interface HandledPostbackEvent {
  result: FunctionExecutionResult;
  completionEligible: boolean;
  capability?: CapabilityName;
  profile?: BotProfileConfig;
}

export interface HelperReviewPostbackHandler {
  (input: {
    reviewId: string;
    resultJobId: string;
    text: "確認" | "取消";
    profile: BotProfileConfig;
    event: LineEvent;
    requestId: string;
    requesterDisplayName?: string;
  }): Promise<FunctionExecutionResult>;
}

export async function handlePostbackEvent(
  event: LineEvent,
  profile: BotProfileConfig,
  postbackHandlers: PostbackHandlerRegistry,
  requestId: string,
  requesterDisplayName: string | undefined,
  agentJobStore: AgentJobStore,
  configuredFunctions: readonly CapabilityName[] = profile.enabledFunctions,
  authorizeFunctions?: (
    functionNames: readonly CapabilityName[]
  ) => Promise<readonly CapabilityName[]>,
  helperReviewHandler?: HelperReviewPostbackHandler,
  isContextCurrent?: (token: QuoteToken) => Promise<boolean>,
  channelId?: string
): Promise<HandledPostbackEvent> {
  const request = parsePostbackData(event.postback?.data ?? "");
  if (!request) {
    return {
      result: { ok: true, replyText: messages.postbackUnsupported },
      completionEligible: false
    };
  }
  if (request.action === "agent_job_result") {
    return {
      result: await handleAgentJobResultPostback(
        request,
        profile,
        event,
        agentJobStore,
        configuredFunctions,
        authorizeFunctions,
        isContextCurrent
      ),
      completionEligible: false
    };
  }
  if (request.action === "helper_action_review") {
    const reviewId = request.params.reviewId;
    const resultJobId = request.params.resultJobId;
    const decision = request.params.decision;
    if (
      !reviewId ||
      !resultJobId ||
      (decision !== "approve" && decision !== "reject") ||
      !helperReviewHandler
    ) {
      return {
        result: { ok: true, replyText: messages.postbackUnsupported },
        completionEligible: false
      };
    }
    const scope = buildAgentJobScope(profile, event);
    const job = scope ? await agentJobStore.get(resultJobId, scope) : undefined;
    if (job?.contextToken && !(await isContextCurrent?.(job.contextToken))) {
      return { result: invalidatedResult(), completionEligible: false };
    }
    return {
      result: await helperReviewHandler({
        reviewId,
        resultJobId,
        text: decision === "approve" ? "確認" : "取消",
        profile,
        event,
        requestId,
        requesterDisplayName
      }),
      completionEligible: false
    };
  }
  const registration = postbackHandlers[request.action];
  if (!registration) {
    return {
      result: { ok: true, replyText: messages.postbackUnsupported },
      completionEligible: false
    };
  }
  if (
    !(await postbackCapabilityAllowed(
      profile,
      configuredFunctions,
      registration.capability,
      authorizeFunctions
    ))
  ) {
    return {
      result: { ok: true, replyText: messages.permissionDenied },
      completionEligible: false
    };
  }
  const authorizedProfile = profile.enabledFunctions.includes(registration.capability)
    ? profile
    : {
        ...profile,
        enabledFunctions: [...profile.enabledFunctions, registration.capability]
      };
  return {
    result: await registration.handle(request, {
      channelId,
      isContextCurrent,
      profile: authorizedProfile,
      event,
      requestId,
      requesterDisplayName
    }),
    completionEligible: true,
    capability: registration.capability,
    profile: authorizedProfile
  };
}

export async function handleAgentTextTurnWithLongJob(input: {
  channelId?: string;
  runtime: ProfileRuntime;
  jobStore: AgentJobStore;
  receipt?: WebhookReceipt;
  quoteContext?: QuoteContext;
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  configuredFunctions?: readonly CapabilityName[];
  authorizeFunctions?(functionNames: readonly CapabilityName[]): Promise<readonly CapabilityName[]>;
  accountAdministrator?(): boolean;
  nicknameWriteEnabled?(): boolean;
  completeResult?(result: FunctionExecutionResult): Promise<FunctionExecutionResult>;
}): Promise<FunctionExecutionResult | undefined> {
  return handleAgentOperationWithLongJob({
    jobStore: input.jobStore,
    receipt: input.receipt,
    quoteContext: input.quoteContext,
    profile: input.profile,
    event: input.event,
    requesterDisplayName: input.requesterDisplayName,
    operation: async (operationId) => {
      const result = await input.runtime.handleTextTurn({
        operationId,
        channelId: input.channelId,
        quoteContext: input.quoteContext,
        profile: input.profile,
        configuredFunctions: input.configuredFunctions ? [...input.configuredFunctions] : undefined,
        event: input.event,
        requestId: input.requestId,
        requesterDisplayName: input.requesterDisplayName,
        requesterIsAdmin: input.requesterIsAdmin,
        authorizeFunctions: input.authorizeFunctions
          ? async (names) => [...(await input.authorizeFunctions!(names))]
          : undefined,
        accountAdministrator: input.accountAdministrator,
        nicknameWriteEnabled: input.nicknameWriteEnabled
      });
      return result && input.completeResult ? input.completeResult(result) : result;
    }
  });
}

export async function handleAgentOperationWithLongJob(input: {
  jobStore: AgentJobStore;
  receipt?: WebhookReceipt;
  quoteContext?: QuoteContext;
  profile: BotProfileConfig;
  event: LineEvent;
  requesterDisplayName?: string;
  deferStart?: boolean;
  operation(
    operationId: string,
    start: () => Promise<boolean>
  ): Promise<FunctionExecutionResult | undefined>;
}): Promise<FunctionExecutionResult | undefined> {
  const scope = buildAgentJobScope(input.profile, input.event);
  if (!scope) return undefined;
  const config = input.profile.longRunningJobs;
  const eventId = input.event.webhookEventId;
  const id =
    input.receipt?.lease.operationId ??
    (eventId
      ? createHash("sha256")
          .update(`${encodeURIComponent(input.profile.name)}:${encodeURIComponent(eventId)}`)
          .digest("hex")
      : randomUUID());
  let started = false;
  let notifyStarted!: () => void;
  const startedSignal = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let startPromise: Promise<boolean> | undefined;
  const start = () =>
    (startPromise ??= (async () => {
      await input.jobStore.createPending({
        id,
        scope,
        label: "agent-turn",
        contextToken: input.quoteContext?.token,
        ttlMs: (config?.resultTtlMinutes ?? 30) * 60_000
      });
      // No function can run before its durable operation and start marker exist.
      await input.receipt?.start();
      if (!input.jobStore.markStarted || !(await input.jobStore.markStarted(id, 120_000)))
        return false;
      started = true;
      heartbeat = setInterval(() => {
        void input.jobStore.renewExecution?.(id, 120_000).catch(() => undefined);
      }, 40_000);
      heartbeat.unref();
      notifyStarted();
      return true;
    })());
  if (!input.deferStart && !(await start())) {
    return {
      ok: true,
      replyText: "這筆請求已有處理紀錄，請查看結果。",
      quickReplies: [buildAgentJobQuickReply(id)]
    };
  }
  const turnPromise = (async () => {
    try {
      if (input.quoteContext && !(await input.quoteContext.isCurrent())) {
        if (started) await input.jobStore.fail(id, "context_invalidated");
        await input.receipt?.finish(true);
        return started ? invalidatedResult() : undefined;
      }
      const result = await input.operation(id, start);
      if (!started) {
        await input.receipt?.finish(true);
        return undefined;
      }
      if (input.quoteContext && !(await input.quoteContext.isCurrent())) {
        await input.jobStore.fail(id, "context_invalidated");
        await input.receipt?.finish(true);
        return invalidatedResult();
      }
      if (result && (result.resultAuthority || result.executedAction)) {
        const storedResult =
          result.replayPolicy === "request_again"
            ? {
                ok: true,
                replyText: "這筆結果包含一次性登入資訊，請重新提出需求以取得新的登入連結。",
                executedAction: result.executedAction,
                resultAuthority: result.resultAuthority
              }
            : result;
        await input.jobStore.complete(id, storedResult, result.executedAction);
        const persisted = await input.jobStore.get(id, scope);
        if (persisted?.status !== "completed") throw new Error("agent_result_not_persisted");
      } else {
        await input.jobStore.fail(id, "missing_capability_owner");
      }
      await input.receipt?.finish(true);
      return result;
    } catch (error) {
      if (started) await input.jobStore.fail(id, "execution_uncertain").catch(() => undefined);
      await input.receipt?.finish(false).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  })();
  if (!config?.enabled || config.inlineReplyTimeoutMs <= 0) return turnPromise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timeoutSymbol>((resolve) => {
    timer = setTimeout(() => resolve(timeoutSymbol), config.inlineReplyTimeoutMs);
  });
  const handoff = timeout.then(async (value) => {
    await startedSignal;
    return value;
  });
  const first = await Promise.race([turnPromise, handoff]).finally(() => clearTimeout(timer));
  if (first !== timeoutSymbol) return first as FunctionExecutionResult | undefined;
  if (input.receipt) input.receipt.deferred = true;
  void turnPromise.catch(() => undefined);
  return {
    ok: true,
    replyText: waitingForAgentJobReply(input.requesterDisplayName),
    quickReplies: [buildAgentJobQuickReply(id)]
  };
}

export function sourceKey(source: LineEvent["source"]): string | undefined {
  switch (source.type) {
    case "group":
      return source.groupId ? `group:${source.groupId}` : undefined;
    case "room":
      return source.roomId ? `room:${source.roomId}` : undefined;
    case "user":
      return source.userId ? `user:${source.userId}` : undefined;
    default:
      return undefined;
  }
}

export function parsePostbackData(data: string): PostbackRequest | null {
  const params = Object.fromEntries(new URLSearchParams(data));
  const action = params.action;
  if (!action) {
    return null;
  }
  return { action, params };
}

async function handleAgentJobResultPostback(
  request: PostbackRequest,
  profile: BotProfileConfig,
  event: LineEvent,
  jobStore: AgentJobStore,
  configuredFunctions: readonly CapabilityName[],
  authorizeFunctions?: (
    functionNames: readonly CapabilityName[]
  ) => Promise<readonly CapabilityName[]>,
  isContextCurrent?: (token: QuoteToken) => Promise<boolean>
): Promise<FunctionExecutionResult> {
  const jobId = request.params.jobId;
  const scope = buildAgentJobScope(profile, event);
  if (!jobId || !scope) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  const job = await jobStore.get(jobId, scope);
  if (!job) {
    return { ok: true, replyText: "找不到這筆結果，可能已經過期，請再問一次。" };
  }
  if (job.contextToken && !(await isContextCurrent?.(job.contextToken))) return invalidatedResult();
  if (job.status === "pending") {
    return {
      ok: true,
      replyText: "我還在處理，稍後可以再按一次查看結果。",
      quickReplies: [buildAgentJobQuickReply(job.id)]
    };
  }
  if (job.status === "uncertain") {
    return {
      ok: true,
      replyText: "這筆操作的執行結果尚未確認，請聯絡管理同工協助查核，避免重複操作。"
    };
  }
  if (job.status === "failed") {
    return { ok: true, replyText: "剛剛處理時遇到問題，請再問一次。" };
  }
  const authority = job.result?.resultAuthority;
  const capabilities = new Set([
    ...(authority?.kind === "capabilities" ? authority.capabilities : []),
    ...(job.capability ? [job.capability] : [])
  ]);
  if (!authority && capabilities.size === 0) {
    return { ok: true, replyText: messages.permissionDenied };
  }
  if (authority?.kind === "capabilities" && authority.capabilities.length === 0) {
    return { ok: true, replyText: messages.permissionDenied };
  }
  for (const capability of capabilities) {
    if (
      !(await postbackCapabilityAllowed(
        profile,
        configuredFunctions,
        capability,
        authorizeFunctions
      ))
    ) {
      return { ok: true, replyText: messages.permissionDenied };
    }
  }
  if (authority?.expiresAt && !(Date.parse(authority.expiresAt) > Date.now())) {
    return { ok: true, replyText: "這份預覽已經過期，請重新提出需求，讓我建立新的預覽。" };
  }
  return job.result ?? { ok: true, replyText: "這筆任務沒有可顯示的結果。" };
}

async function postbackCapabilityAllowed(
  profile: BotProfileConfig,
  configuredFunctions: readonly CapabilityName[],
  capability: CapabilityName,
  authorizeFunctions:
    ((functionNames: readonly CapabilityName[]) => Promise<readonly CapabilityName[]>) | undefined
): Promise<boolean> {
  if (!configuredFunctions.includes(capability)) return false;
  const needsAccount =
    profile.permissionRequiredFunctions.includes(capability) ||
    getFunctionDefinition(capability)?.sideEffectLevel !== "read";
  if (!needsAccount) return profile.enabledFunctions.includes(capability);
  try {
    return (await authorizeFunctions?.([capability]))?.includes(capability) === true;
  } catch {
    return false;
  }
}

function buildAgentJobQuickReply(jobId: string) {
  return buildPostbackQuickReply(
    "查看結果",
    `action=agent_job_result&jobId=${encodeURIComponent(jobId)}`,
    "查看結果"
  );
}

function buildAgentJobScope(
  profile: BotProfileConfig,
  event: LineEvent
): AgentJobScope | undefined {
  const source = sourceKey(event.source);
  if (!source) {
    return undefined;
  }
  if (event.source.type !== "user" && !event.source.userId) {
    return undefined;
  }
  return {
    profileName: profile.name,
    sourceKey: source,
    requesterUserId: event.source.userId
  };
}

function waitingForAgentJobReply(displayName: string | undefined): string {
  return displayName
    ? `${displayName}，我先處理這個查詢。等一下可以按「查看結果」。`
    : "我先處理這個查詢。等一下可以按「查看結果」。";
}

const timeoutSymbol = Symbol("agent_turn_timeout");

function invalidatedResult(): FunctionExecutionResult {
  return {
    ok: true,
    replyText: "這段對話已重設、收回或過期，請重新提出需求。",
    resultAuthority: { kind: "public" }
  };
}
