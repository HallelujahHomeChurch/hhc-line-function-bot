import { createHash, randomUUID } from "node:crypto";

export type WebhookEventStartResult = "started" | "duplicate";
export type ReceiptPhase = "admitting" | "started" | "completed" | "uncertain";
export type ReceiptDelivery = "not_attempted" | "attempted" | "accepted" | "unknown";
export interface WebhookReceiptLease {
  profileName: string;
  eventId: string;
  owner: string;
  operationId: string;
  leaseMs: number;
}
export type WebhookReceiptClaim =
  { status: "claimed"; lease: WebhookReceiptLease } | { status: "duplicate" | "uncertain" };
export type ReceiptTransition = "start" | "complete" | "uncertain" | "release" | "renew";

export interface WebhookEventStore {
  tryStart(
    profileName: string,
    webhookEventId: string,
    ttlMs: number
  ): Promise<WebhookEventStartResult>;
  claim?(
    profileName: string,
    eventId: string,
    ttlMs: number,
    leaseMs: number
  ): Promise<WebhookReceiptClaim>;
  transition?(lease: WebhookReceiptLease, transition: ReceiptTransition): Promise<boolean>;
  delivery?(lease: WebhookReceiptLease, status: ReceiptDelivery): Promise<boolean>;
}
interface Receipt {
  owner: string;
  operationId: string;
  phase: ReceiptPhase;
  delivery: ReceiptDelivery;
  leaseUntil: number;
  expiresAt: number;
  retentionMs: number;
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly events = new Map<string, number | Receipt>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async tryStart(
    profileName: string,
    eventId: string,
    ttlMs: number
  ): Promise<WebhookEventStartResult> {
    const key = serialize(profileName, eventId);
    if (this.current(key)) return "duplicate";
    this.events.set(key, this.now().getTime() + Math.max(1, ttlMs));
    return "started";
  }

  async claim(
    profileName: string,
    eventId: string,
    ttlMs: number,
    leaseMs: number
  ): Promise<WebhookReceiptClaim> {
    const key = serialize(profileName, eventId);
    const now = this.now().getTime();
    const current = this.current(key);
    if (current) {
      if (typeof current === "number" || current.phase === "completed")
        return { status: "duplicate" };
      if (current.phase === "uncertain") return { status: "uncertain" };
      if (current.leaseUntil > now) return { status: "duplicate" };
      if (current.phase === "started") {
        current.phase = "uncertain";
        current.expiresAt = now + current.retentionMs;
        return { status: "uncertain" };
      }
    }
    const lease = newLease(profileName, eventId, leaseMs);
    this.events.set(key, {
      owner: lease.owner,
      operationId: lease.operationId,
      phase: "admitting",
      delivery: "not_attempted",
      leaseUntil: now + lease.leaseMs,
      expiresAt: now + ttlMs,
      retentionMs: ttlMs
    });
    return { status: "claimed", lease };
  }

  async transition(lease: WebhookReceiptLease, transition: ReceiptTransition): Promise<boolean> {
    const record = this.owned(lease);
    if (!record || record.phase === "completed" || record.phase === "uncertain") return false;
    if (transition === "start") {
      if (record.phase !== "admitting") return false;
      record.phase = "started";
    } else if (transition === "complete") record.phase = "completed";
    else if (transition === "uncertain") record.phase = "uncertain";
    else if (transition === "release") {
      if (record.phase !== "admitting") return false;
      record.leaseUntil = 0;
    } else record.leaseUntil = this.now().getTime() + lease.leaseMs;
    if (transition === "complete" || transition === "uncertain") {
      record.expiresAt = this.now().getTime() + record.retentionMs;
    }
    return true;
  }

  async delivery(lease: WebhookReceiptLease, status: ReceiptDelivery): Promise<boolean> {
    const record = this.owned(lease);
    if (
      !record ||
      (status === "attempted"
        ? record.delivery !== "not_attempted"
        : record.delivery !== "attempted")
    )
      return false;
    record.delivery = status;
    return true;
  }

  private owned(lease: WebhookReceiptLease): Receipt | undefined {
    const record = this.current(serialize(lease.profileName, lease.eventId));
    return record &&
      typeof record !== "number" &&
      record.owner === lease.owner &&
      record.leaseUntil > this.now().getTime()
      ? record
      : undefined;
  }
  private current(key: string): number | Receipt | undefined {
    const now = this.now().getTime();
    for (const [candidate, record] of this.events) {
      if ((typeof record === "number" ? record : record.expiresAt) <= now)
        this.events.delete(candidate);
    }
    return this.events.get(key);
  }
}

export interface RedisWebhookEventClient {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const CLAIM = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
if raw then
  if raw == '1' then return 'duplicate' end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' then return 'duplicate' end
  if record.phase == 'completed' then return 'duplicate' end
  if record.phase == 'uncertain' then return 'uncertain' end
  if record.leaseUntil > now then return 'duplicate' end
  if record.phase ~= 'admitting' then
    record.phase = 'uncertain'
    local ttl = redis.call('PTTL', KEYS[1])
    redis.call('PSETEX', KEYS[1], record.retentionMs or math.max(1, ttl), cjson.encode(record))
    return 'uncertain'
  end
end
local record = {owner=ARGV[1], operationId=ARGV[2], phase='admitting', delivery='not_attempted', leaseUntil=now+tonumber(ARGV[4]), retentionMs=tonumber(ARGV[3])}
redis.call('PSETEX', KEYS[1], ARGV[3], cjson.encode(record))
return 'claimed'
`;
const TRANSITION = `
local raw = redis.call('GET', KEYS[1])
if not raw or raw == '1' then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record.owner ~= ARGV[1] then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or record.leaseUntil <= now then return 0 end
local operation = ARGV[2]
if operation == 'delivery' then
  if ARGV[4] == 'attempted' then
    if record.delivery ~= 'not_attempted' then return 0 end
  elseif record.delivery ~= 'attempted' then return 0 end
  record.delivery = ARGV[4]
else
  if record.phase == 'completed' or record.phase == 'uncertain' then return 0 end
  if operation == 'start' then
    if record.phase ~= 'admitting' then return 0 end
    record.phase = 'started'
  elseif operation == 'complete' then record.phase = 'completed'
  elseif operation == 'uncertain' then record.phase = 'uncertain'
  elseif operation == 'release' then
    if record.phase ~= 'admitting' then return 0 end
    record.leaseUntil = 0
  elseif operation == 'renew' then record.leaseUntil = now + tonumber(ARGV[3])
  else return 0 end
end
if operation == 'complete' or operation == 'uncertain' then ttl = record.retentionMs or ttl end
redis.call('PSETEX', KEYS[1], ttl, cjson.encode(record))
return 1
`;

export class RedisWebhookEventStore implements WebhookEventStore {
  constructor(
    private readonly client: RedisWebhookEventClient,
    private readonly keyPrefix: string
  ) {}
  async tryStart(
    profileName: string,
    eventId: string,
    ttlMs: number
  ): Promise<WebhookEventStartResult> {
    const result = await this.client.set(this.key(profileName, eventId), "1", {
      NX: true,
      PX: Math.max(1, ttlMs)
    });
    return result ? "started" : "duplicate";
  }
  async claim(
    profileName: string,
    eventId: string,
    ttlMs: number,
    leaseMs: number
  ): Promise<WebhookReceiptClaim> {
    if (!this.client.eval) throw new Error("webhook_receipt_atomic_store_required");
    const lease = newLease(profileName, eventId, leaseMs);
    const status = await this.client.eval(CLAIM, {
      keys: [this.key(profileName, eventId)],
      arguments: [lease.owner, lease.operationId, String(Math.max(1, ttlMs)), String(lease.leaseMs)]
    });
    if (status === "claimed") return { status, lease };
    if (status === "duplicate" || status === "uncertain") return { status };
    throw new Error("webhook_receipt_invalid_claim");
  }
  async transition(lease: WebhookReceiptLease, transition: ReceiptTransition): Promise<boolean> {
    return this.mutate(lease, transition);
  }
  async delivery(lease: WebhookReceiptLease, status: ReceiptDelivery): Promise<boolean> {
    return this.mutate(lease, "delivery", status);
  }
  private async mutate(
    lease: WebhookReceiptLease,
    operation: string,
    delivery = ""
  ): Promise<boolean> {
    if (!this.client.eval) throw new Error("webhook_receipt_atomic_store_required");
    return (
      (await this.client.eval(TRANSITION, {
        keys: [this.key(lease.profileName, lease.eventId)],
        arguments: [lease.owner, operation, String(lease.leaseMs), delivery]
      })) === 1
    );
  }
  private key(profileName: string, eventId: string): string {
    return `${this.keyPrefix}:webhook-event:v1:${serialize(profileName, eventId)}`;
  }
}

function newLease(profileName: string, eventId: string, leaseMs: number): WebhookReceiptLease {
  return {
    profileName,
    eventId,
    owner: randomUUID(),
    leaseMs: Math.max(1, leaseMs),
    operationId: createHash("sha256").update(serialize(profileName, eventId)).digest("hex")
  };
}
function serialize(profileName: string, eventId: string): string {
  return `${encodeURIComponent(profileName)}:${encodeURIComponent(eventId)}`;
}
