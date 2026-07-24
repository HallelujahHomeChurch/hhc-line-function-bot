import { randomUUID } from "node:crypto";

import type { AgentJobScope, AgentJobStore } from "../agent/jobs.js";
import type { FunctionExecutionResult } from "../types.js";

export type AttachmentScanWorkStatus =
  "pending_enqueue" | "queued" | "claimed" | "completed" | "failed";

export type AttachmentScanFailureCode =
  | "enqueue_failed"
  | "download_failed"
  | "validation_failed"
  | "scan_infected"
  | "scan_unavailable"
  | "signature_stale"
  | "publish_failed"
  | "worker_failed";

export interface AttachmentScanTarget {
  sourceKey: string;
  itemKind: string;
  domain: string;
  title: string;
}

export interface AttachmentScanWorkInput {
  jobId: string;
  lineMessageId?: string;
  externalUrl?: string;
  scope: AgentJobScope & { requesterUserId: string };
  target: AttachmentScanTarget;
  ttlMs: number;
}

export interface AttachmentScanWork {
  version: 1;
  id: string;
  jobId: string;
  lineMessageId?: string;
  externalUrl?: string;
  scope: AgentJobScope & { requesterUserId: string };
  target: AttachmentScanTarget;
  status: AttachmentScanWorkStatus;
  failureCode?: AttachmentScanFailureCode;
  createdAt: string;
  claimedAt?: string;
  claimId?: string;
  claimExpiresAt?: string;
  completedAt?: string;
  expiresAt: string;
}

export interface AttachmentScanWorkStore {
  readonly supportsDurableEnqueueRetry: boolean;
  create(input: AttachmentScanWorkInput): Promise<AttachmentScanWork>;
  markEnqueued(id: string): Promise<boolean>;
  listPendingEnqueue(limit: number): Promise<AttachmentScanWork[]>;
  claim(id: string): Promise<AttachmentScanWork | undefined>;
  cancelPendingEnqueue(id: string, code: AttachmentScanFailureCode): Promise<boolean>;
  terminalStatus(
    id: string
  ): Promise<Extract<AttachmentScanWorkStatus, "completed" | "failed"> | undefined>;
  complete(id: string, claimId: string, result: FunctionExecutionResult): Promise<boolean>;
  fail(id: string, claimId: string, code: AttachmentScanFailureCode): Promise<boolean>;
}

export interface RedisAttachmentScanWorkClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const createWorkScript = `
redis.call("PSETEX", KEYS[1], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[2], ARGV[3])
return ARGV[2]
`;

const workSchemaValidationScript = `
local function isNonEmptyString(value)
  return type(value) == "string" and string.len(value) > 0
end

local function isCanonicalTimestamp(value)
  return
    type(value) == "string" and
    string.len(value) == 24 and
    string.match(value, "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$") ~= nil
end

local function hasOnlyKeys(value, allowed)
  for key, _ in pairs(value) do
    if not allowed[key] then
      return false
    end
  end
  return true
end

local valid =
  work.version == 1 and
  hasOnlyKeys(work, {
    version = true,
    id = true,
    jobId = true,
    lineMessageId = true,
    externalUrl = true,
    scope = true,
    target = true,
    status = true,
    createdAt = true,
    expiresAt = true,
    claimedAt = true,
    claimId = true,
    claimExpiresAt = true,
    completedAt = true,
    failureCode = true
  }) and
  isNonEmptyString(work.id) and
  isNonEmptyString(work.jobId) and
  (
    (isNonEmptyString(work.lineMessageId) and work.externalUrl == nil) or
    (isNonEmptyString(work.externalUrl) and work.lineMessageId == nil)
  ) and
  type(work.scope) == "table" and
  hasOnlyKeys(work.scope, {
    profileName = true,
    sourceKey = true,
    requesterUserId = true
  }) and
  isNonEmptyString(work.scope.profileName) and
  isNonEmptyString(work.scope.sourceKey) and
  isNonEmptyString(work.scope.requesterUserId) and
  type(work.target) == "table" and
  hasOnlyKeys(work.target, {
    sourceKey = true,
    itemKind = true,
    domain = true,
    title = true
  }) and
  isNonEmptyString(work.target.sourceKey) and
  isNonEmptyString(work.target.itemKind) and
  isNonEmptyString(work.target.domain) and
  isNonEmptyString(work.target.title) and
  isCanonicalTimestamp(work.createdAt) and
  isCanonicalTimestamp(work.expiresAt)

if not valid then
  return nil
end
`;

const claimScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return nil
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
local claimable =
  work.status == "queued" or
  (
    work.status == "claimed" and
    isCanonicalTimestamp(work.claimExpiresAt) and
    work.claimExpiresAt <= ARGV[2]
  )
if work.id ~= ARGV[1] or not claimable or work.expiresAt <= ARGV[2] then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.status = "claimed"
work.claimedAt = ARGV[3]
work.claimId = ARGV[4]
work.claimExpiresAt = ARGV[5]
local claimed = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, claimed)
return claimed
`;

const markEnqueuedScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return nil
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
if work.id ~= ARGV[1] or work.status ~= "pending_enqueue" or work.expiresAt <= ARGV[2] then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.status = "queued"
local queued = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, queued)
redis.call("SREM", KEYS[2], work.id)
return queued
`;

const cancelPendingEnqueueScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return nil
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
if work.id ~= ARGV[1] or work.status ~= "pending_enqueue" or work.expiresAt <= ARGV[2] then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.status = "failed"
work.failureCode = ARGV[3]
work.completedAt = ARGV[2]
local failed = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, failed)
redis.call("SREM", KEYS[2], work.id)
return failed
`;

const terminalTransitionScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return nil
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
if work.id ~= ARGV[1] or work.status ~= "claimed" or work.claimId ~= ARGV[2] then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.status = ARGV[3]
work.completedAt = ARGV[4]
work.claimId = nil
work.claimExpiresAt = nil
if ARGV[5] ~= "" then
  work.failureCode = ARGV[5]
end
local terminal = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, terminal)
redis.call("SREM", KEYS[2], work.id)
return terminal
`;

interface ScanWorkStoreOptions {
  jobStore: AgentJobStore;
  now?: () => Date;
  idFactory?: () => string;
  claimIdFactory?: () => string;
  claimLeaseMs?: number;
}

export class InMemoryAttachmentScanWorkStore implements AttachmentScanWorkStore {
  readonly supportsDurableEnqueueRetry = false;
  private readonly values = new Map<string, AttachmentScanWork>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly claimIdFactory: () => string;
  private readonly claimLeaseMs: number;

  constructor(private readonly options: ScanWorkStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.claimIdFactory = options.claimIdFactory ?? randomUUID;
    this.claimLeaseMs = options.claimLeaseMs ?? 15 * 60 * 1000;
  }

  async create(input: AttachmentScanWorkInput): Promise<AttachmentScanWork> {
    assertValidWorkSource(input);
    const createdAt = this.now();
    const work: AttachmentScanWork = {
      version: 1,
      id: this.idFactory(),
      jobId: input.jobId,
      ...(input.lineMessageId ? { lineMessageId: input.lineMessageId } : {}),
      ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
      scope: { ...input.scope },
      target: { ...input.target },
      status: "pending_enqueue",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString()
    };
    this.values.set(work.id, work);
    return cloneWork(work);
  }

  async markEnqueued(id: string): Promise<boolean> {
    const work = this.live(id);
    if (!work || work.status !== "pending_enqueue") return false;
    this.values.set(id, { ...work, status: "queued" });
    return true;
  }

  async listPendingEnqueue(limit: number): Promise<AttachmentScanWork[]> {
    return Array.from(this.values.values())
      .map((work) => this.live(work.id))
      .filter((work): work is AttachmentScanWork => work?.status === "pending_enqueue")
      .slice(0, Math.max(0, limit))
      .map(cloneWork);
  }

  async claim(id: string): Promise<AttachmentScanWork | undefined> {
    const work = this.values.get(id);
    const claimedAt = this.now();
    if (
      !work ||
      work.id !== id ||
      !(
        work.status === "queued" ||
        (work.status === "claimed" &&
          Boolean(work.claimExpiresAt) &&
          work.claimExpiresAt! <= claimedAt.toISOString())
      ) ||
      work.expiresAt <= claimedAt.toISOString()
    ) {
      return undefined;
    }
    const claimed: AttachmentScanWork = {
      ...work,
      status: "claimed",
      claimedAt: claimedAt.toISOString(),
      claimId: this.claimIdFactory(),
      claimExpiresAt: new Date(claimedAt.getTime() + this.claimLeaseMs).toISOString()
    };
    this.values.set(id, claimed);
    return cloneWork(claimed);
  }

  async cancelPendingEnqueue(id: string, code: AttachmentScanFailureCode): Promise<boolean> {
    const work = this.live(id);
    if (!work || work.status !== "pending_enqueue") return false;
    this.values.set(id, {
      ...work,
      status: "failed",
      failureCode: code,
      completedAt: this.now().toISOString()
    });
    return true;
  }

  async terminalStatus(
    id: string
  ): Promise<Extract<AttachmentScanWorkStatus, "completed" | "failed"> | undefined> {
    const status = this.live(id)?.status;
    return status === "completed" || status === "failed" ? status : undefined;
  }

  async complete(id: string, claimId: string, result: FunctionExecutionResult): Promise<boolean> {
    const work = this.live(id);
    if (!work || work.status !== "claimed" || work.claimId !== claimId) return false;
    await this.options.jobStore.complete(work.jobId, result);
    this.values.set(id, {
      ...work,
      status: "completed",
      claimId: undefined,
      claimExpiresAt: undefined,
      completedAt: this.now().toISOString()
    });
    return true;
  }

  async fail(id: string, claimId: string, code: AttachmentScanFailureCode): Promise<boolean> {
    const work = this.live(id);
    if (!work || work.status !== "claimed" || work.claimId !== claimId) return false;
    await this.options.jobStore.fail(work.jobId, code);
    this.values.set(id, {
      ...work,
      status: "failed",
      failureCode: code,
      claimId: undefined,
      claimExpiresAt: undefined,
      completedAt: this.now().toISOString()
    });
    return true;
  }

  private live(id: string): AttachmentScanWork | undefined {
    const work = this.values.get(id);
    if (!work || work.expiresAt <= this.now().toISOString()) {
      this.values.delete(id);
      return undefined;
    }
    return work;
  }
}

export class RedisAttachmentScanWorkStore implements AttachmentScanWorkStore {
  readonly supportsDurableEnqueueRetry = true;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly claimIdFactory: () => string;
  private readonly claimLeaseMs: number;

  constructor(
    private readonly options: ScanWorkStoreOptions & {
      client: RedisAttachmentScanWorkClient;
      keyPrefix: string;
    }
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.claimIdFactory = options.claimIdFactory ?? randomUUID;
    this.claimLeaseMs = options.claimLeaseMs ?? 15 * 60 * 1000;
  }

  async create(input: AttachmentScanWorkInput): Promise<AttachmentScanWork> {
    assertValidWorkSource(input);
    const createdAt = this.now();
    const work: AttachmentScanWork = {
      version: 1,
      id: this.idFactory(),
      jobId: input.jobId,
      ...(input.lineMessageId ? { lineMessageId: input.lineMessageId } : {}),
      ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
      scope: { ...input.scope },
      target: { ...input.target },
      status: "pending_enqueue",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString()
    };
    const ttlMs = new Date(work.expiresAt).getTime() - this.now().getTime();
    await this.options.client.eval(createWorkScript, {
      keys: [this.key(work.id), this.pendingIndexKey()],
      arguments: [String(Math.max(1, ttlMs)), JSON.stringify(work), work.id]
    });
    return cloneWork(work);
  }

  async markEnqueued(id: string): Promise<boolean> {
    const now = this.now().toISOString();
    const raw = await this.options.client.eval(markEnqueuedScript, {
      keys: [this.key(id), this.pendingIndexKey()],
      arguments: [id, now]
    });
    return typeof raw === "string" && parseWork(raw, id)?.status === "queued";
  }

  async listPendingEnqueue(limit: number): Promise<AttachmentScanWork[]> {
    // Redis work IDs are opaque and independently expiring. The durable dispatcher keeps
    // its bounded index through the store implementation added below.
    return this.readPendingIndex(Math.max(0, limit));
  }

  async claim(id: string): Promise<AttachmentScanWork | undefined> {
    const claimedAtDate = this.now();
    const claimedAt = claimedAtDate.toISOString();
    const raw = await this.options.client.eval(claimScript, {
      keys: [this.key(id)],
      arguments: [
        id,
        claimedAt,
        claimedAt,
        this.claimIdFactory(),
        new Date(claimedAtDate.getTime() + this.claimLeaseMs).toISOString()
      ]
    });
    if (typeof raw !== "string") return undefined;
    return parseWork(raw, id);
  }

  async cancelPendingEnqueue(id: string, code: AttachmentScanFailureCode): Promise<boolean> {
    const cancelledAt = this.now().toISOString();
    const raw = await this.options.client.eval(cancelPendingEnqueueScript, {
      keys: [this.key(id), this.pendingIndexKey()],
      arguments: [id, cancelledAt, code]
    });
    if (typeof raw !== "string") return false;
    const work = parseWork(raw, id);
    return work?.status === "failed" && work.failureCode === code;
  }

  async terminalStatus(
    id: string
  ): Promise<Extract<AttachmentScanWorkStatus, "completed" | "failed"> | undefined> {
    const work = await this.read(id);
    return work?.status === "completed" || work?.status === "failed" ? work.status : undefined;
  }

  async complete(id: string, claimId: string, result: FunctionExecutionResult): Promise<boolean> {
    const work = await this.read(id);
    if (!work || work.status !== "claimed" || work.claimId !== claimId) return false;
    await this.options.jobStore.complete(work.jobId, result);
    return this.transitionTerminal(work, claimId, "completed");
  }

  async fail(id: string, claimId: string, code: AttachmentScanFailureCode): Promise<boolean> {
    const work = await this.read(id);
    if (!work || work.status !== "claimed" || work.claimId !== claimId) return false;
    await this.options.jobStore.fail(work.jobId, code);
    return this.transitionTerminal(work, claimId, "failed", code);
  }

  private async transitionTerminal(
    work: AttachmentScanWork,
    claimId: string,
    status: "completed" | "failed",
    code?: AttachmentScanFailureCode
  ): Promise<boolean> {
    const raw = await this.options.client.eval(terminalTransitionScript, {
      keys: [this.key(work.id), this.pendingIndexKey()],
      arguments: [work.id, claimId, status, this.now().toISOString(), code ?? ""]
    });
    return typeof raw === "string" && parseWork(raw, work.id)?.status === status;
  }

  private async readPendingIndex(limit: number): Promise<AttachmentScanWork[]> {
    const ids = await this.options.client.sMembers(this.pendingIndexKey());
    const pending: AttachmentScanWork[] = [];
    for (const id of ids.slice(0, limit)) {
      const work = await this.read(id);
      if (work?.status === "pending_enqueue") {
        pending.push(work);
      } else {
        await this.options.client.sRem(this.pendingIndexKey(), id);
      }
    }
    return pending;
  }

  private async read(id: string): Promise<AttachmentScanWork | undefined> {
    const raw = await this.options.client.get(this.key(id));
    if (!raw) return undefined;
    const work = parseWork(raw, id);
    if (!work || work.expiresAt <= this.now().toISOString()) return undefined;
    return work;
  }

  private async write(work: AttachmentScanWork): Promise<void> {
    const ttlMs = new Date(work.expiresAt).getTime() - this.now().getTime();
    await this.options.client.setEx(
      this.key(work.id),
      Math.max(1, Math.ceil(ttlMs / 1000)),
      JSON.stringify(work)
    );
    if (work.status === "pending_enqueue") {
      await this.options.client.sAdd(this.pendingIndexKey(), work.id);
    } else {
      await this.options.client.sRem(this.pendingIndexKey(), work.id);
    }
  }

  private key(id: string): string {
    return `${this.options.keyPrefix}:attachment-scan-work:${encodeURIComponent(id)}`;
  }

  private pendingIndexKey(): string {
    return `${this.options.keyPrefix}:attachment-scan-outbox`;
  }
}

function parseWork(raw: string, expectedId: string): AttachmentScanWork | undefined {
  try {
    const work = JSON.parse(raw) as Partial<AttachmentScanWork>;
    if (
      work.version !== 1 ||
      work.id !== expectedId ||
      !isNonEmptyString(work.jobId) ||
      !(
        (isNonEmptyString(work.lineMessageId) && work.externalUrl === undefined) ||
        (isNonEmptyString(work.externalUrl) && work.lineMessageId === undefined)
      ) ||
      !work.scope ||
      !isNonEmptyString(work.scope.profileName) ||
      !isNonEmptyString(work.scope.sourceKey) ||
      !isNonEmptyString(work.scope.requesterUserId) ||
      !work.target ||
      !isNonEmptyString(work.target.sourceKey) ||
      !isNonEmptyString(work.target.itemKind) ||
      !isNonEmptyString(work.target.domain) ||
      !isNonEmptyString(work.target.title) ||
      !isWorkStatus(work.status) ||
      !isTimestamp(work.createdAt) ||
      !isTimestamp(work.expiresAt) ||
      (work.failureCode !== undefined && !isFailureCode(work.failureCode)) ||
      (work.claimedAt !== undefined && !isTimestamp(work.claimedAt)) ||
      (work.claimId !== undefined && !isNonEmptyString(work.claimId)) ||
      (work.claimExpiresAt !== undefined && !isTimestamp(work.claimExpiresAt)) ||
      (work.completedAt !== undefined && !isTimestamp(work.completedAt))
    ) {
      return undefined;
    }
    return {
      version: 1,
      id: work.id,
      jobId: work.jobId,
      ...(work.lineMessageId ? { lineMessageId: work.lineMessageId } : {}),
      ...(work.externalUrl ? { externalUrl: work.externalUrl } : {}),
      scope: {
        profileName: work.scope.profileName,
        sourceKey: work.scope.sourceKey,
        requesterUserId: work.scope.requesterUserId
      },
      target: {
        sourceKey: work.target.sourceKey,
        itemKind: work.target.itemKind,
        domain: work.target.domain,
        title: work.target.title
      },
      status: work.status,
      createdAt: work.createdAt,
      expiresAt: work.expiresAt,
      ...(work.failureCode ? { failureCode: work.failureCode } : {}),
      ...(work.claimedAt ? { claimedAt: work.claimedAt } : {}),
      ...(work.claimId ? { claimId: work.claimId } : {}),
      ...(work.claimExpiresAt ? { claimExpiresAt: work.claimExpiresAt } : {}),
      ...(work.completedAt ? { completedAt: work.completedAt } : {})
    };
  } catch {
    return undefined;
  }
}

function isWorkStatus(value: unknown): value is AttachmentScanWorkStatus {
  return (
    value === "pending_enqueue" ||
    value === "queued" ||
    value === "claimed" ||
    value === "completed" ||
    value === "failed"
  );
}

function isFailureCode(value: unknown): value is AttachmentScanFailureCode {
  return (
    value === "enqueue_failed" ||
    value === "download_failed" ||
    value === "validation_failed" ||
    value === "scan_infected" ||
    value === "scan_unavailable" ||
    value === "signature_stale" ||
    value === "publish_failed" ||
    value === "worker_failed"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cloneWork(work: AttachmentScanWork): AttachmentScanWork {
  return {
    ...work,
    scope: { ...work.scope },
    target: { ...work.target }
  };
}

function assertValidWorkSource(input: AttachmentScanWorkInput): void {
  if (Boolean(input.lineMessageId?.trim()) === Boolean(input.externalUrl?.trim())) {
    throw new Error("attachment_scan_work_source_invalid");
  }
  if (input.externalUrl) {
    const url = new URL(input.externalUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("attachment_scan_work_source_invalid");
    }
  }
}
