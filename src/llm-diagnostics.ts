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
  modelCount?: number;
  modelPresent?: boolean;
}

export function createLlmStatusAdminHandler(
  config: LlmConfig,
  options: LlmStatusAdminHandlerOptions = {}
): AdminHandler {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (context): Promise<FunctionExecutionResult> => {
    if (config.provider === "deepseek") {
      return probeDeepSeekStatus(fetchImpl, config, context.profile);
    }
    const baseUrl = normalizeBaseUrl(config.ollamaBaseUrl);
    const endpoint = describeEndpoint(baseUrl);
    const tags = await probeTags(fetchImpl, baseUrl, config);
    const chat =
      tags.status === "ok"
        ? await probeChat(fetchImpl, baseUrl, config)
        : skippedProbe("tags failed");

    return {
      ok: true,
      replyText: [
        "LLM status",
        `provider: ${config.provider ?? "ollama"}`,
        `endpoint: ${endpoint.scheme}:${endpoint.port}`,
        `host: ${endpoint.hostClass}`,
        `model: ${config.ollamaModel}`,
        `fallback: ${config.keywordFallbackEnabled ? "keyword" : "disabled"}`,
        ...formatProfileProviderPolicy(context.profile),
        formatTags(tags),
        `modelPresent: ${tags.modelPresent ?? "unknown"}`,
        `modelCount: ${tags.modelCount ?? "unknown"}`,
        formatChat(chat)
      ].join("\n")
    };
  };
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
      `fallback: ${config.fallbackProvider ?? "ollama"}`,
      ...formatProfileProviderPolicy(profile),
      formatChat(chat)
    ].join("\n")
  };
}

function formatProfileProviderPolicy(profile: BotProfileConfig): string[] {
  const lines = [`profile: ${profile.name}`];
  const policy = profile.providerPolicy;
  if (!policy) {
    return [...lines, "lanes: not configured"];
  }
  return [
    ...lines,
    "lanes:",
    ...MODEL_PROVIDER_LANE_NAMES.map((lane) => {
      const lanePolicy = policy[lane];
      const route = lanePolicy.fallback
        ? `${lanePolicy.primary} -> ${lanePolicy.fallback}`
        : lanePolicy.primary;
      return `- ${lane}: ${route}`;
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

async function probeTags(
  fetchImpl: typeof fetch,
  baseUrl: string,
  config: LlmConfig
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/tags`, {}, config.timeoutMs);
    const latencyMs = elapsedMs(startedAt);
    if (!response.ok) {
      return {
        status: "error",
        httpStatus: response.status,
        latencyMs,
        detail: `http_${response.status}`
      };
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(payload.models) ? payload.models : [];
    return {
      status: "ok",
      httpStatus: response.status,
      latencyMs,
      modelCount: models.length,
      modelPresent: models.some((model) => model.name === config.ollamaModel)
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: elapsedMs(startedAt),
      detail: safeErrorMessage(error, baseUrl)
    };
  }
}

async function probeChat(
  fetchImpl: typeof fetch,
  baseUrl: string,
  config: LlmConfig
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: config.ollamaModel,
    stream: false,
    think: false,
    options: {
      temperature: 0,
      num_predict: 32
    },
    messages: [
      { role: "system", content: "Return exactly one JSON object and no markdown." },
      { role: "user", content: 'Return {"action":"deny","reason":"diagnostic"}.' }
    ],
    format: "json"
  };
  if (config.ollamaKeepAlive !== undefined) {
    body.keep_alive = config.ollamaKeepAlive;
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      config.timeoutMs
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

function formatTags(result: ProbeResult): string {
  return formatProbe("tags", result);
}

function formatChat(result: ProbeResult): string {
  return formatProbe("chat", result);
}

function formatProbe(label: string, result: ProbeResult): string {
  if (result.status === "skipped") {
    return `${label}: skipped (${result.detail ?? "not run"})`;
  }
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

function describeEndpoint(baseUrl: string): { scheme: string; hostClass: string; port: string } {
  const url = new URL(baseUrl);
  return {
    scheme: url.protocol.replace(":", ""),
    hostClass: classifyHost(url.hostname),
    port: url.port || defaultPort(url.protocol)
  };
}

function classifyHost(host: string): string {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "loopback";
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    return "private-ip";
  }
  return "dns-or-public";
}

function defaultPort(protocol: string): string {
  if (protocol === "https:") {
    return "443";
  }
  return "80";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeErrorMessage(error: unknown, baseUrl: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(baseUrl, "[ollama-base-url]").slice(0, 160);
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
