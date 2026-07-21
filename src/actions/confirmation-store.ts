import { createHash, randomBytes } from "node:crypto";

import type { AdminActionName, JsonRecord } from "../types.js";

export interface ConfirmationRequest {
  id: string;
  profileName: string;
  actorUserId: string;
  action: AdminActionName;
  args?: JsonRecord;
  createdAt: string;
  expiresAt: string;
}

export interface CreateConfirmationRequestInput {
  profileName: string;
  actorUserId: string;
  action: AdminActionName;
  args?: JsonRecord;
  ttlMinutes: number;
  now?: Date;
}

export interface ConfirmationStore {
  create(input: CreateConfirmationRequestInput): Promise<ConfirmationRequest>;
  consume(
    id: string,
    actorUserId: string,
    profileName: string
  ): Promise<ConfirmationRequest | null>;
}

export interface RedisConfirmationClient {
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const CONSUME_CONFIRMATION_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then
  return nil
end
local ok, decoded = pcall(cjson.decode, value)
if not ok or type(decoded) ~= 'table' then
  return nil
end
if decoded.profileName ~= ARGV[1] or decoded.actorUserId ~= ARGV[2] then
  return nil
end
redis.call('DEL', KEYS[1])
return value
`;

export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly records = new Map<string, ConfirmationRequest>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: { idFactory?: () => string; now?: () => Date } = {}) {
    this.idFactory = options.idFactory ?? generateConfirmationId;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateConfirmationRequestInput): Promise<ConfirmationRequest> {
    const now = input.now ?? this.now();
    const id = this.idFactory();
    const request: ConfirmationRequest = {
      id,
      profileName: input.profileName,
      actorUserId: input.actorUserId,
      action: input.action,
      args: sanitizeArgs(input.args),
      createdAt: now.toISOString(),
      expiresAt: addMinutes(now, input.ttlMinutes).toISOString()
    };
    this.records.set(key(input.profileName, id), request);
    return request;
  }

  async consume(
    id: string,
    actorUserId: string,
    profileName: string
  ): Promise<ConfirmationRequest | null> {
    const requestKey = key(profileName, id);
    const request = this.records.get(requestKey);
    if (!request) {
      return null;
    }
    if (request.actorUserId !== actorUserId || request.profileName !== profileName) {
      return null;
    }
    this.records.delete(requestKey);
    if (new Date(request.expiresAt).getTime() <= this.now().getTime()) {
      return null;
    }
    return request;
  }
}

export class RedisConfirmationStore implements ConfirmationStore {
  private readonly client: RedisConfirmationClient;
  private readonly keyPrefix: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: {
    client: RedisConfirmationClient;
    keyPrefix: string;
    idFactory?: () => string;
    now?: () => Date;
  }) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix;
    this.idFactory = options.idFactory ?? generateConfirmationId;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateConfirmationRequestInput): Promise<ConfirmationRequest> {
    const now = input.now ?? this.now();
    const id = this.idFactory();
    const request: ConfirmationRequest = {
      id,
      profileName: input.profileName,
      actorUserId: input.actorUserId,
      action: input.action,
      args: sanitizeArgs(input.args),
      createdAt: now.toISOString(),
      expiresAt: addMinutes(now, input.ttlMinutes).toISOString()
    };
    await this.client.setEx(
      this.key(input.profileName, id),
      ttlSeconds(input.ttlMinutes),
      JSON.stringify(request)
    );
    return request;
  }

  async consume(
    id: string,
    actorUserId: string,
    profileName: string
  ): Promise<ConfirmationRequest | null> {
    const raw = await this.client.eval(CONSUME_CONFIRMATION_SCRIPT, {
      keys: [this.key(profileName, id)],
      arguments: [profileName, actorUserId]
    });
    if (typeof raw !== "string") {
      return null;
    }
    try {
      const request = JSON.parse(raw) as ConfirmationRequest;
      if (request.actorUserId !== actorUserId || request.profileName !== profileName) {
        return null;
      }
      if (new Date(request.expiresAt).getTime() <= this.now().getTime()) {
        return null;
      }
      return request;
    } catch {
      return null;
    }
  }

  private key(profileName: string, id: string): string {
    return `${this.keyPrefix}:confirm:${profileName}:${hashConfirmationId(id)}`;
  }
}

export function generateConfirmationId(): string {
  return randomBytes(9).toString("base64url");
}

function key(profileName: string, id: string): string {
  return `${profileName}:${hashConfirmationId(id)}`;
}

function hashConfirmationId(id: string): string {
  return createHash("sha256").update(id.trim(), "utf8").digest("hex");
}

function addMinutes(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60 * 1000);
}

function ttlSeconds(ttlMinutes: number): number {
  return Math.max(1, Math.trunc(ttlMinutes * 60));
}

function sanitizeArgs(args: JsonRecord | undefined): JsonRecord | undefined {
  if (!args) {
    return undefined;
  }
  const sanitized: JsonRecord = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      key === "sourceKey" &&
      typeof value === "string" &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)
    ) {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = value ? "present" : "empty";
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
