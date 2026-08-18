import { isFunctionName } from "../types.js";
import type { AccountLinkPresentation, FunctionName } from "../types.js";

export type LineBindingTerminalStatus = "completed" | "failed" | "conflict" | "expired";

export interface CreateLineBindingInput {
  expectedLineUserId: string;
  profileName: string;
  channelId: string;
  presentation: AccountLinkPresentation;
}

export interface AuthorizeLineFunctionsInput {
  lineUserId: string;
  profileName: string;
  functionNames: FunctionName[];
}

export interface VerifyLineFunctionPermissionsInput {
  profileName: string;
  functionNames: FunctionName[];
}

export interface UpdateOwnProfileInput {
  lineUserId: string;
  profileName: string;
  firstName: string;
  lastName: string;
}

export interface LineFunctionAuthorization {
  bound: boolean;
  active: boolean;
  administrator: boolean;
  allowedFunctions: FunctionName[];
  account?: {
    displayName: string;
    maskedEmail: string;
    roles: Array<"user" | "admin">;
  };
}

export interface FinalizeLineBindingInput {
  nonce: string;
  result: "ok" | "failed";
  actualLineUserId?: string;
  profileName: string;
  channelId: string;
  webhookEventId: string;
}

export interface VerifyAccountPermissionInput {
  userId: string;
  requestId: string;
}

export type MediaSyncAclSubjectType = "user" | "role";

export interface SearchMediaSyncAclSubjectsInput {
  requestingUserId: string;
  subjectType: MediaSyncAclSubjectType;
  query: string;
  page: number;
  perPage: number;
  requestId: string;
}

export interface MediaSyncAclSubjectSearchResult {
  subjects: Array<
    | { id: string; type: "user"; displayName: string; email?: string }
    | { id: string; type: "role"; displayName: string }
  >;
  page: number;
  perPage: number;
  hasMore: boolean;
}

export interface AccountAdminClient {
  verifyPermission(input: VerifyAccountPermissionInput): Promise<boolean>;
  searchMediaSyncAclSubjects?(
    input: SearchMediaSyncAclSubjectsInput
  ): Promise<MediaSyncAclSubjectSearchResult>;
  authorizeAdministrator(lineUserId: string): Promise<{ bound: boolean; allowed: boolean }>;
  authorizeFunctions(input: AuthorizeLineFunctionsInput): Promise<LineFunctionAuthorization>;
  verifyFunctionPermissions(input: VerifyLineFunctionPermissionsInput): Promise<FunctionName[]>;
  updateOwnProfile(input: UpdateOwnProfileInput): Promise<{ firstName: string; lastName: string }>;
  createBinding(input: CreateLineBindingInput): Promise<{ bindingUrl: string; expiresAt: string }>;
  finalizeBinding(input: FinalizeLineBindingInput): Promise<{ status: LineBindingTerminalStatus }>;
}

export class AccountApiError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

export function createAccountAdminClient(options: {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): AccountAdminClient {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post(
    path: string,
    body: object,
    headers: Record<string, string> = {}
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs)
      });
    } catch {
      throw new AccountApiError("account_api_transport_error", true);
    }
    if (!response.ok) {
      throw new AccountApiError(
        `account_api_http_${response.status}`,
        response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status <= 599)
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AccountApiError("account_api_invalid_json", false);
    }
  }

  return {
    async verifyPermission(input) {
      const payload = await post(
        "/priv/account/v1/permissions/verify",
        { userId: input.userId, permission: "media-sync:manage" },
        { "x-hhc-request-id": input.requestId }
      );
      if (!isExactRecord(payload, ["allowed"]) || typeof payload.allowed !== "boolean") {
        throw new AccountApiError("account_api_invalid_permission_decision", false);
      }
      return payload.allowed;
    },
    async searchMediaSyncAclSubjects(input) {
      const payload = await post(
        "/priv/account/v1/media-sync/acl-subjects/search",
        {
          requestingUserId: input.requestingUserId,
          subjectType: input.subjectType,
          query: input.query,
          page: input.page,
          perPage: input.perPage
        },
        { "x-hhc-request-id": input.requestId }
      );
      const result = parseMediaSyncAclSubjectSearch(payload, input);
      if (!result) {
        throw new AccountApiError("account_api_invalid_acl_subjects", false);
      }
      return result;
    },
    async authorizeAdministrator(lineUserId) {
      const payload = await post("/priv/account/v1/line/authorize", {
        line_user_id: lineUserId
      });
      if (!isAuthorization(payload)) {
        throw new AccountApiError("account_api_invalid_authorization", false);
      }
      return payload;
    },
    async authorizeFunctions(input) {
      const payload = await post("/priv/account/v1/line/authorize", {
        line_user_id: input.lineUserId,
        profile_name: input.profileName,
        function_names: input.functionNames
      });
      const authorization = parseFunctionAuthorization(payload, input.functionNames);
      if (!authorization) {
        throw new AccountApiError("account_api_invalid_function_authorization", false);
      }
      return authorization;
    },
    async verifyFunctionPermissions(input) {
      const payload = await post("/priv/account/v1/line/permissions/verify", {
        profile_name: input.profileName,
        function_names: input.functionNames
      });
      if (
        !isExactRecord(payload, ["configured_functions"]) ||
        !Array.isArray(payload.configured_functions) ||
        !isCanonicalAllowedFunctions(payload.configured_functions, input.functionNames)
      ) {
        throw new AccountApiError("account_api_invalid_permission_verification", false);
      }
      return payload.configured_functions;
    },
    async updateOwnProfile(input) {
      const payload = await post("/priv/account/v1/line/profile", {
        line_user_id: input.lineUserId,
        profile_name: input.profileName,
        first_name: input.firstName,
        last_name: input.lastName
      });
      const profile = parseOwnProfileResult(payload);
      if (!profile) {
        throw new AccountApiError("account_api_invalid_profile_update", false);
      }
      return profile;
    },
    async createBinding(input) {
      const payload = await post("/priv/account/v1/line/bindings", {
        expected_line_user_id: input.expectedLineUserId,
        profile_name: input.profileName,
        channel_id: input.channelId,
        line_account_name: input.presentation.displayName,
        line_account_id: input.presentation.lineId
      });
      if (!isBinding(payload)) {
        throw new AccountApiError("account_api_invalid_binding", false);
      }
      return {
        bindingUrl: payload.binding_url,
        expiresAt: payload.expires_at
      };
    },
    async finalizeBinding(input) {
      const payload = await post("/priv/account/v1/line/bindings/finalize", {
        nonce: input.nonce,
        result: input.result,
        ...(input.result === "ok" && input.actualLineUserId
          ? { actual_line_user_id: input.actualLineUserId }
          : {}),
        profile_name: input.profileName,
        channel_id: input.channelId,
        webhook_event_id: input.webhookEventId
      });
      if (!isFinalizeResult(payload)) {
        throw new AccountApiError("account_api_invalid_finalize", false);
      }
      return payload;
    }
  };
}

function parseMediaSyncAclSubjectSearch(
  value: unknown,
  input: SearchMediaSyncAclSubjectsInput
): MediaSyncAclSubjectSearchResult | undefined {
  if (!isExactRecord(value, ["subjects", "page", "perPage", "hasMore"])) return undefined;
  const { subjects, page, perPage, hasMore } = value;
  if (
    !Array.isArray(subjects) ||
    subjects.length > input.perPage ||
    page !== input.page ||
    perPage !== input.perPage ||
    typeof hasMore !== "boolean"
  ) {
    return undefined;
  }
  const parsed = [] as MediaSyncAclSubjectSearchResult["subjects"];
  for (const subject of subjects) {
    if (!subject || typeof subject !== "object" || Array.isArray(subject)) return undefined;
    const candidate = subject as Record<string, unknown>;
    const keys =
      candidate.type === "user" && candidate.email !== undefined
        ? ["id", "type", "displayName", "email"]
        : ["id", "type", "displayName"];
    if (!isExactRecord(candidate, keys)) return undefined;
    if (
      (candidate.type !== "user" && candidate.type !== "role") ||
      candidate.type !== input.subjectType ||
      !validAclSubjectText(candidate.id, 255) ||
      !validAclSubjectText(candidate.displayName, 2048) ||
      (candidate.email !== undefined && !validAclSubjectEmail(candidate.email))
    ) {
      return undefined;
    }
    if (candidate.type === "user") {
      parsed.push({
        id: candidate.id,
        type: "user",
        displayName: candidate.displayName,
        ...(candidate.email === undefined ? {} : { email: candidate.email })
      });
    } else {
      parsed.push({ id: candidate.id, type: "role", displayName: candidate.displayName });
    }
  }
  return { subjects: parsed, page, perPage, hasMore };
}

function validAclSubjectEmail(value: unknown): value is string {
  return validAclSubjectText(value, 320) && /^[^\s@]+@[^\s@]+$/u.test(value);
}

function validAclSubjectText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value !== "" &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/\p{Cc}|[\uD800-\uDFFF]/u.test(value)
  );
}

function parseOwnProfileResult(
  value: unknown
): { firstName: string; lastName: string } | undefined {
  if (!isExactRecord(value, ["first_name", "last_name", "updated_at"])) return undefined;
  const { first_name: firstName, last_name: lastName, updated_at: updatedAt } = value;
  return validProfileName(firstName) &&
    validProfileName(lastName) &&
    typeof updatedAt === "string" &&
    Number.isFinite(Date.parse(updatedAt))
    ? { firstName, lastName }
    : undefined;
}

function validProfileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Array.from(value).length <= 255 &&
    !/\p{Cc}|[\uD800-\uDFFF]/u.test(value)
  );
}

function parseFunctionAuthorization(
  value: unknown,
  requestedFunctions: readonly FunctionName[]
): LineFunctionAuthorization | undefined {
  if (!isExactRecord(value, ["bound", "active", "administrator", "allowed_functions", "account"])) {
    return undefined;
  }
  const { bound, active, administrator, allowed_functions: allowedFunctions, account } = value;
  if (
    typeof bound !== "boolean" ||
    typeof active !== "boolean" ||
    typeof administrator !== "boolean" ||
    !Array.isArray(allowedFunctions) ||
    !isCanonicalAllowedFunctions(allowedFunctions, requestedFunctions)
  ) {
    return undefined;
  }
  if (!bound || !active) {
    if (active || administrator || allowedFunctions.length > 0 || account !== undefined)
      return undefined;
    return { bound, active, administrator, allowedFunctions: [] };
  }
  const parsedAccount = parseAccountSummary(account);
  if (!parsedAccount) return undefined;
  return { bound, active, administrator, allowedFunctions, account: parsedAccount };
}

function isCanonicalAllowedFunctions(
  value: unknown[],
  requested: readonly FunctionName[]
): value is FunctionName[] {
  let previousIndex = -1;
  for (const candidate of value) {
    if (typeof candidate !== "string" || !isFunctionName(candidate)) return false;
    const index = requested.indexOf(candidate);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function parseAccountSummary(value: unknown): LineFunctionAuthorization["account"] | undefined {
  if (!isExactRecord(value, ["display_name", "masked_email", "roles"])) return undefined;
  const { display_name: displayName, masked_email: maskedEmail, roles } = value;
  if (
    typeof displayName !== "string" ||
    displayName.trim() !== displayName ||
    displayName.length === 0 ||
    displayName.length > 160 ||
    typeof maskedEmail !== "string" ||
    !isMaskedEmail(maskedEmail) ||
    !Array.isArray(roles) ||
    !roles.every((role) => role === "admin" || role === "user") ||
    new Set(roles).size !== roles.length ||
    roles.join(",") !== [...roles].sort().join(",")
  ) {
    return undefined;
  }
  return { displayName, maskedEmail, roles };
}

function isMaskedEmail(value: string): boolean {
  return value === "***" || /^.\*{3}@[^\s@]+$/u.test(value);
}

function isExactRecord(
  value: unknown,
  allowedKeys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowedKeys.includes(key)) &&
    allowedKeys.filter((key) => key !== "account").every((key) => keys.includes(key))
  );
}

function isAuthorization(value: unknown): value is { bound: boolean; allowed: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).bound === "boolean" &&
    typeof (value as Record<string, unknown>).allowed === "boolean"
  );
}

function isBinding(value: unknown): value is { binding_url: string; expires_at: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.binding_url === "string" &&
    isCanonicalBindingUrl(record.binding_url) &&
    typeof record.expires_at === "string" &&
    Number.isFinite(Date.parse(record.expires_at))
  );
}

function isCanonicalBindingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const entries = [...fragment.entries()];
    const token = entries[0]?.[1];
    return (
      url.protocol === "https:" &&
      url.hostname === "account.alive.org.tw" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/line/bind" &&
      url.search === "" &&
      entries.length === 1 &&
      entries[0]?.[0] === "token" &&
      typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      token.trim() === token &&
      !hasAsciiControl(token)
    );
  } catch {
    return false;
  }
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isFinalizeResult(value: unknown): value is { status: LineBindingTerminalStatus } {
  if (typeof value !== "object" || value === null) return false;
  return ["completed", "failed", "conflict", "expired"].includes(
    String((value as Record<string, unknown>).status)
  );
}
