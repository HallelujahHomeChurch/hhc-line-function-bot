import type { CapabilityName } from "../capabilities/names.js";
import { AccountApiError } from "../account/account-admin-client.js";
import type {
  AccountAdminClient,
  AuthorizeLineFunctionsInput,
  FinalizeLineBindingInput,
  VerifyLineFunctionPermissionsInput
} from "../account/account-admin-client.js";

export interface AccountPermissionRequirement {
  profileName: string;
  functionNames: CapabilityName[];
}

type AccountPreflightClient = Pick<
  AccountAdminClient,
  "verifyFunctionPermissions" | "authorizeFunctions" | "finalizeBinding"
>;

export interface AccountDeploymentPreflightResult {
  status: "passed" | "failed";
  functions: Array<{ name: CapabilityName; outcome: "configured" | "missing" }>;
  outcomes: {
    identityLookup: "unbound" | "failed";
    binding: "rejected" | "failed";
  };
}

const disposableLineUserId = `U${"0".repeat(32)}`;

export async function runAccountDeploymentPreflight(
  requirements: AccountPermissionRequirement[],
  client: AccountPreflightClient
): Promise<AccountDeploymentPreflightResult> {
  const functions: AccountDeploymentPreflightResult["functions"] = [];
  let permissionChecksPassed = true;

  for (const requirement of requirements) {
    if (requirement.functionNames.length === 0) continue;
    try {
      const configured = await client.verifyFunctionPermissions(
        requirement satisfies VerifyLineFunctionPermissionsInput
      );
      for (const functionName of requirement.functionNames) {
        const present = configured.includes(functionName);
        functions.push({ name: functionName, outcome: present ? "configured" : "missing" });
        permissionChecksPassed &&= present;
      }
    } catch {
      permissionChecksPassed = false;
      for (const functionName of requirement.functionNames) {
        functions.push({ name: functionName, outcome: "missing" });
      }
    }
  }

  const identityLookup = await verifyDisposableIdentityLookup(client, requirements);
  const binding = await verifyExpiredBindingRejection(client, requirements);
  return {
    status:
      permissionChecksPassed && identityLookup === "unbound" && binding === "rejected"
        ? "passed"
        : "failed",
    functions,
    outcomes: { identityLookup, binding }
  };
}

async function verifyDisposableIdentityLookup(
  client: Pick<AccountAdminClient, "authorizeFunctions">,
  requirements: AccountPermissionRequirement[]
): Promise<"unbound" | "failed"> {
  const requirement = requirements[0];
  if (!requirement) return "failed";
  try {
    const authorization = await client.authorizeFunctions({
      lineUserId: disposableLineUserId,
      profileName: requirement.profileName,
      functionNames: requirement.functionNames
    } satisfies AuthorizeLineFunctionsInput);
    return !authorization.bound &&
      !authorization.active &&
      !authorization.administrator &&
      authorization.allowedFunctions.length === 0 &&
      authorization.account === undefined
      ? "unbound"
      : "failed";
  } catch {
    return "failed";
  }
}

async function verifyExpiredBindingRejection(
  client: Pick<AccountAdminClient, "finalizeBinding">,
  requirements: AccountPermissionRequirement[]
): Promise<"rejected" | "failed"> {
  const profileName = requirements[0]?.profileName;
  if (!profileName) return "failed";
  try {
    await client.finalizeBinding({
      nonce: "preflight00",
      result: "ok",
      actualLineUserId: disposableLineUserId,
      profileName,
      channelId: "preflight",
      webhookEventId: "preflight"
    } satisfies FinalizeLineBindingInput);
    return "failed";
  } catch (error) {
    return error instanceof AccountApiError && error.message === "account_api_http_410"
      ? "rejected"
      : "failed";
  }
}
