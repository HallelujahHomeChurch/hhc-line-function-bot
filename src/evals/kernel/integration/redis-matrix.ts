import { createRateLimiter } from "../../../rate-limit.js";
import type { KernelBoundary } from "../contracts.js";
import { RedisConfirmationStore } from "../../../actions/confirmation-store.js";
import { RedisAgentJobStore } from "../../../agent/jobs.js";
import { RedisCacheStore } from "../../../cache/redis-cache-store.js";
import { RedisWebhookEventStore } from "../../../idempotency/webhook-event-store.js";
import { RedisSessionStore } from "../../../state/redis-session-store.js";
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
      caseId: "redis/rate-limit/atomic-window-notification",
      boundary: "entrance_access",
      run: async () => rateLimitAtomicWindow(environment)
    },
    {
      caseId: "redis/webhook/lease-owner-and-uncertain",
      boundary: "entrance_access",
      run: async () => webhookReceiptOwnership(environment)
    },
    {
      caseId: "redis/job/pre-dispatch-operation",
      boundary: "write_workflow",
      run: async () => jobExecutionClaim(environment)
    },
    {
      caseId: "redis/selection/atomic-consume",
      boundary: "slot_ambiguity_resolution",
      run: async () => selectionAtomicConsume(environment)
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
      caseId: "redis/review/atomic-owner-consume",
      boundary: "write_workflow",
      run: async () => actionReviewAtomicConsume(environment)
    },
    {
      caseId: "redis/session/group-requester-isolation",
      boundary: "slot_ambiguity_resolution",
      run: async () => groupRequesterIsolation(environment)
    },
    {
      caseId: "redis/session/atomic-interactive-replacement",
      boundary: "state_lifecycle",
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
  await writer.fail(record.id, "late_failure");
  const reader = new RedisAgentJobStore({
    client: environment.clients[1],
    keyPrefix: environment.keyPrefix,
    now: () => NOW
  });
  const completed = await reader.get(record.id, scope);
  assert(completed?.status === "completed" && completed.result?.replyText === "complete");
  assert((await reader.get(record.id, { ...scope, requesterUserId: "U2" })) === undefined);
  const failedStore = new RedisAgentJobStore({
    client: environment.clients[0],
    keyPrefix: environment.keyPrefix,
    now: () => NOW,
    idFactory: () => "failed-job"
  });
  const failed = await failedStore.createPending({ scope, label: "synthetic", ttlMs: 60_000 });
  await failedStore.fail(failed.id, "x".repeat(300));
  await failedStore.fail(failed.id, "late_replacement");
  const terminalFailure = await reader.get(failed.id, scope);
  assert(terminalFailure?.status === "failed" && terminalFailure.error === "x".repeat(160));
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

async function actionReviewAtomicConsume(environment: KernelRedisEnvironment): Promise<void> {
  const stores = environment.clients.map(
    (client) => new RedisSessionStore({ client, keyPrefix: environment.keyPrefix, now: () => NOW })
  );
  const source = { type: "group" as const, groupId: "G-review", userId: "U1" };
  await stores[0]!.set({
    id: "review",
    type: "action_review",
    profileName: "helper",
    requesterUserId: "U1",
    source,
    threadId: "thread",
    interruptId: "interrupt",
    toolName: "propose_save_memory",
    argumentsHash: "hash",
    policyKey: "policy",
    resultJobId: "result-job",
    expiresAt: EXPIRES_AT
  });
  assert(
    (await stores[1]!.findActionReview({
      profileName: "helper",
      source: { ...source, userId: "U2" },
      requesterUserId: "U2"
    })) === undefined
  );
  assert(
    (
      await stores[1]!.findActionReview({
        profileName: "helper",
        source,
        requesterUserId: "U1"
      })
    )?.id === "review"
  );
  assert(
    (await stores[1]!.takeActionReview({
      id: "review",
      profileName: "helper",
      source: { ...source, userId: "U2" },
      requesterUserId: "U2"
    })) === undefined
  );
  const consumed = await Promise.all(
    stores.map((store) =>
      store.takeActionReview({
        id: "review",
        profileName: "helper",
        source,
        requesterUserId: "U1"
      })
    )
  );
  assert(consumed.filter(Boolean).length === 1);

  await stores[0]!.set({
    id: "expired-review",
    type: "action_review",
    profileName: "helper",
    requesterUserId: "U1",
    source,
    threadId: "thread",
    interruptId: "interrupt",
    toolName: "propose_save_memory",
    argumentsHash: "hash",
    policyKey: "policy",
    resultJobId: "expired-result-job",
    expiresAt: NOW.toISOString()
  });
  assert(
    (await stores[1]!.takeActionReview({
      id: "expired-review",
      profileName: "helper",
      source,
      requesterUserId: "U1"
    })) === undefined
  );
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
    id: "attachment",
    type: "pending_attachment",
    action: "save_resource",
    profileName: "helper",
    requesterUserId: "U1",
    source,
    attachment: { messageId: "M1", messageType: "image" },
    expiresAt: EXPIRES_AT
  });
  assert(
    (await b.findPendingAttachment({
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
      type: "pending_attachment",
      action: "save_resource",
      profileName: "helper",
      requesterUserId: "U1",
      source,
      attachment: { messageId: "M2", messageType: "image" },
      expiresAt: EXPIRES_AT
    })
  ]);
  const keys = await environment.clients[0].keys(`${environment.keyPrefix}:session:replace-*`);
  assert(keys.length === 1);
  const lookup = { profileName: "helper", source, requesterUserId: "U1" };
  const found =
    (await stores[0]!.findPendingAttachment(lookup)) ?? (await stores[0]!.takeUploadIntent(lookup));
  assert(Boolean(found));
  if (found?.type === "pending_attachment") await stores[0]!.delete(found.id);
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

async function rateLimitAtomicWindow(environment: KernelRedisEnvironment): Promise<void> {
  const keyPrefix = `${environment.keyPrefix}:rate-case`;
  const limiters = environment.clients.map((client) =>
    createRateLimiter({
      config: { enabled: true, windowMs: 60_000, maxRequests: 20, groupMaxRequests: 100 },
      redis: { client, keyPrefix }
    })
  );
  const input = { profileName: "helper", source: { type: "group", groupId: "G1", userId: "U1" } };
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => limiters[i % 2]!.check(input))
  );
  assert(results.filter((result) => result.allowed).length === 20);
  assert(results.filter((result) => result.shouldNotify).length === 1);
  assert(
    (await limiters[1]!.check({ ...input, source: { ...input.source, userId: "U2" } })).allowed
  );
  const client = environment.clients[0];
  const key = `${keyPrefix}:rate-limit:helper:user:legacy`;
  // A legacy INCR whose separate EXPIRE never ran must heal without a key flush.
  await client.set(key, "20");
  const healed = await limiters[0]!.check({
    profileName: "helper",
    source: { type: "user", userId: "legacy" }
  });
  assert(!healed.allowed && healed.shouldNotify === true);
  assert((await client.pTTL(key)) > 0);
  await client.pExpire(key, 5000);
  const before = Date.now();
  const next = await limiters[1]!.check({
    profileName: "helper",
    source: { type: "user", userId: "legacy" }
  });
  assert(next.shouldNotify === false);
  assert(Date.parse(next.resetAt) <= before + 5100);
  assert(Date.parse(next.resetAt) >= before + 4000);
  const groupKey = `${keyPrefix}:rate-limit:helper:group:legacy`;
  await client.set(groupKey, "100", { PX: 60_000 });
  const groupResults = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      limiters[i % 2]!.check({
        profileName: "helper",
        source: { type: "group", groupId: "legacy", userId: `U${i}` }
      })
    )
  );
  assert(groupResults.every((result) => !result.allowed));
  assert(groupResults.filter((result) => result.shouldNotify).length === 1);
}

async function webhookReceiptOwnership(environment: KernelRedisEnvironment): Promise<void> {
  const prefix = `${environment.keyPrefix}:receipt-case`;
  const stores = environment.clients.map((client) => new RedisWebhookEventStore(client, prefix));
  const ttl = 7 * 24 * 60 * 60_000;
  const claims = await Promise.all(stores.map((store) => store.claim("helper", "race", ttl, 1000)));
  assert(claims.filter((claim) => claim.status === "claimed").length === 1);
  const first = claims.find((claim) => claim.status === "claimed")!;
  assert(first.status === "claimed");
  // Simulate process death by expiring only the lease, never the terminal dedupe key.
  const key = `${prefix}:webhook-event:v1:helper:race`;
  const record = JSON.parse((await environment.clients[0].get(key))!);
  record.leaseUntil = 0;
  await environment.clients[0].set(key, JSON.stringify(record), { PX: ttl });
  const next = await stores[1]!.claim("helper", "race", ttl, 60_000);
  assert(next.status === "claimed" && next.lease.operationId === first.lease.operationId);
  assert(!(await stores[0]!.transition(first.lease, "complete")));
  assert(!(await stores[0]!.transition(first.lease, "renew")));
  assert(await stores[1]!.transition(next.lease, "start"));
  assert(!(await stores[1]!.transition(next.lease, "release")));
  const started = JSON.parse((await environment.clients[0].get(key))!);
  started.leaseUntil = 0;
  await environment.clients[0].set(key, JSON.stringify(started), { PX: ttl });
  assert((await stores[0]!.claim("helper", "race", ttl, 60_000)).status === "uncertain");
  assert(!(await stores[1]!.transition(next.lease, "complete")));
  assert((await stores[0]!.tryStart("helper", "race", ttl)) === "duplicate");
  await stores[0]!.tryStart("helper", "legacy", ttl);
  assert((await stores[1]!.claim("helper", "legacy", ttl, 1000)).status === "duplicate");
  const terminal = await stores[0]!.claim("helper", "done", ttl, 60_000);
  assert(terminal.status === "claimed");
  assert(await stores[0]!.transition(terminal.lease, "complete"));
  const deliveries = await Promise.all(
    stores.map((store) => store.delivery(terminal.lease, "attempted"))
  );
  assert(deliveries.filter(Boolean).length === 1);
  assert(await stores[0]!.delivery(terminal.lease, "unknown"));
  assert(!(await stores[1]!.delivery(terminal.lease, "attempted")));

  assert((await stores[1]!.claim("helper", "done", ttl, 1000)).status === "duplicate");
  assert(
    (await environment.clients[0].pTTL(`${prefix}:webhook-event:v1:helper:done`)) > ttl - 5000
  );
}

async function jobExecutionClaim(environment: KernelRedisEnvironment): Promise<void> {
  const stores = environment.clients.map(
    (client) =>
      new RedisAgentJobStore({ client, keyPrefix: `${environment.keyPrefix}:execution-case` })
  );
  const scope = { profileName: "helper", sourceKey: "user:U1", requesterUserId: "U1" };
  const jobs = await Promise.all(
    stores.map((store) =>
      store.createPending({ id: "event-operation", scope, label: "operation", ttlMs: 60_000 })
    )
  );
  assert(jobs[0]!.id === jobs[1]!.id);
  const starts = await Promise.all(stores.map((store) => store.markStarted(jobs[0]!.id, 60_000)));
  assert(starts.filter(Boolean).length === 1);
  await stores[0]!.fail(jobs[0]!.id, "execution_uncertain");
  assert((await stores[1]!.get(jobs[0]!.id, scope))?.status === "uncertain");
  assert(!(await stores[1]!.markStarted(jobs[0]!.id, 60_000)));
  // A known result may reconcile uncertainty, but a later result cannot overwrite it.
  await stores[0]!.complete(jobs[0]!.id, {
    ok: true,
    replyText: "known result",
    resultAuthority: { kind: "public" }
  });
  await stores[1]!.complete(jobs[0]!.id, { ok: true, replyText: "late overwrite" });
  assert((await stores[0]!.get(jobs[0]!.id, scope))?.result?.replyText === "known result");
}
