import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexDeviceLoginManager } from "../llm/codex-device-login.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  tempDirs.length = 0;
});

async function tempCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), "hhc-codex-login-test-"));
  tempDirs.push(dir);
  return dir;
}

function fakeJwt(claims: Record<string, unknown> = {}) {
  const payload = {
    email: "ray@example.test",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_user_id: "user-1",
      chatgpt_account_id: "account-1",
      ...claims
    }
  };
  return [
    base64Url(JSON.stringify({ alg: "none" })),
    base64Url(JSON.stringify(payload)),
    "signature"
  ].join(".");
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function writeCodexAuthFixture(input: {
  codexHome: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  now: Date;
}) {
  const claims = JSON.parse(Buffer.from(input.idToken.split(".")[1] ?? "", "base64url").toString());
  const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: string };
  await writeFile(
    join(input.codexHome, "auth.json"),
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: input.idToken,
          access_token: input.accessToken,
          refresh_token: input.refreshToken,
          account_id: auth.chatgpt_account_id
        },
        last_refresh: input.now.toISOString()
      },
      null,
      2
    )}\n`
  );
}

describe("Codex device login manager", () => {
  it("starts a Codex device login and persists auth.json after polling succeeds", async () => {
    const codexHome = await tempCodexHome();
    const pollers: Array<() => Promise<void>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "codex_cli_rs/0.142.5"
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: "app_test"
        });
        return jsonResponse({
          device_auth_id: "device-1",
          user_code: "ABCD-EFGH",
          interval: "1"
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        expect(init?.headers).toEqual({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "codex_cli_rs/0.142.5"
        });
        return jsonResponse({
          authorization_code: "auth-code",
          code_challenge: "challenge",
          code_verifier: "verifier"
        });
      }
      if (url.endsWith("/oauth/token")) {
        expect(init?.headers).toEqual({
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "codex_cli_rs/0.142.5"
        });
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("auth-code");
        expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
        expect(form.get("client_id")).toBe("app_test");
        expect(form.get("code_verifier")).toBe("verifier");
        return jsonResponse({
          id_token: fakeJwt(),
          access_token: "access-token",
          refresh_token: "refresh-token"
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const manager = createCodexDeviceLoginManager({
      fetchImpl,
      schedule: (runner) => pollers.push(runner),
      sleep: async () => undefined,
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });

    const start = await manager.startCodexLogin({
      codexHome,
      clientId: "app_test",
      issuer: "https://auth.openai.com",
      ttlMs: 900_000
    });

    expect(start.status).toBe("started");
    expect(start.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(start.userCode).toBe("ABCD-EFGH");
    expect(start.expiresAt).toBe("2026-07-09T00:15:00.000Z");
    expect(pollers).toHaveLength(1);

    await pollers[0]();

    const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as {
      auth_mode?: string;
      tokens?: {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
      last_refresh?: string;
    };
    expect(auth.auth_mode).toBe("chatgpt");
    expect(auth.tokens?.access_token).toBe("access-token");
    expect(auth.tokens?.refresh_token).toBe("refresh-token");
    expect(auth.tokens?.id_token).toMatch(/^ey/);
    expect(auth.tokens?.account_id).toBe("account-1");
    expect(auth.last_refresh).toBe("2026-07-09T00:00:00.000Z");
  });

  it("reuses an active login instead of starting a second device flow", async () => {
    const codexHome = await tempCodexHome();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        device_auth_id: "device-1",
        user_code: "ABCD-EFGH",
        interval: "1"
      })
    );
    const manager = createCodexDeviceLoginManager({
      fetchImpl,
      schedule: () => undefined,
      now: () => new Date("2026-07-09T00:00:00.000Z")
    });

    const first = await manager.startCodexLogin({
      codexHome,
      clientId: "app_test",
      issuer: "https://auth.openai.com",
      ttlMs: 900_000
    });
    const second = await manager.startCodexLogin({
      codexHome,
      clientId: "app_test",
      issuer: "https://auth.openai.com",
      ttlMs: 900_000
    });

    expect(first.status).toBe("started");
    expect(second.status).toBe("already_active");
    expect(second.userCode).toBe("ABCD-EFGH");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not start a new device flow when CODEX_HOME is already logged in", async () => {
    const codexHome = await tempCodexHome();
    await writeCodexAuthFixture({
      codexHome,
      idToken: fakeJwt(),
      accessToken: "access",
      refreshToken: "refresh",
      now: new Date("2026-07-09T00:00:00.000Z")
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = createCodexDeviceLoginManager({ fetchImpl });

    const result = await manager.startCodexLogin({
      codexHome,
      clientId: "app_test",
      issuer: "https://auth.openai.com",
      ttlMs: 900_000
    });

    expect(result).toEqual({
      status: "already_logged_in",
      provider: "codex_app_server",
      email: "ray@example.test",
      accountId: "account-1",
      plan: "pro"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("includes a safe response marker when the device code request is rejected", async () => {
    const codexHome = await tempCodexHome();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("<html>Just a moment... Cloudflare access denied</html>", {
          status: 403,
          headers: {
            "content-type": "text/html",
            server: "cloudflare"
          }
        })
    );
    const manager = createCodexDeviceLoginManager({ fetchImpl });

    await expect(
      manager.startCodexLogin({
        codexHome,
        clientId: "app_test",
        issuer: "https://auth.openai.com",
        ttlMs: 900_000
      })
    ).rejects.toThrow(
      "Codex device code request failed: http_403:html_server_cloudflare_cloudflare_challenge_forbidden"
    );
  });

  it("reports and clears Codex auth status from CODEX_HOME", async () => {
    const codexHome = await tempCodexHome();
    const manager = createCodexDeviceLoginManager();

    await writeCodexAuthFixture({
      codexHome,
      idToken: fakeJwt({ chatgpt_account_id: "account-2" }),
      accessToken: "access",
      refreshToken: "refresh",
      now: new Date("2026-07-09T00:00:00.000Z")
    });

    await expect(manager.getCodexStatus({ codexHome })).resolves.toEqual({
      loggedIn: true,
      email: "ray@example.test",
      accountId: "account-2",
      plan: "pro"
    });
    await expect(manager.logoutCodex({ codexHome })).resolves.toEqual({ removed: true });
    await expect(manager.getCodexStatus({ codexHome })).resolves.toEqual({ loggedIn: false });
  });
});
