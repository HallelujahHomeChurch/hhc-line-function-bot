import {
  assessClamAvSignatureManifest,
  type ClamAvSignatureHealth
} from "../attachments/clamav-signature-policy.js";
import { signLineBody } from "../line-signature.js";

export type ReleaseProbeCheckName =
  | "bot_health"
  | "bot_readiness"
  | "searxng_root"
  | "gateway_helper_signed_empty_webhook"
  | "gateway_main_signed_empty_webhook"
  | "clamav_signature";
export type ReleaseProbeCheckStatus = "passed" | "failed" | "warning";
export type ReleaseProbeFailureCode =
  | "none"
  | "timeout"
  | "http_mismatch"
  | "malformed_json"
  | "network_failed"
  | "clamav_manifest_invalid"
  | "contract_mismatch"
  | "signature_warning";

export interface ReleaseProbeInput {
  botBaseUrl: string;
  searxngBaseUrl: string;
  gatewayWebhookUrl: string;
  gatewayMainWebhookUrl: string;
  lineHelperChannelSecret: string;
  lineMainEmptyWebhookSignature: string;
  clamavSignatureManifestPath: string;
  timeoutMs?: number;
}

export interface ReleaseProbeDependencies {
  fetch: typeof globalThis.fetch;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  now: () => Date;
}

export interface ReleaseProbeCheckResult {
  name: ReleaseProbeCheckName;
  status: ReleaseProbeCheckStatus;
  code: ReleaseProbeFailureCode;
  signatureHealth?: ClamAvSignatureHealth;
}

export interface ReleaseProbeResult {
  status: "passed" | "failed";
  checks: ReleaseProbeCheckResult[];
}

const EMPTY_EVENT_BODY = '{"events":[]}';
const DEFAULT_TIMEOUT_MS = 5_000;

export async function runReleaseProbe(
  input: ReleaseProbeInput,
  dependencies: ReleaseProbeDependencies
): Promise<ReleaseProbeResult> {
  const timeoutMs = validTimeout(input.timeoutMs);
  const mainSignature = validLineSignature(input.lineMainEmptyWebhookSignature);
  const checks = await Promise.all([
    checkJsonEndpoint(
      "bot_health",
      endpoint(input.botBaseUrl, "/healthz"),
      dependencies,
      timeoutMs,
      isHealthy
    ),
    checkJsonEndpoint(
      "bot_readiness",
      endpoint(input.botBaseUrl, "/readyz"),
      dependencies,
      timeoutMs,
      isReady
    ),
    checkSearxng(endpoint(input.searxngBaseUrl, "/"), dependencies, timeoutMs),
    checkWebhook(
      "gateway_helper_signed_empty_webhook",
      input.gatewayWebhookUrl,
      signLineBody(Buffer.from(EMPTY_EVENT_BODY), input.lineHelperChannelSecret),
      dependencies,
      timeoutMs
    ),
    checkWebhook(
      "gateway_main_signed_empty_webhook",
      input.gatewayMainWebhookUrl,
      mainSignature,
      dependencies,
      timeoutMs
    ),
    checkSignatureManifest(input.clamavSignatureManifestPath, dependencies)
  ]);
  return {
    status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    checks
  };
}

async function checkJsonEndpoint(
  name: "bot_health" | "bot_readiness",
  url: string,
  dependencies: ReleaseProbeDependencies,
  timeoutMs: number,
  contract: (body: unknown) => boolean
): Promise<ReleaseProbeCheckResult> {
  try {
    const response = await dependencies.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return failed(name, "http_mismatch");
    const body = await json(response);
    return contract(body) ? passed(name) : failed(name, "contract_mismatch");
  } catch (error) {
    return failed(name, failureFrom(error));
  }
}

async function checkSearxng(
  url: string,
  dependencies: ReleaseProbeDependencies,
  timeoutMs: number
): Promise<ReleaseProbeCheckResult> {
  try {
    const response = await dependencies.fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual"
    });
    return response.status >= 200 && response.status < 400
      ? passed("searxng_root")
      : failed("searxng_root", "http_mismatch");
  } catch (error) {
    return failed("searxng_root", failureFrom(error));
  }
}

async function checkWebhook(
  name: "gateway_helper_signed_empty_webhook" | "gateway_main_signed_empty_webhook",
  url: string,
  signature: string,
  dependencies: ReleaseProbeDependencies,
  timeoutMs: number
): Promise<ReleaseProbeCheckResult> {
  try {
    const response = await dependencies.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-line-signature": signature
      },
      body: EMPTY_EVENT_BODY,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200) return failed(name, "http_mismatch");
    const body = await json(response);
    return isIgnoredEmptyEvent(body) ? passed(name) : failed(name, "contract_mismatch");
  } catch (error) {
    return failed(name, failureFrom(error));
  }
}

async function checkSignatureManifest(
  manifestPath: string,
  dependencies: ReleaseProbeDependencies
): Promise<ReleaseProbeCheckResult> {
  try {
    const value = JSON.parse(await dependencies.readFile(manifestPath, "utf8")) as unknown;
    const assessment = assessClamAvSignatureManifest(value, dependencies.now());
    if (assessment.status !== "usable")
      return failed("clamav_signature", "clamav_manifest_invalid");
    return assessment.health === "current"
      ? { ...passed("clamav_signature"), signatureHealth: "current" }
      : {
          name: "clamav_signature",
          status: "warning",
          code: "signature_warning",
          signatureHealth: "warning"
        };
  } catch {
    return failed("clamav_signature", "clamav_manifest_invalid");
  }
}

function isHealthy(value: unknown): boolean {
  return isRecord(value) && value.ok === true && value.service === "hhc-line-function-bot";
}

function isReady(value: unknown): boolean {
  if (!isRecord(value) || value.status !== "ok" || !isRecord(value.database)) return false;
  return (
    isRecord(value.database.postgres) &&
    value.database.postgres.status === "ok" &&
    isRecord(value.database.redis) &&
    value.database.redis.status === "ok"
  );
}

function isIgnoredEmptyEvent(value: unknown): boolean {
  return isRecord(value) && value.ok === true && value.ignored === true;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProbeJsonError();
  }
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function validTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("release_probe_invalid_input");
  return value;
}

function validLineSignature(value: string): string {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("release_probe_invalid_input");
  }
  return value;
}

function failureFrom(
  error: unknown
): Exclude<ReleaseProbeFailureCode, "none" | "signature_warning" | "clamav_manifest_invalid"> {
  if (error instanceof ProbeJsonError) return "malformed_json";
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "timeout";
  }
  return "network_failed";
}

function passed(name: ReleaseProbeCheckName): ReleaseProbeCheckResult {
  return { name, status: "passed", code: "none" };
}

function failed(
  name: ReleaseProbeCheckName,
  code: Exclude<ReleaseProbeFailureCode, "none" | "signature_warning">
): ReleaseProbeCheckResult {
  return { name, status: "failed", code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProbeJsonError extends Error {}
