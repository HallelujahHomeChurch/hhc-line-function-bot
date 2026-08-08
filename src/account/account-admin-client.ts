export type LineBindingTerminalStatus = "completed" | "failed" | "conflict" | "expired";

export interface CreateLineBindingInput {
  expectedLineUserId: string;
  profileName: string;
  channelId: string;
  lineLinkToken: string;
}

export interface FinalizeLineBindingInput {
  nonce: string;
  result: "ok" | "failed";
  actualLineUserId?: string;
  profileName: string;
  channelId: string;
  webhookEventId: string;
}

export interface AccountAdminClient {
  authorizeAdministrator(lineUserId: string): Promise<{ bound: boolean; allowed: boolean }>;
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

  async function post(path: string, body: object): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
    async authorizeAdministrator(lineUserId) {
      const payload = await post("/priv/account/v1/line/authorize", {
        line_user_id: lineUserId
      });
      if (!isAuthorization(payload)) {
        throw new AccountApiError("account_api_invalid_authorization", false);
      }
      return payload;
    },
    async createBinding(input) {
      const payload = await post("/priv/account/v1/line/bindings", {
        expected_line_user_id: input.expectedLineUserId,
        profile_name: input.profileName,
        channel_id: input.channelId,
        line_link_token: input.lineLinkToken
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
