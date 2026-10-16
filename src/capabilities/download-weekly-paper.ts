import type { FunctionExecutionResult, JsonRecord, TextMessageHandler } from "../types.js";
import { downloadWeeklyPaperArgumentsSchema } from "../function-arguments.js";
import type { FunctionDefinition } from "./catalog.js";
import type { AccountAdminClient } from "../account/account-admin-client.js";
import { readMemberAccess, editionLabel, type BulletinEdition } from "../account/member-access.js";
import { matchesWeeklyPaper, weeklyPaperArguments } from "./weekly-paper-request.js";

const DAPR_BASE_URL = "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method";
const PUBLIC_ORIGIN = "https://www.alive.org.tw";
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_ISSUE_NUMBER = 2_147_483_647;
const MEMBER_ENTRY_URI = `${PUBLIC_ORIGIN}/zh-Hant/literature-ministry`;

type MemberAccess = {
  startBinding?(args: JsonRecord): Promise<FunctionExecutionResult>;
  lineUserId: string;
  profileName: string;
  requestId?: string;
  resolveLineSubject: AccountAdminClient["resolveLineSubject"];
};

export const downloadWeeklyPaperDefinition: FunctionDefinition = {
  name: "download_weekly_paper",
  displayName: "下載週報",
  shortDescription: "依會員授權查看一般／兒童週報及各內容語言，可指定期數。",
  examples: ["下載最新週報", "下載第 1733 期週報"],
  requires: ["hhc_web_api"],
  scope: "profile",
  sideEffectLevel: "read",
  agentCapability: {
    intents: ["下載週報", "最新週報", "週報下載", "期週報", "週報第", "download weekly paper"],
    semanticDescription: "取得最新一期或指定期數的會員週報入口。",
    operations: []
  },
  allowedSources: ["user"],
  requiredSlots: [],
  resourcePolicy: { kind: "none", remember: false, alias: false },
  memoryPolicy: { kind: "none" },
  clarificationPrompt: "請輸入「下載最新週報」或指定期數。",
  description:
    "- download_weekly_paper: get an authorized member bulletin entry. Optional arguments: issueNumber (positive integer), series (general|children), locale (zh-Hant|zh-Hans|en). Content language must be explicitly requested, never inferred from interface language.",
  argumentSchema: downloadWeeklyPaperArgumentsSchema,
  quickReply: { label: "下載週報", command: "下載最新週報" },
  helpText: "下載最新一期週報，或指定期數，例如「下載第 1733 期週報」。"
};

export async function downloadWeeklyPaper(
  args: JsonRecord,
  fetchImpl: typeof fetch,
  memberAccess?: MemberAccess
): Promise<FunctionExecutionResult> {
  const parsedArguments = downloadWeeklyPaperArgumentsSchema.safeParse(args);
  if (!parsedArguments.success) return unavailableResult();
  if (!memberAccess) return unavailableResult();
  const issueNumber = parsedArguments.data.issueNumber;
  let subject;
  try {
    subject = await memberAccess.resolveLineSubject({
      lineUserId: memberAccess.lineUserId,
      profileName: memberAccess.profileName
    });
  } catch {
    return unavailableResult();
  }
  if (!subject.bound)
    return memberAccess.startBinding
      ? memberAccess.startBinding(parsedArguments.data)
      : unboundResult();
  if (!subject.active) return inactiveResult();
  let access;
  try {
    access = await readMemberAccess(fetchImpl, subject.subjectId, memberAccess.requestId);
  } catch {
    return unavailableResult();
  }
  if (!access.qualified) return accessRequiredResult(false);
  const editions = access.editions.filter(
    (edition) =>
      (!parsedArguments.data.series || edition.series === parsedArguments.data.series) &&
      (!parsedArguments.data.locale || edition.locale === parsedArguments.data.locale)
  );
  if (!editions.length) return accessRequiredResult(false);
  if (editions.length > 1) return editionChoices(editions, issueNumber);
  const edition = editions[0]!;
  if (access.legal === "required") return accessRequiredResult(true, edition, issueNumber);
  const params = new URLSearchParams({
    series: edition.series,
    locales: edition.locale,
    offset: "0",
    limit: "1",
    ...(issueNumber ? { issueNumber: String(issueNumber) } : {})
  });
  const path = `/api/member/bulletins/online?${params}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${DAPR_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        "X-HHC-User-ID": subject.subjectId,
        "X-HHC-Auth-Provider": "account-api",
        ...(memberAccess.requestId ? { "X-HHC-Request-ID": memberAccess.requestId } : {})
      },
      redirect: "error",
      signal: controller.signal
    });
    if (response.status === 404) return notFoundResult();
    if (response.status === 403 || response.status === 428) {
      const failure: unknown = await response.json().catch(() => undefined);
      if (isRecord(failure) && isRecord(failure.error)) {
        if (response.status === 403 && failure.error.code === "access_required")
          return accessRequiredResult(false, edition, issueNumber);
        if (response.status === 428 && failure.error.code === "policy_acceptance_required")
          return accessRequiredResult(true, edition, issueNumber);
      }
      return unavailableResult();
    }
    if (!response.ok) return unavailableResult();
    const value = await response.json().catch(() => undefined);
    const authorizedIssue = parseAuthorizedIssue(value, issueNumber, edition);
    if (authorizedIssue === null) return notFoundResult();
    return authorizedIssue ? memberEntryResult(authorizedIssue, edition) : unavailableResult();
  } catch {
    return unavailableResult();
  } finally {
    clearTimeout(timeout);
  }
}

function memberEntryResult(
  issue: { issueNumber: number; online: boolean },
  edition: BulletinEdition
): FunctionExecutionResult {
  const replyText = `第 ${issue.issueNumber} 期週報（${editionLabel(edition)}），請至會員頁面查看可用的閱讀／下載方式。`;
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    quickReplies: [
      {
        label: "查看該期週報",
        action: {
          type: "uri",
          label: "查看該期週報",
          uri: memberEntryUri(edition, issue.issueNumber, issue.online)
        }
      }
    ],
    agentResult: {
      status: "success",
      anchors: {},
      entities: [],
      supportedOperations: [],
      replyText
    }
  };
}

export function createDownloadWeeklyPaperTextMessageHandler(
  fetchImpl: typeof fetch,
  accountClient?: Pick<AccountAdminClient, "resolveLineSubject">
): TextMessageHandler {
  return {
    capability: "download_weekly_paper",
    matches: ({ text }, { profile, event }) =>
      profile.name === "main" &&
      event.source.type === "user" &&
      profile.enabledFunctions.includes("download_weekly_paper") &&
      matchesWeeklyPaper(text),
    handle: ({ text }, { profile, event, requestId }) =>
      downloadWeeklyPaper(
        weeklyPaperArguments(text),
        fetchImpl,
        accountClient && event.source.userId
          ? {
              lineUserId: event.source.userId,
              profileName: profile.name,
              requestId,
              resolveLineSubject: accountClient.resolveLineSubject
            }
          : undefined
      ).then((result) => ({
        ...result,
        executedAction: "download_weekly_paper"
      }))
  };
}

function unavailableResult(): FunctionExecutionResult {
  const replyText = "目前無法取得週報，請稍後再試。";
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "unavailable", replyText }
  };
}

function notFoundResult(): FunctionExecutionResult {
  const replyText = "目前找不到或無法存取這一期週報。";
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "not_found", replyText }
  };
}

function unboundResult(): FunctionExecutionResult {
  const replyText = "請先輸入「登入」連結 HHC 帳號，再查看會員週報。";
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "unavailable", replyText }
  };
}

function inactiveResult(): FunctionExecutionResult {
  const replyText = "此 HHC 帳號目前無法使用，請聯絡管理同工協助。";
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "unavailable", replyText }
  };
}

function accessRequiredResult(
  policyRequired: boolean,
  edition?: BulletinEdition,
  issueNumber?: number
): FunctionExecutionResult {
  const replyText = policyRequired
    ? "請先確認最新的會員條款，再回來查看週報。"
    : "此帳號目前不符合會員週報存取資格，請至會員頁面確認，或聯絡管理同工。";
  const label = policyRequired ? "確認會員條款" : "查看會員頁面";
  const uri = policyRequired
    ? `https://account.alive.org.tw/legal?return_to=${encodeURIComponent(edition ? memberEntryUri(edition, issueNumber, true) : MEMBER_ENTRY_URI)}`
    : MEMBER_ENTRY_URI;
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "unavailable", replyText },
    quickReplies: [{ label, action: { type: "uri", label, uri } }]
  };
}

function memberEntryUri(edition: BulletinEdition, issueNumber?: number, online = false): string {
  const params = new URLSearchParams({
    series: edition.series,
    ...(issueNumber ? { issueNumber: String(issueNumber) } : {}),
    contentLocale: edition.locale,
    mode: online ? "online" : "pdf"
  });
  return `${MEMBER_ENTRY_URI}?${params}`;
}

function editionChoices(
  editions: BulletinEdition[],
  issueNumber?: number
): FunctionExecutionResult {
  const replyText = "請選擇要查看的週報版本與內容語言：";
  return {
    ok: true,
    executedAction: "download_weekly_paper",
    replyText,
    agentResult: { status: "ambiguous", replyText },
    quickReplies: editions.map((edition) => {
      const label = editionLabel(edition);
      return {
        label,
        action: {
          type: "message",
          label,
          text: `查看${issueNumber ? `第 ${issueNumber} 期` : "最新"}週報（${label}）`
        }
      };
    })
  };
}

function parseAuthorizedIssue(
  value: unknown,
  requestedIssueNumber: number | undefined,
  edition: BulletinEdition
): { issueNumber: number; online: boolean } | null | undefined {
  if (!isRecord(value) || !isRecord(value.meta) || value.error !== null || !isRecord(value.data)) {
    return undefined;
  }
  const items = value.data.items;
  if (Array.isArray(items) && items.length === 0) return null;
  if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) return undefined;
  const item = items[0];
  if (
    !positiveInt(item.issueNumber) ||
    (requestedIssueNumber !== undefined && item.issueNumber !== requestedIssueNumber) ||
    item.series !== edition.series ||
    item.contentLocale !== edition.locale ||
    typeof item.pdfPublished !== "boolean" ||
    (item.onlineRevision !== null && !positiveInt(item.onlineRevision))
  )
    return undefined;
  if (!item.pdfPublished && item.onlineRevision === null) return null;
  return { issueNumber: item.issueNumber, online: item.onlineRevision !== null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_ISSUE_NUMBER;
}
