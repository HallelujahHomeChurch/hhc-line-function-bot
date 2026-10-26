import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { KernelRedisEnvironment } from "../evals/kernel/integration/environment.js";
import { loadConfigFromEnv } from "../config.js";
import { RedisWebhookEventStore } from "../idempotency/webhook-event-store.js";
import { RedisSessionStore } from "../state/redis-session-store.js";
import { signLineBody } from "../line-signature.js";
import { createTestApp } from "./create-test-app.js";

export async function rehearseRedisLoss(
  environment: KernelRedisEnvironment,
  loss: "full" | "partial" | "stale"
) {
  const directory = await mkdtemp(join(tmpdir(), "line-recovery-rehearsal-"));
  const client = environment.clients[0];
  const oldPrefix = `${environment.keyPrefix}:${loss}:old`;
  const newPrefix = `${environment.keyPrefix}:${loss}:new`;
  const cutoff = Date.now() - 1000;
  const oldStore = new RedisWebhookEventStore(client, oldPrefix);
  const oldSessions = new RedisSessionStore({ client, keyPrefix: oldPrefix });
  const claim = await oldStore.claim("main", "old-event", 60000, 60000);
  assert.equal(claim.status, "claimed");
  assert(claim.status === "claimed");
  await oldSessions.set({
    id: "old-approval",
    type: "action_review",
    profileName: "main",
    requesterUserId: "synthetic-user",
    source: { type: "user", userId: "synthetic-user" },
    toolName: "propose_save_memory",
    argumentsHash: "synthetic",
    policyKey: "synthetic",
    resultJobId: "old-job",
    expiresAt: new Date(Date.now() + 60000).toISOString()
  });
  const keys: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `${oldPrefix}:*` })) keys.push(...batch);
  const snapshots = await Promise.all(
    keys.map(async (key) => [key, await client.get(key)] as const)
  );
  await oldStore.transition(claim.lease, "start");
  await oldStore.transition(claim.lease, "complete");
  if (loss === "full") await client.del(keys);
  if (loss === "partial") {
    for (const [key, raw] of snapshots) if (raw?.includes('"phase"')) await client.del(key);
  }
  if (loss === "stale") {
    for (const [key, raw] of snapshots) {
      assert(raw);
      if (raw.includes('"phase"')) {
        const record = JSON.parse(raw);
        record.leaseUntil = 0;
        await client.setEx(key, 60, JSON.stringify(record));
      } else await client.setEx(key, 60, raw);
    }
  }
  // Characterize the danger: all three losses can permit the old event to claim again.
  assert.equal((await oldStore.claim("main", "old-event", 60000, 60000)).status, "claimed");
  const sessions = new RedisSessionStore({ client, keyPrefix: newPrefix });
  assert.equal(
    await sessions.takeActionReview({
      id: "old-approval",
      profileName: "main",
      source: { type: "user", userId: "synthetic-user" },
      requesterUserId: "synthetic-user"
    }),
    undefined
  );
  const path = join(directory, "profiles.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        name: "main",
        webhookPath: "/api/line/webhook/main",
        channelSecret: "synthetic-secret",
        channelAccessToken: "synthetic-token",
        allowDirectUser: true,
        directAccessPolicy: "public",
        groupAccessPolicy: "blocked",
        enabledFunctions: []
      }
    ])
  );
  const config = loadConfigFromEnv({ PROFILE_CONFIG_PATH: path });
  config.redisRecoveryCutoffMs = cutoff;
  let effects = 0;
  let replies = 0;
  const app = createTestApp(config, {
    sessionStore: sessions,
    webhookEventStore: new RedisWebhookEventStore(client, newPrefix),
    profileRuntime: {
      async handleTextTurn() {
        effects += 1;
        return { ok: true, replyText: "synthetic-result" };
      }
    },
    createLineReplyClient: () => ({
      async replyText() {
        replies += 1;
      }
    }),
    createLineIdentityClient: () => ({
      async getUserDisplayName() {
        return undefined;
      },
      async getGroupDisplayName() {
        return undefined;
      }
    })
  });
  const send = async (event: unknown, signed = true) => {
    const body = JSON.stringify({ destination: "synthetic-bot", events: [event] });
    return app.inject({
      method: "POST",
      url: "/api/line/webhook/main",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-line-signature": signed ? signLineBody(Buffer.from(body), "synthetic-secret") : "invalid"
      }
    });
  };
  try {
    const event = {
      type: "message",
      webhookEventId: "old-event",
      timestamp: cutoff,
      source: { type: "user", userId: "synthetic-user" },
      replyToken: "synthetic-reply",
      message: { type: "text", text: "synthetic action" }
    };
    assert.equal((await send(event, false)).statusCode, 401);
    for (const type of ["message", "postback", "accountLink", "unsend"])
      assert.equal((await send({ ...event, type })).statusCode, 409);
    assert.equal((await send(null)).statusCode, 409);
    assert.equal((await send({ timestamp: "invalid" })).statusCode, 409);
    const mixed = JSON.stringify({
      events: [event, { ...event, timestamp: cutoff + 1, webhookEventId: "mixed-fresh" }]
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/line/webhook/main",
          payload: mixed,
          headers: {
            "content-type": "application/json",
            "x-line-signature": signLineBody(Buffer.from(mixed), "synthetic-secret")
          }
        })
      ).statusCode,
      409
    );
    assert.equal(effects, 0);
    assert.equal(replies, 0);
    assert.equal(
      (await send({ ...event, webhookEventId: "fresh-event", timestamp: cutoff + 1 })).statusCode,
      200
    );
    assert.equal(effects, 1);
    await send({ ...event, webhookEventId: "fresh-event", timestamp: cutoff + 1 });
    assert.equal(effects, 1);
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
}
