import type { FunctionExecutionResult, JsonRecord, TextMessageHandler } from "../types.js";
import { downloadWeeklyPaperArgumentsSchema } from "../function-arguments.js";
import type { FunctionDefinition } from "./catalog.js";
import type { AccountAdminClient } from "../account/account-admin-client.js";

const DAPR_BASE_URL = "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method";
const PUBLIC_ORIGIN = "https://www.alive.org.tw";
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_ISSUE_NUMBER = 2_147_483_647;
const MEMBER_ENTRY_URI = `${PUBLIC_ORIGIN}/zh-Hant/literature-ministry`;

type MemberAccess = {
  lineUserId: string;
  profileName: string;
  requestId?: string;
  resolveLineSubject: AccountAdminClient["resolveLineSubject"];
};

export const downloadWeeklyPaperDefinition: FunctionDefinition = {
  name: "download_weekly_paper",
  displayName: "下載週報",
  shortDescription: "取得最新一期或指定期數的會員週報。",
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
    '- download_weekly_paper: get the latest or an explicitly numbered member Weekly Paper. Arguments: {"issueNumber":positive integer optional}.',
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
  if (!subject.bound) return unboundResult();
  if (!subject.active) return deniedResult();
  const path = issueNumber
    ? `/api/member/bulletins?series=general&locale=zh-Hant&issueNumber=${issueNumber}&page=1&pageSize=1`
    : "/api/member/bulletins/latest?series=general&locale=zh-Hant";
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
    if (!response.ok) return unavailableResult();
    const value = await response.json().catch(() => undefined);
    const authorizedIssue = parseAuthorizedIssueNumber(value, issueNumber);
    return authorizedIssue ? memberEntryResult(authorizedIssue) : unavailableResult();
  } catch {
    return unavailableResult();
  } finally {
    clearTimeout(timeout);
  }
}

function memberEntryResult(issueNumber: number): FunctionExecutionResult {
  const replyText = `第 ${issueNumber} 期週報可在會員頁面查看或下載。`;
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    quickReplies: [
      {
        label: "查看會員週報",
        action: { type: "uri", label: "查看會員週報", uri: MEMBER_ENTRY_URI }
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
      !/(?:不要|不用|取消)/u.test(text) &&
      /(?:下載|最新|第\s*\d+\s*期).*週報|週報.*(?:下載|最新|第\s*\d+\s*期)/u.test(
        text.normalize("NFKC")
      ),
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

function weeklyPaperArguments(text: string): JsonRecord {
  const normalized = text.normalize("NFKC");
  const rawIssueNumber =
    normalized.match(/(?:第\s*)?(?<![\d.+-])(\d+)(?![\d.])\s*(?:期)?\s*週報/u)?.[1] ??
    normalized.match(/週報\s*(?:第\s*)?(?<![\d.+-])(\d+)(?![\d.])\s*期/u)?.[1];
  return rawIssueNumber ? { issueNumber: Number(rawIssueNumber) } : {};
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

function deniedResult(): FunctionExecutionResult {
  const replyText = "此帳號目前沒有會員週報存取權。";
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "unavailable", replyText }
  };
}

function parseAuthorizedIssueNumber(
  value: unknown,
  requestedIssueNumber: number | undefined
): number | undefined {
  if (!isRecord(value) || !isRecord(value.meta) || value.error !== null || !isRecord(value.data)) {
    return undefined;
  }
  if (requestedIssueNumber === undefined) {
    return positiveInt(value.data.issueNumber) && value.data.locale === "zh-Hant"
      ? value.data.issueNumber
      : undefined;
  }
  const items = value.data.items;
  if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) return undefined;
  return items[0].issueNumber === requestedIssueNumber && items[0].locale === "zh-Hant"
    ? requestedIssueNumber
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_ISSUE_NUMBER;
}
