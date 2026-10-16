import type { LineReplyClient } from "../../types.js";
import type {
  WebhookEventStore,
  WebhookReceiptLease
} from "../../idempotency/webhook-event-store.js";

/** Owns only a webhook receipt. Business effects still require their own authority/idempotency. */
export class WebhookReceipt {
  private started = false;
  private settled = false;
  private lost = false;
  private heartbeat: ReturnType<typeof setInterval>;
  deferred = false;

  constructor(
    private readonly store: WebhookEventStore,
    readonly lease: WebhookReceiptLease
  ) {
    if (!store.transition || !store.delivery) throw new Error("webhook_receipt_store_required");
    this.heartbeat = setInterval(
      () => {
        void store.transition!(lease, "renew")
          .then((owned) => {
            if (!owned) this.lost = true;
          })
          .catch(() => {
            this.lost = true;
          });
      },
      Math.max(1, Math.floor(lease.leaseMs / 3))
    );
    this.heartbeat.unref();
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.lost || !(await this.store.transition!(this.lease, "start"))) {
      throw new Error("webhook_receipt_ownership_lost");
    }
    this.started = true;
  }

  async finish(success: boolean): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    clearInterval(this.heartbeat);
    const transition = success ? "complete" : this.started ? "uncertain" : "release";
    if (!(await this.store.transition!(this.lease, transition))) {
      throw new Error("webhook_receipt_ownership_lost");
    }
  }

  lineClient(client: LineReplyClient): LineReplyClient {
    return {
      replyText: async (token, text, options) => {
        // Claim before delivery. A transport error cannot turn a completed business action into a retry.
        if (!(await this.store.delivery!(this.lease, "attempted"))) return;
        let result;
        try {
          result = await client.replyText(token, text, options);
        } catch {
          await this.store.delivery!(this.lease, "unknown");
          return;
        }
        await this.store.delivery!(this.lease, "accepted");
        return result;
      }
    };
  }
}
