import { createAccountAdminClient } from "../account/account-admin-client.js";
import {
  runAccountDeploymentPreflight,
  type AccountDeploymentPreflightResult
} from "../assurance/account-deployment-preflight.js";
import { loadConfigFromEnv } from "../config.js";

const failedResult: AccountDeploymentPreflightResult = {
  status: "failed",
  functions: [],
  outcomes: { identityLookup: "failed", binding: "failed" }
};

try {
  const config = loadConfigFromEnv(process.env);
  const requirements = config.profiles.map((profile) => ({
    profileName: profile.name,
    functionNames: profile.permissionRequiredFunctions
  }));
  const result = await runAccountDeploymentPreflight(
    requirements,
    createAccountAdminClient({
      baseUrl: config.account?.baseUrl ?? "http://127.0.0.1:3500/v1.0/invoke/account-api/method",
      timeoutMs: config.account?.timeoutMs ?? 3000
    })
  );
  process.stdout.write(`ACCOUNT_PREFLIGHT_RESULT=${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
} catch {
  process.stdout.write(`ACCOUNT_PREFLIGHT_RESULT=${JSON.stringify(failedResult)}\n`);
  process.exitCode = 1;
}
