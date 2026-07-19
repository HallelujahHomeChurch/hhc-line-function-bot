import {
  InMemoryWebhookEventStore,
  RedisWebhookEventStore,
  type RedisWebhookEventClient,
  type WebhookEventStore
} from "./webhook-event-store.js";

export function createWebhookEventStore(redis?: {
  client: RedisWebhookEventClient;
  keyPrefix: string;
}): WebhookEventStore {
  return redis
    ? new RedisWebhookEventStore(redis.client, redis.keyPrefix)
    : new InMemoryWebhookEventStore();
}
