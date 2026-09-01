import { pathToFileURL } from "node:url";

import { ManagedIdentityCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";

import { MeetingWindowClient, meetingAccessTokenScope } from "../media-sync/meeting-client.js";
import { runWarmScheduler } from "../media-sync/warm-scheduler.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function readWarmSchedulerEnvironment(env: NodeJS.ProcessEnv) {
  const baseUrl = requiredHttpsUrl(env, "MEETING_API_BASE_URL");
  const queueUrl = requiredHttpsUrl(env, "MEDIA_SYNC_WARM_QUEUE_URL");
  const audience = env.MEETING_API_AUDIENCE?.trim();
  if (!audience || !/^(?:api|https):\/\//u.test(audience)) {
    throw new Error("MEETING_API_AUDIENCE is required and must be an application URI");
  }
  const clientId = env.AZURE_CLIENT_ID?.trim();
  if (!clientId || !UUID_PATTERN.test(clientId)) {
    throw new Error("AZURE_CLIENT_ID is required and must be a UUID");
  }
  return {
    baseUrl,
    queueUrl,
    audience,
    clientId,
    leadMs: durationMs(env.MEDIA_SYNC_WARM_LEAD ?? "5m", "MEDIA_SYNC_WARM_LEAD"),
    tailMs: durationMs(env.MEDIA_SYNC_WARM_TAIL ?? "10m", "MEDIA_SYNC_WARM_TAIL")
  };
}

export async function runMediaSyncWarmer(env: NodeJS.ProcessEnv = process.env) {
  const config = readWarmSchedulerEnvironment(env);
  const credential = new ManagedIdentityCredential(config.clientId);
  const queue = new QueueClient(config.queueUrl, credential);
  const meetings = new MeetingWindowClient({
    baseUrl: config.baseUrl,
    leadMs: config.leadMs,
    tailMs: config.tailMs,
    refreshMs: 0,
    getAccessToken: async () => {
      const token = await credential.getToken(meetingAccessTokenScope(config.audience));
      if (!token?.token) throw new Error("meeting_api_token_unavailable");
      return token.token;
    }
  });
  return runWarmScheduler({
    isWarm: (now) => meetings.isWarm(now),
    sendPulse: async ({ ttlSeconds }) => {
      await queue.sendMessage("{}", { messageTimeToLive: ttlSeconds });
    }
  });
}

function requiredHttpsUrl(env: NodeJS.ProcessEnv, field: string): string {
  try {
    const url = new URL(env[field]?.trim() ?? "");
    if (url.protocol !== "https:") throw new Error();
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error(`${field} is required and must be an HTTPS URL`);
  }
}

function durationMs(value: string, field: string): number {
  const match = /^(\d+)([smh])$/u.exec(value.trim());
  if (!match) throw new Error(`${field} must use s, m, or h`);
  const multiplier = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result < 1_000 || result > 24 * 3_600_000) {
    throw new Error(`${field} is out of range`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMediaSyncWarmer()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.exitCode = 1;
    });
}
