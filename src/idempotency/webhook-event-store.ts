export type WebhookEventStartResult = "started" | "duplicate";

export interface WebhookEventStore {
  tryStart(
    profileName: string,
    webhookEventId: string,
    ttlMs: number
  ): Promise<WebhookEventStartResult>;
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly events = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async tryStart(
    profileName: string,
    webhookEventId: string,
    ttlMs: number
  ): Promise<WebhookEventStartResult> {
    const key = serialize(profileName, webhookEventId);
    const current = this.now().getTime();
    const expiresAt = this.events.get(key);
    if (expiresAt && expiresAt > current) return "duplicate";
    this.events.set(key, current + Math.max(1, ttlMs));
    for (const [candidate, expiry] of this.events) {
      if (expiry <= current) this.events.delete(candidate);
    }
    return "started";
  }
}

export interface RedisWebhookEventClient {
  set(
    key: string,
    value: string,
    options: { NX: true; PX: number }
  ): Promise<"OK" | "Ok" | "ok" | string | null>;
}

export class RedisWebhookEventStore implements WebhookEventStore {
  constructor(
    private readonly client: RedisWebhookEventClient,
    private readonly keyPrefix: string
  ) {}

  async tryStart(
    profileName: string,
    webhookEventId: string,
    ttlMs: number
  ): Promise<WebhookEventStartResult> {
    const result = await this.client.set(this.key(profileName, webhookEventId), "1", {
      NX: true,
      PX: Math.max(1, ttlMs)
    });
    return result ? "started" : "duplicate";
  }

  private key(profileName: string, webhookEventId: string): string {
    return `${this.keyPrefix}:webhook-event:v1:${serialize(profileName, webhookEventId)}`;
  }
}

function serialize(profileName: string, webhookEventId: string): string {
  return `${encodeURIComponent(profileName)}:${encodeURIComponent(webhookEventId)}`;
}
