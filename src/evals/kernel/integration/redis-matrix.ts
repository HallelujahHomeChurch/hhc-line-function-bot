import type { KernelBoundary } from "../contracts.js";
import { RedisConfirmationStore } from "../../../actions/confirmation-store.js";
import { RedisAgentJobStore } from "../../../agent/jobs.js";
import { RedisConversationWindowStore } from "../../../agent/context-manager.js";
import { RedisCacheStore } from "../../../cache/redis-cache-store.js";
import { RedisWebhookEventStore } from "../../../idempotency/webhook-event-store.js";
import { RedisInFlightStore } from "../../../in-flight/in-flight-store.js";
import { RedisSessionStore } from "../../../state/redis-session-store.js";
import type { ActiveTaskContext } from "../../../agent/active-task.js";
import type { KernelRedisEnvironment } from "./environment.js";

export interface KernelIntegrationCaseResult {
  caseId: string;
  boundary: KernelBoundary;
  passed: boolean;
  failureCode?: string;
}

const NOW = new Date("2026-07-21T12:00:00.000Z");
const EXPIRES_AT = new Date(NOW.getTime() + 10 * 60_000).toISOString();

export async function verifyRedisAofPolicy(client: {
  configGet(parameters: string | string[]): Promise<Record<string, string>>;
}): Promise<KernelIntegrationCaseResult> {
  try {
    const policy = await client.configGet(["appendonly", "appendfsync"]);
    const passed = policy.appendonly === "yes" && policy.appendfsync === "always";
    return {
      caseId: "redis/restart/aof-policy",
      boundary: "deployment_configuration",
      passed,
      ...(passed ? {} : { failureCode: "redis_aof_policy_invalid" })
    };
  } catch {
    return {
      caseId: "redis/restart/aof-policy",
      boundary: "deployment_configuration",
      passed: false,
      failureCode: "redis_aof_policy_check_failed"
    };
  }
}

export async function runRedisIntegrationMatrix(
  environment: KernelRedisEnvironment
): Promise<KernelIntegrationCaseResult[]> {
  const cases: Array<{
    caseId: string;
    boundary: KernelBoundary;
    run: () => Promise<void>;
  }> = [
    {
      caseId: "redis/selection/atomic-consume",
      boundary: "slot_ambiguity_resolution",
      run: async () => selectionAtomicConsume(environment)
    },
    {
      caseId: "redis/task-frame/requester-restart",
      boundary: "active_task_lifecycle",
      run: async () => taskFrameRequesterRestart(environment)
    },
    {
      caseId: "redis/job/scope-restart",
      boundary: "external_dependency",
      run: async () => jobScopeRestart(environment)
    },
    {
      caseId: "redis/webhook/cross-replica-deduplication",
      boundary: "entrance_access",
      run: async () => webhookDeduplication(environment)
    },
    {
      caseId: "redis/in-flight/cross-replica-lock",
      boundary: "external_dependency",
      run: async () => inFlightLock(environment)
    },
    {
      caseId: "redis/cache/cross-replica-invalidation",
      boundary: "freshness_invalidation",
      run: async () => cacheInvalidation(environment)
    },
    {
      caseId: "redis/confirmation/actor-safe-consume",
      boundary: "write_workflow",
      run: async () => actorSafeConfirmation(environment)
    },
    {
      caseId: "redis/session/group-requester-isolation",
      boundary: "slot_ambiguity_resolution",
      run: async () => groupRequesterIsolation(environment)
    },
    {
      caseId: "redis/session/atomic-interactive-replacement",
      boundary: "active_task_lifecycle",
      run: async () => atomicInteractiveReplacement(environment)
    }
  ];

  const results: KernelIntegrationCaseResult[] = [];
  for (const entry of cases) {
    try {
      await entry.run();
      results.push({ caseId: entry.caseId, boundary: entry.boundary, passed: true });
    } catch {
      results.push({
        caseId: entry.caseId,
        boundary: entry.boundary,
        passed: false,
        failureCode: "redis_contract_failed"
      });
    }
  }
  return results;
}

const RESTART_SCOPE = {
  profileName: "kernel-restart",
  sourceKey: "group:restart",
  requesterUserId: "requester-a"
};

export async function prepareRedisServerRestartState(
  environment: KernelRedisEnvironment
): Promise<void> {
  const client = environment.clients[0];
  const taskStore = new RedisConversationWindowStore({
    client,
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  await taskStore.recordActiveTask({
    scope: RESTART_SCOPE,
    task: {
      version: 2,
      currentCapability: "find_resource",
      allowedCapabilities: ["find_resource"],
      anchors: {},
      entities: [],
      supportedOperations: ["filter"],
      createdAt: NOW.toISOString(),
      expiresAt: EXPIRES_AT
    },
    ttlMs: 60_000
  });

  const jobStore = new RedisAgentJobStore({
    client,
    keyPrefix: environment.keyPrefix,
    now: () => NOW,
    idFactory: () => "restart-job"
  });
  const job = await jobStore.createPending({
    scope: RESTART_SCOPE,
    label: "synthetic",
    ttlMs: 60_000
  });
  await jobStore.complete(job.id, { ok: true, replyText: "synthetic" });

  await new RedisWebhookEventStore(client, environment.keyPrefix).tryStart(
    "kernel-restart",
    "restart-event",
    60_000
  );
  await new RedisCacheStore({ client, keyPrefix: environment.keyPrefix }).set(
    "restart-cache",
    { revision: 1 },
    60_000
  );
  await new RedisSessionStore({
    client,
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  }).set({
    id: "restart-selection",
    type: "selection",
    action: "find_resource",
    profileName: "kernel-restart",
    requesterUserId: "requester-a",
    source: { type: "group", groupId: "restart", userId: "requester-a" },
    items: [{ id: "synthetic-item", name: "synthetic", driveId: "synthetic-drive" }],
    expiresAt: EXPIRES_AT
  });
  await new RedisConfirmationStore({
    client,
    keyPrefix: environment.keyPrefix,
    idFactory: () => "restart-confirmation",
    now: () => NOW
  }).create({
    profileName: "kernel-restart",
    actorUserId: "requester-a",
    action: "invite_code_create",
    ttlMinutes: 5
  });
}

export async function verifyRedisServerRestartState(
  environment: KernelRedisEnvironment
): Promise<KernelIntegrationCaseResult[]> {
  const [leftClient, rightClient] = environment.clients;
  const cases: Array<{ caseId: string; boundary: KernelBoundary; run: () => Promise<void> }> = [
    {
      caseId: "redis/restart/task-frame-durable",
      boundary: "active_task_lifecycle",
      run: async () => {
        const store = new RedisConversationWindowStore({
          client: rightClient,
          keyPrefix: environment.keyPrefix,
          now: () => NOW
        });
        assert((await store.activeTask(RESTART_SCOPE))?.currentCapability === "find_resource");
      }
    },
    {
      caseId: "redis/restart/job-durable",
      boundary: "external_dependency",
      run: async () => {
        const store = new RedisAgentJobStore({
          client: rightClient,
          keyPrefix: environment.keyPrefix,
          now: () => NOW
        });
        assert((await store.get("restart-job", RESTART_SCOPE))?.status === "completed");
      }
    },
    {
      caseId: "redis/restart/webhook-durable",
      boundary: "entrance_access",
      run: async () => {
        const store = new RedisWebhookEventStore(rightClient, environment.keyPrefix);
        assert((await store.tryStart("kernel-restart", "restart-event", 60_000)) === "duplicate");
      }
    },
    {
      caseId: "redis/restart/cache-durable",
      boundary: "freshness_invalidation",
      run: async () => {
        const store = new RedisCacheStore({
          client: rightClient,
          keyPrefix: environment.keyPrefix
        });
        assert((await store.get<{ revision: number }>("restart-cache"))?.revision === 1);
      }
    },
    {
      caseId: "redis/restart/selection-one-shot",
      boundary: "slot_ambiguity_resolution",
      run: async () => {
        const stores = [leftClient, rightClient].map(
          (client) =>
            new RedisSessionStore({ client, keyPrefix: environment.keyPrefix, now: () => NOW })
        );
        const consumed = await Promise.all(
          stores.map(async (store) => store.take("restart-selection"))
        );
        assert(consumed.filter(Boolean).length === 1);
      }
    },
    {
      caseId: "redis/restart/confirmation-one-shot",
      boundary: "write_workflow",
      run: async () => {
        const stores = [leftClient, rightClient].map(
          (client) =>
            new RedisConfirmationStore({
              client,
              keyPrefix: environment.keyPrefix,
              now: () => NOW
            })
        );
        const consumed = await Promise.all(
          stores.map(async (store) =>
            store.consume("restart-confirmation", "requester-a", "kernel-restart")
          )
        );
        assert(consumed.filter(Boolean).length === 1);
      }
    }
  ];

  const results: KernelIntegrationCaseResult[] = [];
  for (const entry of cases) {
    try {
      await entry.run();
      results.push({ caseId: entry.caseId, boundary: entry.boundary, passed: true });
    } catch {
      results.push({
        caseId: entry.caseId,
        boundary: entry.boundary,
        passed: false,
        failureCode: "redis_restart_contract_failed"
      });
    }
  }
  return results;
}

async function selectionAtomicConsume(environment: KernelRedisEnvironment): Promise<void> {
  const stores = environment.clients.map(
    (client) => new RedisSessionStore({ client, keyPrefix: environment.keyPrefix, now: () => NOW })
  );
  await stores[0]!.set({
    id: "selection",
    type: "selection",
    action: "find_resource",
    profileName: "helper",
    requesterUserId: "U1",
    source: { type: "group", groupId: "G1", userId: "U1" },
    items: [{ id: "item", name: "synthetic", driveId: "drive" }],
    expiresAt: EXPIRES_AT
  });
  const results = await Promise.all([stores[0]!.take("selection"), stores[1]!.take("selection")]);
  assert(results.filter(Boolean).length === 1);
}

async function taskFrameRequesterRestart(environment: KernelRedisEnvironment): Promise<void> {
  const scope = { profileName: "helper", sourceKey: "group:G1", requesterUserId: "U1" };
  const task: ActiveTaskContext = {
    version: 2,
    currentCapability: "query_schedule",
    allowedCapabilities: ["query_schedule"],
    anchors: {},
    entities: [],
    supportedOperations: ["filter"],
    createdAt: NOW.toISOString(),
    expiresAt: EXPIRES_AT
  };
  const writer = new RedisConversationWindowStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  const reader = new RedisConversationWindowStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  await writer.recordActiveTask({ scope, task, ttlMs: 60_000 });
  assert((await reader.activeTask(scope))?.currentCapability === "query_schedule");
  assert((await reader.activeTask({ ...scope, requesterUserId: "U2" })) === undefined);
  const reconnected = await environment.reconnectReplica(0);
  const restarted = new RedisConversationWindowStore({
    client: reconnected,
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  assert((await restarted.activeTask(scope))?.currentCapability === "query_schedule");
}

async function jobScopeRestart(environment: KernelRedisEnvironment): Promise<void> {
  const scope = { profileName: "helper", sourceKey: "group:G1", requesterUserId: "U1" };
  let writer = new RedisAgentJobStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix,
    now: () => NOW,
    idFactory: () => "job"
  });
  const record = await writer.createPending({ scope, label: "synthetic", ttlMs: 60_000 });
  await writer.complete(record.id, { ok: true, replyText: "complete" });
  const reader = new RedisAgentJobStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  assert((await reader.get(record.id, scope))?.status === "completed");
  assert((await reader.get(record.id, { ...scope, requesterUserId: "U2" })) === undefined);
  const reconnected = await environment.reconnectReplica(0);
  writer = new RedisAgentJobStore({
    client: reconnected,
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  assert((await writer.get(record.id, scope))?.status === "completed");
}

async function webhookDeduplication(environment: KernelRedisEnvironment): Promise<void> {
  const a = new RedisWebhookEventStore(environment.clients[0], environment.keyPrefix);
  const b = new RedisWebhookEventStore(environment.clients[1], environment.keyPrefix);
  assert((await a.tryStart("helper", "event", 60_000)) === "started");
  assert((await b.tryStart("helper", "event", 60_000)) === "duplicate");
}

async function inFlightLock(environment: KernelRedisEnvironment): Promise<void> {
  const a = new RedisInFlightStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix
  });
  const b = new RedisInFlightStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix
  });
  const key = { profileName: "helper", sourceKey: "group:G1", action: "lookup", queryHash: "hash" };
  assert((await a.tryStart(key, 60_000)) === "started");
  assert((await b.tryStart(key, 60_000)) === "busy");
  await b.release(key);
  assert((await a.tryStart(key, 60_000)) === "started");
}

async function cacheInvalidation(environment: KernelRedisEnvironment): Promise<void> {
  const a = new RedisCacheStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix
  });
  const b = new RedisCacheStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix
  });
  await a.set("catalog:item", { revision: 1 }, 60_000);
  assert((await b.get<{ revision: number }>("catalog:item"))?.revision === 1);
  await b.delete("catalog:item");
  assert((await a.get("catalog:item")) === undefined);
}

async function actorSafeConfirmation(environment: KernelRedisEnvironment): Promise<void> {
  const a = new RedisConfirmationStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix,
    idFactory: () => "confirmation",
    now: () => NOW
  });
  const b = new RedisConfirmationStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  await a.create({
    profileName: "helper",
    actorUserId: "U1",
    action: "invite_code_create",
    ttlMinutes: 5
  });
  assert((await b.consume("confirmation", "U2", "helper")) === null);
  assert((await a.consume("confirmation", "U1", "helper"))?.id === "confirmation");
  assert((await b.consume("confirmation", "U1", "helper")) === null);
}

async function groupRequesterIsolation(environment: KernelRedisEnvironment): Promise<void> {
  const a = new RedisSessionStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  const b = new RedisSessionStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  const source = { type: "group" as const, groupId: "G1", userId: "U1" };
  await a.set({
    id: "resolution",
    type: "pending_resolution",
    profileName: "helper",
    requesterUserId: "U1",
    source,
    capability: "query_schedule",
    groundedArguments: {},
    candidates: [{ id: "1", domainKey: "domain", displayName: "synthetic" }],
    expiresAt: EXPIRES_AT
  });
  assert(
    (await b.findPendingResolution({
      profileName: "helper",
      source: { ...source, userId: "U2" },
      requesterUserId: "U2"
    })) === undefined
  );
  await a.set({
    id: "intent",
    type: "upload_intent",
    profileName: "helper",
    requesterUserId: "U1",
    source,
    expiresAt: EXPIRES_AT
  });
  assert(
    (await b.takeUploadIntent({
      profileName: "helper",
      source: { ...source, userId: "U2" },
      requesterUserId: "U2"
    })) === undefined
  );
  assert(
    (await a.takeUploadIntent({ profileName: "helper", source, requesterUserId: "U1" }))?.id ===
      "intent"
  );
}

async function atomicInteractiveReplacement(environment: KernelRedisEnvironment): Promise<void> {
  const stores = environment.clients.map(
    (client) => new RedisSessionStore({ client, keyPrefix: environment.keyPrefix, now: () => NOW })
  );
  const source = { type: "group" as const, groupId: "G2", userId: "U1" };
  await Promise.all([
    stores[0]!.set({
      id: "replace-a",
      type: "upload_intent",
      profileName: "helper",
      requesterUserId: "U1",
      source,
      expiresAt: EXPIRES_AT
    }),
    stores[1]!.set({
      id: "replace-b",
      type: "pending_resolution",
      profileName: "helper",
      requesterUserId: "U1",
      source,
      capability: "query_schedule",
      groundedArguments: {},
      candidates: [{ id: "1", domainKey: "domain", displayName: "synthetic" }],
      expiresAt: EXPIRES_AT
    })
  ]);
  const keys = await environment.clients[0].keys(`${environment.keyPrefix}:session:replace-*`);
  assert(keys.length === 1);
  const lookup = { profileName: "helper", source, requesterUserId: "U1" };
  const found =
    (await stores[0]!.findPendingResolution(lookup)) ?? (await stores[0]!.takeUploadIntent(lookup));
  assert(Boolean(found));
  if (found?.type === "pending_resolution") {
    await stores[0]!.delete(found.id);
  }
  const remainingKeys = await environment.clients[0].keys(
    `${environment.keyPrefix}:session:replace-*`
  );
  assert(remainingKeys.length === 0);
  const remainingIndexes = await environment.clients[0].keys(
    `${environment.keyPrefix}:interactive-session-v1:*`
  );
  assert(remainingIndexes.length === 0);
}

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error("redis_contract_failed");
}
