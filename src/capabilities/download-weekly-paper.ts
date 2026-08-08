import type { FunctionModule, RouterEvalCase } from "../application/contracts/function-module.js";
import type { FunctionExecutionResult, JsonRecord } from "../types.js";
import { downloadWeeklyPaperArgumentsSchema } from "../function-arguments.js";
import type { FunctionDefinition } from "../functions/definitions.js";

const DAPR_BASE_URL = "http://127.0.0.1:3500/v1.0/invoke/hhc-web-api/method";
const PUBLIC_ORIGIN = "https://www.alive.org.tw";
const REQUEST_TIMEOUT_MS = 3_000;
const LINE_URI_MAX_LENGTH = 1_000;
const MAX_ISSUE_NUMBER = 2_147_483_647;
const ASSET_PATH_PATTERN = /^\/assets\/[a-f0-9]{32}$/u;

export const downloadWeeklyPaperDefinition: FunctionDefinition = {
  name: "download_weekly_paper",
  displayName: "下載週報",
  shortDescription: "取得最新一期或指定期數的公開週報。",
  examples: ["下載最新週報", "下載第 1733 期週報"],
  requires: ["hhc_web_api"],
  scope: "profile",
  sideEffectLevel: "read",
  agentCapability: {
    intents: ["下載週報", "最新週報", "週報下載", "期週報", "週報第", "download weekly paper"],
    candidateHints: ["週報", "weekly paper"],
    semanticDescription: "取得最新一期或指定期數的公開週報下載入口。",
    arguments: {
      issueNumber: { type: "number", authority: "explicit_current_text" }
    },
    entityTypes: [],
    refinableFields: [],
    operations: [],
    responseProjection: {
      defaultMode: "focused",
      fields: { issueNumber: { label: "期數", aliases: ["期數", "第幾期"] } }
    }
  },
  allowedSources: ["user"],
  requiredSlots: [],
  resourcePolicy: { kind: "none", remember: false, alias: false },
  memoryPolicy: { kind: "none" },
  clarificationPrompt: "請輸入「下載最新週報」或指定期數。",
  description:
    '- download_weekly_paper: get the latest or an explicitly numbered public Weekly Paper. Arguments: {"issueNumber":positive integer optional}.',
  argumentSchema: downloadWeeklyPaperArgumentsSchema,
  quickReply: { label: "下載週報", command: "下載最新週報" },
  helpText: "下載最新一期週報，或指定期數，例如「下載第 1733 期週報」。"
};

const routerEvalCases: RouterEvalCase[] = [
  {
    kind: "positive",
    text: "下載第 1733 期週報",
    expected: {
      type: "execute",
      action: "download_weekly_paper",
      arguments: { issueNumber: 1733 }
    }
  },
  {
    kind: "missing_slot",
    text: "下載最新週報",
    expected: { type: "execute", action: "download_weekly_paper", arguments: {} }
  },
  {
    kind: "typo",
    text: "下戴最新週包",
    expected: { type: "deny", reason: "keyword_no_match" }
  },
  {
    kind: "negative",
    text: "幫我查今天天氣",
    expected: { type: "deny", reason: "keyword_no_match" }
  },
  {
    kind: "disabled",
    text: "下載最新週報",
    enabledFunctions: [],
    expected: { type: "deny", reason: "function_disabled" }
  },
  {
    kind: "cross_function",
    text: "查下一場服事表",
    expected: {
      type: "execute",
      action: "query_schedule",
      arguments: { query: "下一場服事表", dateIntent: "next_meeting" }
    }
  }
];

export async function downloadWeeklyPaper(
  args: JsonRecord,
  fetchImpl: typeof fetch
): Promise<FunctionExecutionResult> {
  const parsedArguments = downloadWeeklyPaperArgumentsSchema.safeParse(args);
  if (!parsedArguments.success) return unavailableResult();
  const issueNumber = parsedArguments.data.issueNumber;
  const path = issueNumber ? `/api/bulletins/by-number/${issueNumber}` : "/api/bulletins/latest";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${DAPR_BASE_URL}${path}?locale=zh-Hant`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal
    });
    if (response.status === 404) return notFoundResult();
    if (!response.ok) return unavailableResult();
    const value = await response.json().catch(() => undefined);
    const bulletin = parsePublicBulletin(value, issueNumber);
    if (!bulletin) return unavailableResult();
    return successResult(bulletin.issueNumber, bulletin.downloadUri);
  } catch {
    return unavailableResult();
  } finally {
    clearTimeout(timeout);
  }
}

export const downloadWeeklyPaperModule: FunctionModule = {
  name: "download_weekly_paper",
  definition: downloadWeeklyPaperDefinition,
  routerEvalCases,
  register: ({ clients }) => ({
    functions: {
      download_weekly_paper: (args) => downloadWeeklyPaper(args, clients.fetchImpl ?? fetch)
    }
  })
};

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
  const replyText = "目前找不到這一期週報。";
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    agentResult: { status: "not_found", replyText }
  };
}

function successResult(issueNumber: number, downloadUri: string): FunctionExecutionResult {
  const replyText = `第 ${issueNumber} 期週報已準備好，請點下方按鈕下載。`;
  return {
    ok: true,
    replyText,
    executedAction: "download_weekly_paper",
    quickReplies: [
      {
        label: "下載週報",
        action: { type: "uri", label: "下載週報", uri: downloadUri }
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

function parsePublicBulletin(
  value: unknown,
  requestedIssueNumber: number | undefined
): { issueNumber: number; downloadUri: string } | undefined {
  if (!isRecord(value) || !isRecord(value.meta) || value.error !== null || !isRecord(value.data)) {
    return undefined;
  }
  const data = value.data;
  if (
    !positiveInt(data.issueNumber) ||
    (requestedIssueNumber !== undefined && data.issueNumber !== requestedIssueNumber) ||
    data.locale !== "zh-Hant" ||
    !validDate(data.issueDate) ||
    !nonBlank(data.title) ||
    typeof data.subtitle !== "string" ||
    !nonBlank(data.downloadFileName) ||
    !validDateTime(data.publishedAt) ||
    !positiveInt(data.version)
  ) {
    return undefined;
  }
  const downloadUri = canonicalDownloadUri(data.downloadUrl);
  return downloadUri ? { issueNumber: data.issueNumber, downloadUri } : undefined;
}

function canonicalDownloadUri(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("#")) return undefined;
  const rootRelative = value.startsWith("/") && !value.startsWith("//");
  const exactOriginAbsolute = value.startsWith(`${PUBLIC_ORIGIN}/`);
  if (!rootRelative && !exactOriginAbsolute) return undefined;
  const rawPathAndQuery = rootRelative ? value : value.slice(PUBLIC_ORIGIN.length);
  const question = rawPathAndQuery.indexOf("?");
  if (question !== -1 && question !== rawPathAndQuery.lastIndexOf("?")) return undefined;
  const rawPathname = question === -1 ? rawPathAndQuery : rawPathAndQuery.slice(0, question);
  if (!ASSET_PATH_PATTERN.test(rawPathname)) return undefined;
  try {
    const url = new URL(value, PUBLIC_ORIGIN);
    if (
      url.origin !== PUBLIC_ORIGIN ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== rawPathname
    ) {
      return undefined;
    }
    const entries = [...url.searchParams.entries()];
    if (
      entries.length > 0 &&
      (entries.length !== 1 || entries[0]?.[0] !== "filename" || !entries[0][1].trim())
    ) {
      return undefined;
    }
    const uri = url.toString();
    return uri.length <= LINE_URI_MAX_LENGTH ? uri : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_ISSUE_NUMBER;
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function validDateTime(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
