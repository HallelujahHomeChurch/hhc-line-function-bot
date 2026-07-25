import type { AgentTurnRuntime } from "../../agent/turn-runtime.js";
import type { AgentJobScope, AgentJobStore } from "../../agent/jobs.js";
import { buildPostbackQuickReply } from "../../line-reply.js";
import { messages } from "../../messages.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  LineEvent,
  PostbackHandlerRegistry,
  PostbackRequest
} from "../../types.js";

export async function handlePostbackEvent(
  event: LineEvent,
  profile: BotProfileConfig,
  postbackHandlers: PostbackHandlerRegistry,
  requestId: string,
  requesterDisplayName: string | undefined,
  agentJobStore: AgentJobStore
) {
  const request = parsePostbackData(event.postback?.data ?? "");
  if (!request) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  if (request.action === "agent_job_result") {
    return handleAgentJobResultPostback(request, profile, event, agentJobStore);
  }
  const handler = postbackHandlers[request.action];
  if (!handler) {
    return { ok: true, replyText: messages.postbackUnsupported };
  }
  return handler(request, { profile, event, requestId, requesterDisplayName });
}

export async function handleAgentTextTurnWithLongJob(input: {
  runtime: AgentTurnRuntime;
  jobStore: AgentJobStore;
  profile: BotProfileConfig;
  event: LineEvent;
  requestId: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  engagement?: string;
  allowRouting: boolean;
}): Promise<FunctionExecutionResult | undefined> {
  const turnPromise = input.runtime.handleTextTurn({
    profile: input.profile,
    event: input.event,
    requestId: input.requestId,
    requesterDisplayName: input.requesterDisplayName,
    requesterIsAdmin: input.requesterIsAdmin,
    engagement: input.engagement,
    allowRouting: input.allowRouting
  });
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
      .then((result) =>
        input.jobStore.complete(
          job.id,
          result ?? { ok: true, replyText: "這次沒有需要回覆的結果。" }
        )
      )
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
  jobStore: AgentJobStore
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
  return job.result ?? { ok: true, replyText: "這筆任務沒有可顯示的結果。" };
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
