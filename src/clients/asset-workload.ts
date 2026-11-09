import { validateInternalServiceOrigin } from "./internal-origin.js";
import { ManagedIdentityCredential } from "@azure/identity";
import type { AssetWorkloadAuth } from "../types.js";

export function readAssetWorkloadAuth(env: NodeJS.ProcessEnv): AssetWorkloadAuth | undefined {
  const enabled = env.ASSET_WORKLOAD_AUTH_ENABLED?.trim() ?? "false";
  if (enabled === "false" || enabled === "") return undefined;
  if (enabled !== "true") throw new Error("Invalid ASSET_WORKLOAD_AUTH_ENABLED");
  const config = {
    audience: env.ASSET_WORKLOAD_AUTH_AUDIENCE?.trim() ?? "",
    clientId: env.ASSET_WORKLOAD_AUTH_CLIENT_ID?.trim() ?? ""
  };
  validate(config);
  return config;
}

function validate(config: AssetWorkloadAuth): void {
  let audience: URL;
  try {
    audience = new URL(config.audience);
  } catch {
    throw new Error("Invalid Asset workload audience");
  }
  if (
    !["api:", "https:"].includes(audience.protocol) ||
    !audience.host ||
    audience.username ||
    audience.password ||
    audience.search ||
    audience.hash ||
    /\s/u.test(config.audience) ||
    config.audience.length > 255 ||
    config.audience.endsWith("/") ||
    config.audience.endsWith("/.default")
  ) {
    throw new Error("Invalid Asset workload audience");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(config.clientId)) {
    throw new Error("Invalid Asset workload client ID");
  }
}

export function assetWorkloadToken(baseUrl: string, config?: AssetWorkloadAuth) {
  if (!config) return undefined;
  validate(config);
  validateInternalServiceOrigin(baseUrl, "asset-api", "production");
  const origin = new URL(baseUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("Asset workload authentication requires a private HTTPS origin");
  }
  const credential = new ManagedIdentityCredential(config.clientId);
  return async (signal?: AbortSignal): Promise<string> => {
    const deadline = AbortSignal.timeout(2000);
    const token = await credential.getToken(`${config.audience}/.default`, {
      abortSignal: signal ? AbortSignal.any([signal, deadline]) : deadline
    });
    if (
      !token ||
      token.expiresOnTimestamp <= Date.now() + 5000 ||
      !token.token ||
      token.token.length > 8192 ||
      /\s/u.test(token.token)
    ) {
      throw new Error("Asset workload token unavailable");
    }
    return token.token;
  };
}
