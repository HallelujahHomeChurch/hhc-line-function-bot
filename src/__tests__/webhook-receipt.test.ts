import { describe, expect, it, vi } from "vitest";
import { InMemoryWebhookEventStore } from "../idempotency/webhook-event-store.js";
import { WebhookReceipt } from "../transport/line/webhook-receipt.js";
const TTL = 7 * 24 * 60 * 60_000;

describe("webhook receipt ownership", () => {
  it("allows pre-dispatch takeover but rejects an expired owner", async () => {
    let now = 0;
    const store = new InMemoryWebhookEventStore(() => new Date(now));
    const first = await store.claim("helper", "event", TTL, 100);
    if (first.status !== "claimed") throw new Error("missing lease");
    expect((await store.claim("helper", "event", TTL, 100)).status).toBe("duplicate");
    now = 101;
    const next = await store.claim("helper", "event", TTL, 100);
    if (next.status !== "claimed") throw new Error("missing replacement lease");
    expect(next.lease.operationId).toBe(first.lease.operationId);
    expect(next.lease.owner).not.toBe(first.lease.owner);
    expect(await store.transition(first.lease, "renew")).toBe(false);
    expect(await store.transition(first.lease, "complete")).toBe(false);
    expect(await store.transition(next.lease, "start")).toBe(true);
    now = 202;
    expect((await store.claim("helper", "event", TTL, 100)).status).toBe("uncertain");
    expect(await store.transition(next.lease, "complete")).toBe(false);
  });

  it("respects legacy receipts and keeps terminal receipts for seven days", async () => {
    let now = 1;
    const store = new InMemoryWebhookEventStore(() => new Date(now));
    await store.tryStart("helper", "legacy", TTL);
    expect((await store.claim("helper", "legacy", TTL, 100)).status).toBe("duplicate");
    const claim = await store.claim("helper", "new", TTL, 100);
    if (claim.status !== "claimed") throw new Error("missing lease");
    expect(await store.tryStart("helper", "new", TTL)).toBe("duplicate");
    await store.transition(claim.lease, "complete");
    now += TTL - 1;
    expect((await store.claim("helper", "new", TTL, 100)).status).toBe("duplicate");
    now += 1;
    expect((await store.claim("helper", "new", TTL, 100)).status).toBe("claimed");
  });

  it("retains a completed receipt for seven days from completion", async () => {
    let now = 0;
    const store = new InMemoryWebhookEventStore(() => new Date(now));
    const claim = await store.claim("helper", "delayed", TTL, 1000);
    if (claim.status !== "claimed") throw new Error("missing lease");
    now = 900;
    await store.transition(claim.lease, "complete");
    now = TTL + 899;
    expect((await store.claim("helper", "delayed", TTL, 1000)).status).toBe("duplicate");
    now += 1;
    expect((await store.claim("helper", "delayed", TTL, 1000)).status).toBe("claimed");
  });

  it("records failed delivery separately without retrying the completed action", async () => {
    const store = new InMemoryWebhookEventStore();
    const claim = await store.claim("helper", "reply", TTL, 120_000);
    if (claim.status !== "claimed") throw new Error("missing lease");
    const receipt = new WebhookReceipt(store, claim.lease);
    const delivery = vi.spyOn(store, "delivery");
    const replyText = vi.fn().mockRejectedValue(new Error("reply result unknown"));
    await receipt.start();
    await receipt.finish(true);
    await receipt.lineClient({ replyText }).replyText("token", "done");
    expect(delivery.mock.calls.map((call) => call[1])).toEqual(["attempted", "unknown"]);
    expect((await store.claim("helper", "reply", TTL, 120_000)).status).toBe("duplicate");
    await receipt.lineClient({ replyText }).replyText("token", "do not retry");
    expect(replyText).toHaveBeenCalledOnce();
  });

  it("releases only a pre-dispatch failure and never releases an uncertain operation", async () => {
    const store = new InMemoryWebhookEventStore();
    const first = await store.claim("helper", "retry", TTL, 120_000);
    if (first.status !== "claimed") throw new Error("missing lease");
    await new WebhookReceipt(store, first.lease).finish(false);
    const next = await store.claim("helper", "retry", TTL, 120_000);
    if (next.status !== "claimed") throw new Error("missing retry lease");
    const receipt = new WebhookReceipt(store, next.lease);
    await receipt.start();
    await receipt.finish(false);
    expect((await store.claim("helper", "retry", TTL, 120_000)).status).toBe("uncertain");
  });
});
