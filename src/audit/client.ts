import { internalDiagnosticFetch } from "../observability/http-diagnostics.js";
export type AuditAppendResult =
  | { status: "delivered" }
  | { status: "retry"; reason: string; retryAfterMs?: number }
  | { status: "terminal"; reason: string };

export function createAuditClient(options: {
  appId: "audit-log" | "audit-log-test";
  token: string;
  daprHttpPort: number;
  privateBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): { append(payload: string): Promise<AuditAppendResult> } {
  if (
    !Number.isInteger(options.daprHttpPort) ||
    options.daprHttpPort < 1 ||
    options.daprHttpPort > 65_535
  ) {
    throw new Error("audit_dapr_port_invalid");
  }
  if (!options.token.trim() || options.token.includes("\n") || options.token.includes("\r")) {
    throw new Error("audit_token_invalid");
  }
  const privateBaseUrl = options.privateBaseUrl;
  if (
    privateBaseUrl !== undefined &&
    (options.appId !== "audit-log" ||
      !/^https:\/\/audit-log\.internal\.[a-z0-9-]+\.[a-z0-9-]+\.azurecontainerapps\.io$/u.test(
        privateBaseUrl
      ))
  ) {
    throw new Error("audit_https_origin_invalid");
  }
  const baseUrl =
    privateBaseUrl ??
    `http://127.0.0.1:${options.daprHttpPort}/v1.0/invoke/${options.appId}/method`;
  const endpoint = baseUrl + "/priv/audit/events";
  const fetchImpl = internalDiagnosticFetch(options.fetchImpl ?? fetch);
  return {
    async append(payload) {
      if (Buffer.byteLength(payload) > 32 * 1024) {
        return { status: "terminal", reason: "payload_too_large" };
      }
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-audit-token": options.token,
            ...(privateBaseUrl === undefined
              ? {}
              : { "x-hhc-audit-caller": "hhc-line-function-bot" })
          },
          body: payload,
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 3_000)
        });
      } catch {
        return { status: "retry", reason: "transport" };
      }
      if (response.status === 200 || response.status === 201) return { status: "delivered" };
      const reason = `http_${response.status}`;
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500 ||
        (privateBaseUrl !== undefined && (response.status === 401 || response.status === 403))
      ) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        return {
          status: "retry",
          reason,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs })
        };
      }
      return { status: "terminal", reason };
    }
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 21_600_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 21_600_000);
}
