import { createClient } from "redis";

import type { RedisConfig } from "./types.js";
import type { RedisRegistrationInviteCodeClient } from "./access/registration-invite-code-store.js";
import type { RedisConfirmationClient } from "./actions/confirmation-store.js";
import type { RedisCacheClient } from "./cache/redis-cache-store.js";
import type { DiagnosticRedisClient } from "./diagnostics/dependencies.js";
import type { RedisInFlightClient } from "./in-flight/in-flight-store.js";
import type { RedisLastErrorClient } from "./observability/create-last-error-store.js";
import type { RedisRateLimitClient } from "./rate-limit.js";
import type { RedisSessionClient } from "./state/redis-session-store.js";
import type { RedisAgentJobClient } from "./agent/jobs.js";
import type { RedisConversationWindowClient } from "./agent/context-manager.js";
import type { RedisAgentTraceClient } from "./agent/trace-store.js";

export interface RedisRuntime {
  client: RedisCacheClient &
    RedisSessionClient &
    RedisLastErrorClient &
    RedisRateLimitClient &
    RedisRegistrationInviteCodeClient &
    RedisConfirmationClient &
    DiagnosticRedisClient &
    RedisInFlightClient &
    RedisAgentJobClient &
    RedisAgentTraceClient &
    RedisConversationWindowClient;
  keyPrefix: string;
}

export async function createRedisRuntime(
  config: RedisConfig | undefined
): Promise<RedisRuntime | undefined> {
  if (!config) {
    return undefined;
  }

  const client = createClient({ url: config.url });
  client.on("error", (error) => {
    console.error("Redis client error", error);
  });
  await client.connect();

  return {
    client: client as unknown as RedisRuntime["client"],
    keyPrefix: config.keyPrefix
  };
}
