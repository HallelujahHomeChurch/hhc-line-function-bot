import type { AccountAdminClient, LineBindingCorrelation } from "./account-admin-client.js";
import type { BulletinContinuationSession, SessionStore } from "../state/session-store.js";
import type {
  FunctionExecutionResult,
  FunctionHandlerContext,
  JsonRecord,
  PostbackHandler,
  QuickReplyItem
} from "../types.js";
import { downloadWeeklyPaperArgumentsSchema } from "../function-arguments.js";
import { downloadWeeklyPaper } from "../capabilities/download-weekly-paper.js";
import { buildPostbackQuickReply } from "../line-reply.js";
import type { QuoteToken } from "../quotes/types.js";

const unavailable = (): FunctionExecutionResult => ({
  ok: true,
  replyText: "目前無法繼續查看，請稍後再試或重新提出週報需求。"
});
const expired = (): FunctionExecutionResult => ({
  ok: true,
  replyText: "這次週報要求已失效，請重新輸入要查看的週報。"
});

export function bulletinContinueButton(intentId: string): QuickReplyItem {
  return buildPostbackQuickReply(
    "繼續查看",
    new URLSearchParams({ action: "continue_bulletin", intentId }).toString()
  );
}

export async function completedBulletinButton(input: {
  sessions?: SessionStore;
  account: AccountAdminClient;
  correlation?: LineBindingCorrelation;
  profileName: string;
  lineUserId?: string;
  channelId?: string;
  isContextCurrent?: (token: QuoteToken) => Promise<boolean>;
}): Promise<QuickReplyItem | undefined> {
  const { sessions, account, correlation, profileName, lineUserId, channelId, isContextCurrent } =
    input;
  if (
    !sessions ||
    !account.inspectBinding ||
    !correlation ||
    !lineUserId ||
    !channelId ||
    !isContextCurrent
  )
    return undefined;
  try {
    const session = await findBulletinContinuation(sessions, correlation.intentId);
    if (
      !session ||
      !sameCorrelation(session.correlation, correlation) ||
      !matches(session, profileName, lineUserId, channelId) ||
      !(await isContextCurrent(session.contextToken))
    )
      return undefined;
    const status = await account.inspectBinding({
      correlation,
      expectedLineUserId: lineUserId,
      profileName,
      channelId
    });
    return status.current &&
      status.status === "completed" &&
      sameCorrelation(status.correlation, correlation)
      ? bulletinContinueButton(correlation.intentId)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startBulletinBinding(
  args: JsonRecord,
  context: FunctionHandlerContext,
  account: AccountAdminClient,
  sessions: SessionStore,
  now = new Date()
): Promise<FunctionExecutionResult> {
  const { profile, event, channelId, quoteContext } = context;
  if (
    profile.name !== "main" ||
    event.source.type !== "user" ||
    !event.source.userId ||
    !profile.accountLink ||
    !channelId ||
    channelId.length > 255
  )
    return unavailable();
  const parsed = downloadWeeklyPaperArgumentsSchema.safeParse(args);
  if (!parsed.success) return unavailable();
  if (quoteContext && !(await quoteContext.isCurrent())) return expired();
  const binding = await account.createBinding({
    expectedLineUserId: event.source.userId,
    profileName: profile.name,
    channelId,
    presentation: profile.accountLink
  });
  const quickReplies: QuickReplyItem[] = [
    {
      label: "登入 HHC 帳戶",
      action: { type: "uri", label: "登入 HHC 帳戶", uri: binding.bindingUrl }
    }
  ];
  const correlation = binding.correlation;
  const expiresAt = Math.min(Date.parse(correlation?.expiresAt ?? ""), now.getTime() + 600_000);
  if (
    correlation &&
    correlation.generation !== "0" &&
    account.inspectBinding &&
    quoteContext &&
    expiresAt > now.getTime()
  ) {
    await sessions.set({
      id: sessionId(correlation.intentId),
      type: "bulletin_continuation",
      profileName: profile.name,
      requesterUserId: event.source.userId,
      source: event.source,
      channelId,
      correlation,
      arguments: parsed.data,
      contextToken: quoteContext.token,
      expiresAt: new Date(expiresAt).toISOString()
    });
    quickReplies.push(bulletinContinueButton(correlation.intentId));
  }
  return {
    ok: true,
    executedAction: "download_weekly_paper",
    replayPolicy: "request_again",
    agentResult: { status: "unavailable", replyText: "請先完成 HHC 帳戶登入／連結。" },
    replyText:
      quickReplies.length > 1
        ? "請先登入並完成 LINE 帳戶連結，再按「繼續查看」。這次週報要求會保留最多 10 分鐘。"
        : "請先登入並完成 LINE 帳戶連結，再重新提出週報需求。",
    quickReplies
  };
}

export function createBulletinContinuationHandler(options: {
  account: AccountAdminClient;
  sessions: SessionStore;
  fetchImpl: typeof fetch;
}): PostbackHandler {
  return async (request, context) => {
    if (
      context.profile.name !== "main" ||
      context.event.source.type !== "user" ||
      !context.event.source.userId ||
      !context.channelId ||
      !options.account.inspectBinding ||
      !context.isContextCurrent
    )
      return expired();
    try {
      const session = await findBulletinContinuation(options.sessions, request.params.intentId);
      if (
        !session ||
        !matches(session, context.profile.name, context.event.source.userId, context.channelId) ||
        !(await context.isContextCurrent(session.contextToken))
      )
        return expired();
      const status = await options.account.inspectBinding({
        correlation: session.correlation,
        expectedLineUserId: session.requesterUserId,
        profileName: session.profileName,
        channelId: session.channelId
      });
      if (
        !status.current ||
        !sameCorrelation(status.correlation, session.correlation) ||
        ["cancelled", "superseded", "expired", "failed", "conflict"].includes(status.status)
      )
        return expired();
      if (status.status !== "completed")
        return {
          ok: true,
          replyText: "請先完成登入及 LINE 確認，再按「繼續查看」。",
          quickReplies: [bulletinContinueButton(session.correlation.intentId)]
        };
      if (!(await context.isContextCurrent(session.contextToken))) return expired();
      if (!(await options.sessions.take(session.id))) return expired();
      return await downloadWeeklyPaper(session.arguments, options.fetchImpl, {
        lineUserId: session.requesterUserId,
        profileName: session.profileName,
        requestId: context.requestId,
        resolveLineSubject: options.account.resolveLineSubject
      });
    } catch {
      return unavailable();
    }
  };
}

export async function findBulletinContinuation(
  sessions: SessionStore,
  intentId: string | undefined
): Promise<BulletinContinuationSession | undefined> {
  if (
    !intentId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(intentId)
  )
    return undefined;
  const session = await sessions.get(sessionId(intentId));
  return session?.type === "bulletin_continuation" ? session : undefined;
}

function matches(
  session: BulletinContinuationSession,
  profileName: string,
  lineUserId: string,
  channelId: string
): boolean {
  return (
    session.profileName === profileName &&
    session.requesterUserId === lineUserId &&
    session.source.type === "user" &&
    session.source.userId === lineUserId &&
    session.channelId === channelId
  );
}

function sameCorrelation(left: LineBindingCorrelation, right: LineBindingCorrelation): boolean {
  return (
    left.intentId === right.intentId &&
    left.generation === right.generation &&
    Date.parse(left.expiresAt) === Date.parse(right.expiresAt)
  );
}

function sessionId(intentId: string): string {
  return `bulletin-continuation:${intentId}`;
}
