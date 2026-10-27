import { pathToFileURL } from "node:url";

import {
  runReleaseProbe,
  type ReleaseProbeDependencies,
  type ReleaseProbeInput
} from "../assurance/release-probe.js";

export async function runReleaseProbeCli(
  env: Record<string, string | undefined>,
  dependencies: ReleaseProbeDependencies = defaultDependencies(),
  writeLine: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  scope: "full" | "private" = "full"
): Promise<0 | 1> {
  const result = await runReleaseProbe(readInput(env), dependencies, scope);
  writeLine(JSON.stringify(result));
  return result.status === "passed" ? 0 : 1;
}

function readInput(env: Record<string, string | undefined>): ReleaseProbeInput {
  return {
    botBaseUrl: required(env, "BOT_BASE_URL"),
    searxngBaseUrl: required(env, "SEARXNG_BASE_URL"),
    gatewayWebhookUrl: required(env, "GATEWAY_WEBHOOK_URL"),
    gatewayMainWebhookUrl: required(env, "GATEWAY_MAIN_WEBHOOK_URL"),
    lineHelperChannelSecret: required(env, "LINE_HELPER_CHANNEL_SECRET"),
    lineMainEmptyWebhookSignature: required(env, "LINE_MAIN_EMPTY_WEBHOOK_SIGNATURE")
  };
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error("release_probe_invalid_input");
  return value;
}

function defaultDependencies(): ReleaseProbeDependencies {
  return { fetch: globalThis.fetch };
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "private")) {
      throw new Error("release_probe_invalid_input");
    }
    process.exitCode = await runReleaseProbeCli(
      process.env,
      undefined,
      undefined,
      args[0] === "private" ? "private" : "full"
    );
  } catch {
    process.stdout.write('{"status":"failed","checks":[]}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
