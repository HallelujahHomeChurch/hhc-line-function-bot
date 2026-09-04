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
  helperReviewHandler?: HelperReviewPostbackHandler
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
        authorizeFunctions
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
  runtime: ProfileRuntime;
  jobStore: AgentJobStore;
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  configuredFunctions?: readonly CapabilityName[];
  authorizeFunctions?(functionNames: readonly CapabilityName[]): Promise<readonly CapabilityName[]>;
  accountAdministrator?(): boolean;
  completeResult?(result: FunctionExecutionResult): Promise<FunctionExecutionResult>;
}): Promise<FunctionExecutionResult | undefined> {
  const turnPromise = input.runtime
    .handleTextTurn({
      profile: input.profile,
      configuredFunctions: input.configuredFunctions ? [...input.configuredFunctions] : undefined,
      event: input.event,
      requestId: input.requestId,
      requesterDisplayName: input.requesterDisplayName,
      requesterIsAdmin: input.requesterIsAdmin,
      authorizeFunctions: input.authorizeFunctions
        ? async (names) => [...(await input.authorizeFunctions!(names))]
        : undefined,
      accountAdministrator: input.accountAdministrator
    })
    .then((result) => (result && input.completeResult ? input.completeResult(result) : result));
  const config = input.profile.longRunningJobs;
  if (!config?.enabled || config.inlineReplyTimeoutMs <= 0) {
    return turnPromise;
  }
  const scope = buildAgentJobScope(input.profile, input.event);
  if (!scope) {
    return turnPromise;
  }
  const timeout = sleep(config.inlineReplyTimeoutMs).then(() => timeoutSymbol);
  const first = await Promise.race([turnPromise, timeout]);
  if (first === timeoutSymbol) {
    const job = await input.jobStore.createPending({
      scope,
      label: input.event.message?.text?.slice(0, 40) || "agent-turn",
      ttlMs: config.resultTtlMinutes * 60_000
    });
    turnPromise
      .then(async (result) => {
        if (!result?.executedAction) {
          await input.jobStore.fail(job.id, "missing_capability_owner");
          return;
        }
        await input.jobStore.complete(job.id, result, result.executedAction);
      })
      .catch((error: unknown) =>
        input.jobStore.fail(job.id, error instanceof Error ? error.message : String(error))
      );

    return {
      ok: true,
      replyText: waitingForAgentJobReply(input.requesterDisplayName),
      quickReplies: [buildAgentJobQuickReply(job.id)]
    };
  }
  return first as FunctionExecutionResult | undefined;
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
  ) => Promise<readonly CapabilityName[]>
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
  if (job.status === "pending") {
    return {
      ok: true,
      replyText: "我還在處理，稍後可以再按一次查看結果。",
      quickReplies: [buildAgentJobQuickReply(job.id)]
    };
  }
  if (job.status === "failed") {
    return { ok: true, replyText: "剛剛處理時遇到問題，請再問一次。" };
  }
  if (!job.capability) {
    return { ok: true, replyText: messages.permissionDenied };
  }
  if (
    job.capability &&
    !(await postbackCapabilityAllowed(
      profile,
      configuredFunctions,
      job.capability,
      authorizeFunctions
    ))
  ) {
    return { ok: true, replyText: messages.permissionDenied };
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

function sleep(ms: number): Promise<typeof timeoutSymbol> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(timeoutSymbol), ms);
  });
}
