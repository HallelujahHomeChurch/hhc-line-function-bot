export interface AccountAdminClient {
  authorizeAdministrator(lineUserId: string): Promise<{ bound: boolean; allowed: boolean }>;
  createBinding(
    lineUserId: string,
    profileName: string
  ): Promise<{ bindingUrl: string; expiresAt: string }>;
}

export function createAccountAdminClient(options: {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): AccountAdminClient {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post(path: string, body: object): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-caller-app-id": "hhc-line-function-bot"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`account_api_http_${response.status}`);
    }
    return response.json();
  }

  return {
    async authorizeAdministrator(lineUserId) {
      const payload = await post("/priv/account/v1/line/authorize", {
        line_user_id: lineUserId
      });
      if (!isAuthorization(payload)) {
        throw new Error("account_api_invalid_authorization");
      }
      return payload;
    },
    async createBinding(lineUserId, profileName) {
      const payload = await post("/priv/account/v1/line/bindings", {
        line_user_id: lineUserId,
        profile_name: profileName
      });
      if (!isBinding(payload)) {
        throw new Error("account_api_invalid_binding");
      }
      return {
        bindingUrl: payload.binding_url,
        expiresAt: payload.expires_at
      };
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
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).binding_url === "string" &&
    typeof (value as Record<string, unknown>).expires_at === "string"
  );
}
