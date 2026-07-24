import { MODEL_PROVIDER_LANE_NAMES } from "./types.js";
import type {
  AdminHandler,
  BotProfileConfig,
  FunctionExecutionResult,
  LlmConfig
} from "./types.js";

export interface LlmStatusAdminHandlerOptions {
  fetchImpl?: typeof fetch;
}

interface ProbeResult {
  status: "ok" | "error" | "skipped";
  httpStatus?: number;
  latencyMs?: number;
  detail?: string;
}

export function createLlmStatusAdminHandler(
  config: LlmConfig,
  options: LlmStatusAdminHandlerOptions = {}
): AdminHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (context): Promise<FunctionExecutionResult> =>
    probeDeepSeekStatus(fetchImpl, config, context.profile);
}

async function probeDeepSeekStatus(
  fetchImpl: typeof fetch,
  config: LlmConfig,
  profile: BotProfileConfig
): Promise<FunctionExecutionResult> {
  const baseUrl = normalizeBaseUrl(config.deepseekBaseUrl);
  const endpoint = describeEndpoint(baseUrl);
  const configured = Boolean(config.deepseekApiKey);
  const chat = configured
    ? await probeDeepSeekChat(fetchImpl, baseUrl, config)
    : skippedProbe("missing api key");

  return {
    ok: true,
    replyText: [
      "LLM status",
      "provider: deepseek",
      `endpoint: ${endpoint.scheme}:${endpoint.port}`,
      `host: ${endpoint.hostClass}`,
      `model: ${config.deepseekModel}`,
      `apiKey: ${configured ? "configured" : "missing"}`,
      "fallback: none",
      ...formatProfileProviderPolicy(profile),
      formatProbe("chat", chat)
    ].join("\n")
  };
}

function formatProfileProviderPolicy(profile: BotProfileConfig): string[] {
  const lines = [`profile: ${profile.name}`];
  const policy = profile.providerPolicy;
  if (!policy) return [...lines, "lanes: not configured"];
  return [
    ...lines,
    "lanes:",
    ...MODEL_PROVIDER_LANE_NAMES.map((lane) => {
      const lanePolicy = policy[lane];
      return `- ${lane}: ${lanePolicy?.primary ?? "not configured"}`;
    })
  ];
}

async function probeDeepSeekChat(
  fetchImpl: typeof fetch,
  baseUrl: string,
  config: LlmConfig
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.deepseekApiKey ?? ""}`
        },
        body: JSON.stringify({
          model: config.deepseekModel,
          stream: false,
          temperature: 0,
          max_tokens: 16,
          thinking: { type: "disabled" },
          messages: [
            { role: "system", content: "Reply ok." },
            { role: "user", content: "ping" }
          ]
        })
      },
      config.deepseekTimeoutMs
    );
    const latencyMs = elapsedMs(startedAt);
    if (!response.ok) {
      return {
        status: "error",
        httpStatus: response.status,
        latencyMs,
        detail: `http_${response.status}`
      };
    }
    await response.json();
    return { status: "ok", httpStatus: response.status, latencyMs };
  } catch (error) {
    return {
      status: "error",
      latencyMs: elapsedMs(startedAt),
      detail: safeErrorMessage(error, baseUrl)
    };
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatProbe(label: string, result: ProbeResult): string {
  if (result.status === "skipped") return `${label}: skipped (${result.detail ?? "not run"})`;
  const meta = [
    result.httpStatus ? `http ${result.httpStatus}` : undefined,
    typeof result.latencyMs === "number" ? `${result.latencyMs}ms` : undefined,
    result.detail
  ].filter(Boolean);
  return `${label}: ${result.status}${meta.length ? ` (${meta.join(", ")})` : ""}`;
}

function skippedProbe(detail: string): ProbeResult {
  return { status: "skipped", detail };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/u, "");
}

function describeEndpoint(baseUrl: string): { scheme: string; port: string; hostClass: string } {
  const url = new URL(baseUrl);
  const scheme = url.protocol.replace(/:$/u, "");
  const port = url.port || (scheme === "https" ? "443" : "80");
  return { scheme, port, hostClass: url.hostname.includes(".") ? "remote" : "local" };
}

function safeErrorMessage(error: unknown, baseUrl: string): string {
  const raw = error instanceof Error ? error.message : "error";
  return raw.replaceAll(baseUrl, "[deepseek-base-url]").slice(0, 160);
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
