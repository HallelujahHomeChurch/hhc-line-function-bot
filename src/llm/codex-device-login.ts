import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelProviderName } from "../types.js";

export const DEFAULT_CODEX_AUTH_ISSUER = "https://auth.openai.com";
export const DEFAULT_CODEX_LOGIN_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_CODEX_DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
export const CODEX_DEVICE_LOGIN_USER_AGENT = "codex_cli_rs/0.142.5";

export type CodexLoginStartStatus = "started" | "already_active" | "already_logged_in";

export interface CodexLoginStartInput {
  codexHome?: string;
  clientId?: string;
  issuer?: string;
  ttlMs?: number;
}

export interface CodexLoginStartResult {
  status: CodexLoginStartStatus;
  provider: Extract<ModelProviderName, "codex_app_server">;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  email?: string;
  accountId?: string;
  plan?: string;
}

export interface CodexAuthStatus {
  loggedIn: boolean;
  email?: string;
  accountId?: string;
  plan?: string;
}

export interface CodexLogoutResult {
  removed: boolean;
}

export interface ProviderLoginManager {
  startCodexLogin(input: CodexLoginStartInput): Promise<CodexLoginStartResult>;
  getCodexStatus(input: { codexHome?: string }): Promise<CodexAuthStatus>;
  logoutCodex(input: { codexHome?: string }): Promise<CodexLogoutResult>;
}

export interface CodexDeviceLoginManagerOptions {
  fetchImpl?: typeof fetch;
  schedule?: (runner: () => Promise<void>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface ActiveLogin {
  key: string;
  codexHome: string;
  issuer: string;
  clientId: string;
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAtMs: number;
  expiresAt: string;
}

interface UserCodeResponse {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

export function createCodexDeviceLoginManager(
  options: CodexDeviceLoginManagerOptions = {}
): ProviderLoginManager {
  return new CodexDeviceLoginManager(options);
}

class CodexDeviceLoginManager implements ProviderLoginManager {
  private readonly activeLogins = new Map<string, ActiveLogin>();
  private readonly fetchImpl: typeof fetch;
  private readonly schedule: (runner: () => Promise<void>) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: CodexDeviceLoginManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.schedule =
      options.schedule ??
      ((runner) => {
        void runner();
      });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  async startCodexLogin(input: CodexLoginStartInput): Promise<CodexLoginStartResult> {
    const codexHome = resolveCodexHome(input.codexHome);
    const issuer = normalizeIssuer(input.issuer);
    const clientId = input.clientId || DEFAULT_CODEX_LOGIN_CLIENT_ID;
    const ttlMs = input.ttlMs ?? DEFAULT_CODEX_DEVICE_LOGIN_TTL_MS;
    const key = loginKey(codexHome, issuer, clientId);
    const nowMs = this.now().getTime();
    const existing = this.activeLogins.get(key);
    if (existing && existing.expiresAtMs > nowMs) {
      return {
        status: "already_active",
        provider: "codex_app_server",
        verificationUrl: existing.verificationUrl,
        userCode: existing.userCode,
        expiresAt: existing.expiresAt
      };
    }
    this.activeLogins.delete(key);

    const authStatus = await this.getCodexStatus({ codexHome });
    if (authStatus.loggedIn) {
      return {
        status: "already_logged_in",
        provider: "codex_app_server",
        email: authStatus.email,
        accountId: authStatus.accountId,
        plan: authStatus.plan
      };
    }

    const userCode = await this.requestUserCode(issuer, clientId);
    const expiresAtMs = nowMs + ttlMs;
    const login: ActiveLogin = {
      key,
      codexHome,
      issuer,
      clientId,
      deviceAuthId: userCode.deviceAuthId,
      userCode: userCode.userCode,
      verificationUrl: `${issuer}/codex/device`,
      intervalMs: Math.max(userCode.intervalSeconds, 1) * 1000,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
    this.activeLogins.set(key, login);
    this.schedule(async () => this.pollUntilComplete(login));
    return {
      status: "started",
      provider: "codex_app_server",
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      expiresAt: login.expiresAt
    };
  }

  async getCodexStatus(input: { codexHome?: string }): Promise<CodexAuthStatus> {
    return readCodexAuthStatus(input.codexHome);
  }

  async logoutCodex(input: { codexHome?: string }): Promise<CodexLogoutResult> {
    const authFile = authFilePath(input.codexHome);
    try {
      await readFile(authFile, "utf8");
      await rm(authFile, { force: true });
      return { removed: true };
    } catch {
      return { removed: false };
    }
  }

  private async requestUserCode(
    issuer: string,
    clientId: string
  ): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds: number }> {
    const response = await this.fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: codexJsonHeaders(),
      body: JSON.stringify({ client_id: clientId })
    });
    if (!response.ok) {
      throw new Error(
        `Codex device code request failed: http_${response.status}:${await readFailureMarker(response)}`
      );
    }
    const payload = (await response.json()) as UserCodeResponse;
    const deviceAuthId = payload.device_auth_id?.trim();
    const userCode = (payload.user_code ?? payload.usercode)?.trim();
    if (!deviceAuthId || !userCode) {
      throw new Error("Codex device code response is missing required fields");
    }
    return {
      deviceAuthId,
      userCode,
      intervalSeconds: parseIntervalSeconds(payload.interval)
    };
  }

  private async pollUntilComplete(login: ActiveLogin): Promise<void> {
    try {
      while (this.now().getTime() <= login.expiresAtMs) {
        const response = await this.fetchImpl(`${login.issuer}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: codexJsonHeaders(),
          body: JSON.stringify({
            device_auth_id: login.deviceAuthId,
            user_code: login.userCode
          })
        });
        if (response.ok) {
          const payload = (await response.json()) as DeviceTokenResponse;
          await this.exchangeAndPersist(login, payload);
          return;
        }
        if (response.status !== 403 && response.status !== 404) {
          throw new Error(`Codex device auth failed: http_${response.status}`);
        }
        await this.sleep(
          Math.min(login.intervalMs, Math.max(login.expiresAtMs - this.now().getTime(), 0))
        );
      }
      throw new Error("Codex device auth timed out");
    } catch {
      // Keep auth failures out of LINE replies and logs; admins can retry /llm-login codex.
    } finally {
      this.activeLogins.delete(login.key);
    }
  }

  private async exchangeAndPersist(
    login: ActiveLogin,
    payload: DeviceTokenResponse
  ): Promise<void> {
    const authorizationCode = payload.authorization_code?.trim();
    const codeVerifier = payload.code_verifier?.trim();
    if (!authorizationCode || !codeVerifier) {
      throw new Error("Codex device token response is missing required fields");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${login.issuer}/deviceauth/callback`,
      client_id: login.clientId,
      code_verifier: codeVerifier
    });
    const response = await this.fetchImpl(`${login.issuer}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": CODEX_DEVICE_LOGIN_USER_AGENT
      },
      body: form.toString()
    });
    if (!response.ok) {
      throw new Error(`Codex token exchange failed: http_${response.status}`);
    }
    const tokens = (await response.json()) as TokenResponse;
    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
      throw new Error("Codex token exchange response is missing required fields");
    }
    await writeCodexAuth({
      codexHome: login.codexHome,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      now: this.now()
    });
  }
}

export async function readCodexAuthStatus(codexHome?: string): Promise<CodexAuthStatus> {
  try {
    const auth = JSON.parse(await readFile(authFilePath(codexHome), "utf8")) as {
      auth_mode?: string;
      tokens?: {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };
    if (
      auth.auth_mode !== "chatgpt" ||
      !auth.tokens?.id_token ||
      !auth.tokens.access_token ||
      !auth.tokens.refresh_token
    ) {
      return { loggedIn: false };
    }
    const claims = decodeJwtPayload(auth.tokens.id_token);
    const authClaims = readAuthClaims(claims);
    return {
      loggedIn: true,
      email: readEmail(claims),
      accountId: auth.tokens.account_id ?? authClaims.chatgpt_account_id,
      plan: authClaims.chatgpt_plan_type
    };
  } catch {
    return { loggedIn: false };
  }
}

async function writeCodexAuth(input: {
  codexHome: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  now: Date;
}): Promise<void> {
  const claims = decodeJwtPayload(input.idToken);
  const accountId = readAuthClaims(claims).chatgpt_account_id;
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: input.idToken,
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      account_id: accountId
    },
    last_refresh: input.now.toISOString()
  };
  await mkdir(input.codexHome, { recursive: true });
  await writeFile(join(input.codexHome, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600
  });
}

function authFilePath(codexHome?: string): string {
  return join(resolveCodexHome(codexHome), "auth.json");
}

function resolveCodexHome(codexHome?: string): string {
  return codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function normalizeIssuer(value?: string): string {
  return (value?.trim() || DEFAULT_CODEX_AUTH_ISSUER).replace(/\/+$/, "");
}

function loginKey(codexHome: string, issuer: string, clientId: string): string {
  return `${codexHome}|${issuer}|${clientId}`;
}

function parseIntervalSeconds(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseInt(String(value ?? "5"), 10);
  return Number.isFinite(parsed) ? parsed : 5;
}

function codexJsonHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": CODEX_DEVICE_LOGIN_USER_AGENT
  };
}

async function readFailureMarker(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const server = response.headers.get("server") ?? "";
  const text = await response.text().catch(() => "");
  const lower = text.toLowerCase();
  const markers: string[] = [];
  if (contentType.includes("html")) {
    markers.push("html");
  }
  if (server) {
    markers.push(`server_${safeMarker(server)}`);
  }
  if (lower.includes("cloudflare")) {
    markers.push("cloudflare");
  }
  if (lower.includes("just a moment")) {
    markers.push("challenge");
  }
  if (lower.includes("access denied") || lower.includes("forbidden")) {
    markers.push("forbidden");
  }
  return markers.length > 0 ? markers.join("_") : "no_marker";
}

function safeMarker(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) {
    throw new Error("invalid JWT payload");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function readEmail(claims: Record<string, unknown>): string | undefined {
  if (typeof claims.email === "string") {
    return claims.email;
  }
  const profile = claims["https://api.openai.com/profile"];
  return isRecord(profile) && typeof profile.email === "string" ? profile.email : undefined;
}

function readAuthClaims(claims: Record<string, unknown>): {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
} {
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth)) {
    return {};
  }
  return {
    chatgpt_account_id:
      typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
    chatgpt_plan_type:
      typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
