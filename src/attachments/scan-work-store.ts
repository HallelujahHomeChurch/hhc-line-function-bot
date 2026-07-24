import { randomUUID } from "node:crypto";

import type { AgentJobScope, AgentJobStore } from "../agent/jobs.js";
import type { FunctionExecutionResult } from "../types.js";

export type AttachmentScanWorkStatus =
  "pending_enqueue" | "queued" | "claimed" | "publishing" | "completed" | "failed";

export type AttachmentScanFailureCode =
  | "enqueue_failed"
  | "download_failed"
  | "validation_failed"
  | "scan_infected"
  | "scan_unavailable"
  | "signature_stale"
  | "publish_failed"
  | "publication_abandoned"
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
  publishingAt?: string;
  publishingExpiresAt?: string;
  pendingJobUpdate?:
    | { status: "completed"; result: FunctionExecutionResult }
    | { status: "failed"; error: AttachmentScanFailureCode };
  completedAt?: string;
  expiresAt: string;
}

export type AttachmentScanClaimDisposition =
  | { disposition: "claimed"; work: AttachmentScanWork }
  | { disposition: "active" }
  | {
      disposition: "terminal";
      terminalStatus: Extract<AttachmentScanWorkStatus, "completed" | "failed">;
    }
  | { disposition: "missing" };

export interface AttachmentScanWorkStore {
  readonly supportsDurableEnqueueRetry: boolean;
  create(input: AttachmentScanWorkInput): Promise<AttachmentScanWork>;
  markEnqueued(id: string): Promise<boolean>;
  listPendingEnqueue(limit: number): Promise<AttachmentScanWork[]>;
  claim(id: string): Promise<AttachmentScanWork | undefined>;
  claimForProcessing(id: string): Promise<AttachmentScanClaimDisposition>;
  beginPublishing(id: string, claimId: string, publicationDeadline?: Date): Promise<boolean>;
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
    publishingAt = true,
    publishingExpiresAt = true,
    pendingJobUpdate = true,
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
  (
    work.status == "pending_enqueue" or
    work.status == "queued" or
    work.status == "claimed" or
    work.status == "publishing" or
    work.status == "completed" or
    work.status == "failed"
  ) and
  isCanonicalTimestamp(work.createdAt) and
  isCanonicalTimestamp(work.expiresAt)

if not valid then
  return nil
end
`;

const claimScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return "missing"
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
if work.id ~= ARGV[1] or work.expiresAt <= ARGV[2] then
  return "missing"
end
if work.status == "completed" or work.status == "failed" then
  return "terminal:" .. cjson.encode(work)
end
if work.status == "publishing" then
  if
    isCanonicalTimestamp(work.publishingExpiresAt) and
    work.publishingExpiresAt <= ARGV[2]
  then
    local ttl = redis.call("PTTL", KEYS[1])
    if ttl <= 0 then
      return "missing"
    end
    work.status = "failed"
    work.failureCode = "publication_abandoned"
    work.completedAt = ARGV[2]
    work.claimId = nil
    work.claimExpiresAt = nil
    work.pendingJobUpdate = {
      status = "failed",
      error = "publication_abandoned"
    }
    local abandoned = cjson.encode(work)
    redis.call("PSETEX", KEYS[1], ttl, abandoned)
    redis.call("SREM", KEYS[2], work.id)
    return "abandoned:" .. abandoned
  end
  return "active"
end
local claimable =
  work.status == "queued" or
  (
    work.status == "claimed" and
    isCanonicalTimestamp(work.claimExpiresAt) and
    work.claimExpiresAt <= ARGV[2]
  )
if not claimable then
  return "active"
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return "missing"
end
work.status = "claimed"
work.claimedAt = ARGV[3]
work.claimId = ARGV[4]
work.claimExpiresAt = ARGV[5]
work.publishingAt = nil
work.publishingExpiresAt = nil
local claimed = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, claimed)
return claimed
`;

const beginPublishingScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return nil
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
if
  work.id ~= ARGV[1] or
  work.status ~= "claimed" or
  work.claimId ~= ARGV[2] or
  not isCanonicalTimestamp(work.claimExpiresAt) or
  work.claimExpiresAt <= ARGV[3] or
  work.expiresAt <= ARGV[3] or
  ARGV[4] <= ARGV[3]
then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.status = "publishing"
work.publishingAt = ARGV[3]
work.publishingExpiresAt = ARGV[4]
work.claimExpiresAt = nil
local publishing = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, publishing)
return publishing
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
local ownsClaim =
  work.id == ARGV[1] and
  work.claimId == ARGV[2] and
  (
    (
      ARGV[3] == "complete" and
      work.status == "publishing" and
      isCanonicalTimestamp(work.publishingExpiresAt) and
      work.publishingExpiresAt > ARGV[5]
    ) or
    (
      ARGV[3] == "fail" and
      (
        (
          work.status == "claimed" and
          isCanonicalTimestamp(work.claimExpiresAt) and
          work.claimExpiresAt > ARGV[5]
        ) or
        (
          work.status == "publishing" and
          isCanonicalTimestamp(work.publishingExpiresAt) and
          work.publishingExpiresAt > ARGV[5]
        )
      )
    )
  )
if not ownsClaim or work.expiresAt <= ARGV[5] then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.status = ARGV[4]
work.completedAt = ARGV[5]
work.claimId = nil
work.claimExpiresAt = nil
if ARGV[6] ~= "" then
  work.failureCode = ARGV[6]
end
work.pendingJobUpdate = cjson.decode(ARGV[7])
local terminal = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, terminal)
redis.call("SREM", KEYS[2], work.id)
return terminal
`;

const clearPendingJobUpdateScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return nil
end
local work = cjson.decode(raw)
${workSchemaValidationScript}
if
  work.id ~= ARGV[1] or
  (work.status ~= "completed" and work.status ~= "failed") or
  work.pendingJobUpdate == nil
then
  return nil
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return nil
end
work.pendingJobUpdate = nil
local reconciled = cjson.encode(work)
redis.call("PSETEX", KEYS[1], ttl, reconciled)
return reconciled
`;

interface ScanWorkStoreOptions {
  jobStore: AgentJobStore;
  now?: () => Date;
  idFactory?: () => string;
  claimIdFactory?: () => string;
  claimLeaseMs?: number;
  publishingLeaseMs?: number;
}

export class InMemoryAttachmentScanWorkStore implements AttachmentScanWorkStore {
  readonly supportsDurableEnqueueRetry = false;
  private readonly values = new Map<string, AttachmentScanWork>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly claimIdFactory: () => string;
  private readonly claimLeaseMs: number;
  private readonly publishingLeaseMs: number;

  constructor(private readonly options: ScanWorkStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.claimIdFactory = options.claimIdFactory ?? randomUUID;
    this.claimLeaseMs = options.claimLeaseMs ?? 15 * 60 * 1000;
    this.publishingLeaseMs = options.publishingLeaseMs ?? 15 * 60 * 1000;
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
    const result = await this.claimForProcessing(id);
    return result.disposition === "claimed" ? result.work : undefined;
  }

  async claimForProcessing(id: string): Promise<AttachmentScanClaimDisposition> {
    const work = this.values.get(id);
    const claimedAt = this.now();
    const claimedAtIso = claimedAt.toISOString();
    if (!work || work.id !== id || work.expiresAt <= claimedAtIso) {
      this.values.delete(id);
      return { disposition: "missing" };
    }
    if (work.status === "completed" || work.status === "failed") {
      await this.reconcileTerminalJobUpdate(work);
      return { disposition: "terminal", terminalStatus: work.status };
    }
    if (work.status === "publishing") {
      if (work.publishingExpiresAt && work.publishingExpiresAt <= claimedAtIso) {
        const failed: AttachmentScanWork = {
          ...work,
          status: "failed",
          failureCode: "publication_abandoned",
          claimId: undefined,
          claimExpiresAt: undefined,
          pendingJobUpdate: {
            status: "failed",
            error: "publication_abandoned"
          },
          completedAt: claimedAtIso
        };
        this.values.set(id, failed);
        await this.reconcileTerminalJobUpdate(failed);
        return { disposition: "terminal", terminalStatus: "failed" };
      }
      return { disposition: "active" };
    }
    const claimable =
      work.status === "queued" ||
      (work.status === "claimed" &&
        Boolean(work.claimExpiresAt) &&
        work.claimExpiresAt! <= claimedAtIso);
    if (!claimable) {
      return { disposition: "active" };
    }
    const claimed: AttachmentScanWork = {
      ...work,
      status: "claimed",
      claimedAt: claimedAtIso,
      claimId: this.claimIdFactory(),
      claimExpiresAt: new Date(claimedAt.getTime() + this.claimLeaseMs).toISOString(),
      publishingAt: undefined,
      publishingExpiresAt: undefined
    };
    this.values.set(id, claimed);
    return { disposition: "claimed", work: cloneWork(claimed) };
  }

  async beginPublishing(id: string, claimId: string, publicationDeadline?: Date): Promise<boolean> {
    const work = this.values.get(id);
    const publishingAt = this.now();
    const publishingAtIso = publishingAt.toISOString();
    if (
      !work ||
      work.status !== "claimed" ||
      work.claimId !== claimId ||
      !work.claimExpiresAt ||
      work.claimExpiresAt <= publishingAtIso ||
      work.expiresAt <= publishingAtIso
    ) {
      return false;
    }
    const publishingExpiresAt = boundedExpiry(
      publishingAt,
      this.publishingLeaseMs,
      work.expiresAt,
      publicationDeadline
    );
    if (publishingExpiresAt <= publishingAtIso) return false;
    this.values.set(id, {
      ...work,
      status: "publishing",
      claimExpiresAt: undefined,
      publishingAt: publishingAtIso,
      publishingExpiresAt
    });
    return true;
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
    const work = this.transitionTerminal(id, claimId, "completed", "complete", {
      status: "completed",
      result
    });
    if (!work) return false;
    await this.reconcileTerminalJobUpdate(work);
    return true;
  }

  async fail(id: string, claimId: string, code: AttachmentScanFailureCode): Promise<boolean> {
    const work = this.transitionTerminal(
      id,
      claimId,
      "failed",
      "fail",
      { status: "failed", error: code },
      code
    );
    if (!work) return false;
    await this.reconcileTerminalJobUpdate(work);
    return true;
  }

  private transitionTerminal(
    id: string,
    claimId: string,
    status: "completed" | "failed",
    operation: "complete" | "fail",
    pendingJobUpdate: NonNullable<AttachmentScanWork["pendingJobUpdate"]>,
    code?: AttachmentScanFailureCode
  ): AttachmentScanWork | undefined {
    const work = this.values.get(id);
    const completedAt = this.now().toISOString();
    const liveClaim =
      work?.status === "claimed" &&
      operation === "fail" &&
      Boolean(work.claimExpiresAt) &&
      work.claimExpiresAt! > completedAt;
    const livePublication =
      work?.status === "publishing" &&
      Boolean(work.publishingExpiresAt) &&
      work.publishingExpiresAt! > completedAt;
    if (
      !work ||
      work.claimId !== claimId ||
      work.expiresAt <= completedAt ||
      (!liveClaim && !livePublication)
    ) {
      return undefined;
    }
    const terminal: AttachmentScanWork = {
      ...work,
      status,
      ...(code ? { failureCode: code } : {}),
      claimId: undefined,
      claimExpiresAt: undefined,
      pendingJobUpdate,
      completedAt
    };
    this.values.set(id, terminal);
    return terminal;
  }

  private async reconcileTerminalJobUpdate(work: AttachmentScanWork): Promise<void> {
    const pending = work.pendingJobUpdate;
    if (!pending) return;
    if (pending.status === "completed") {
      await this.options.jobStore.complete(work.jobId, pending.result);
    } else {
      await this.options.jobStore.fail(work.jobId, pending.error);
    }
    const current = this.values.get(work.id);
    if (
      current &&
      (current.status === "completed" || current.status === "failed") &&
      current.pendingJobUpdate
    ) {
      this.values.set(work.id, { ...current, pendingJobUpdate: undefined });
    }
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
  private readonly publishingLeaseMs: number;

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
    this.publishingLeaseMs = options.publishingLeaseMs ?? 15 * 60 * 1000;
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
    const result = await this.claimForProcessing(id);
    return result.disposition === "claimed" ? result.work : undefined;
  }

  async claimForProcessing(id: string): Promise<AttachmentScanClaimDisposition> {
    const claimedAtDate = this.now();
    const claimedAt = claimedAtDate.toISOString();
    const raw = await this.options.client.eval(claimScript, {
      keys: [this.key(id), this.pendingIndexKey()],
      arguments: [
        id,
        claimedAt,
        claimedAt,
        this.claimIdFactory(),
        new Date(claimedAtDate.getTime() + this.claimLeaseMs).toISOString()
      ]
    });
    if (typeof raw !== "string" || raw === "missing") {
      return { disposition: "missing" };
    }
    if (raw === "active") {
      return { disposition: "active" };
    }
    if (raw.startsWith("terminal:")) {
      const terminal = parseWork(raw.slice("terminal:".length), id);
      if (!terminal || (terminal.status !== "completed" && terminal.status !== "failed")) {
        return { disposition: "missing" };
      }
      await this.reconcileTerminalJobUpdate(terminal);
      return {
        disposition: "terminal",
        terminalStatus: terminal.status
      };
    }
    if (raw.startsWith("abandoned:")) {
      const abandoned = parseWork(raw.slice("abandoned:".length), id);
      if (!abandoned || abandoned.status !== "failed") {
        return { disposition: "missing" };
      }
      await this.reconcileTerminalJobUpdate(abandoned);
      return { disposition: "terminal", terminalStatus: "failed" };
    }
    const work = parseWork(raw, id);
    return work?.status === "claimed"
      ? { disposition: "claimed", work }
      : { disposition: "missing" };
  }

  async beginPublishing(id: string, claimId: string, publicationDeadline?: Date): Promise<boolean> {
    const publishingAt = this.now();
    const work = await this.read(id);
    if (!work) return false;
    const raw = await this.options.client.eval(beginPublishingScript, {
      keys: [this.key(id)],
      arguments: [
        id,
        claimId,
        publishingAt.toISOString(),
        boundedExpiry(publishingAt, this.publishingLeaseMs, work.expiresAt, publicationDeadline)
      ]
    });
    return typeof raw === "string" && parseWork(raw, id)?.status === "publishing";
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
    const work = await this.transitionTerminal(id, claimId, "completed", "complete", {
      status: "completed",
      result
    });
    if (!work) return false;
    await this.reconcileTerminalJobUpdate(work);
    return true;
  }

  async fail(id: string, claimId: string, code: AttachmentScanFailureCode): Promise<boolean> {
    const work = await this.transitionTerminal(
      id,
      claimId,
      "failed",
      "fail",
      { status: "failed", error: code },
      code
    );
    if (!work) return false;
    await this.reconcileTerminalJobUpdate(work);
    return true;
  }

  private async transitionTerminal(
    id: string,
    claimId: string,
    status: "completed" | "failed",
    operation: "complete" | "fail",
    pendingJobUpdate: NonNullable<AttachmentScanWork["pendingJobUpdate"]>,
    code?: AttachmentScanFailureCode
  ): Promise<AttachmentScanWork | undefined> {
    const raw = await this.options.client.eval(terminalTransitionScript, {
      keys: [this.key(id), this.pendingIndexKey()],
      arguments: [
        id,
        claimId,
        operation,
        status,
        this.now().toISOString(),
        code ?? "",
        JSON.stringify(pendingJobUpdate)
      ]
    });
    if (typeof raw !== "string") return undefined;
    const terminal = parseWork(raw, id);
    return terminal?.status === status ? terminal : undefined;
  }

  private async reconcileTerminalJobUpdate(work: AttachmentScanWork): Promise<void> {
    const pending = work.pendingJobUpdate;
    if (!pending) return;
    if (pending.status === "completed") {
      await this.options.jobStore.complete(work.jobId, pending.result);
    } else {
      await this.options.jobStore.fail(work.jobId, pending.error);
    }
    await this.options.client.eval(clearPendingJobUpdateScript, {
      keys: [this.key(work.id)],
      arguments: [work.id]
    });
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
      (work.publishingAt !== undefined && !isTimestamp(work.publishingAt)) ||
      (work.publishingExpiresAt !== undefined && !isTimestamp(work.publishingExpiresAt)) ||
      (work.pendingJobUpdate !== undefined && !isPendingJobUpdate(work.pendingJobUpdate)) ||
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
      ...(work.publishingAt ? { publishingAt: work.publishingAt } : {}),
      ...(work.publishingExpiresAt ? { publishingExpiresAt: work.publishingExpiresAt } : {}),
      ...(work.pendingJobUpdate
        ? { pendingJobUpdate: clonePendingJobUpdate(work.pendingJobUpdate) }
        : {}),
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
    value === "publishing" ||
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
    value === "publication_abandoned" ||
    value === "worker_failed"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPendingJobUpdate(
  value: unknown
): value is NonNullable<AttachmentScanWork["pendingJobUpdate"]> {
  if (!value || typeof value !== "object") return false;
  const pending = value as {
    status?: unknown;
    result?: Partial<FunctionExecutionResult>;
    error?: unknown;
  };
  if (pending.status === "failed") {
    return isFailureCode(pending.error);
  }
  return (
    pending.status === "completed" &&
    Boolean(pending.result) &&
    typeof pending.result?.ok === "boolean" &&
    typeof pending.result.replyText === "string"
  );
}

function clonePendingJobUpdate(
  pending: NonNullable<AttachmentScanWork["pendingJobUpdate"]>
): NonNullable<AttachmentScanWork["pendingJobUpdate"]> {
  return pending.status === "completed"
    ? { status: "completed", result: structuredClone(pending.result) }
    : { status: "failed", error: pending.error };
}

function cloneWork(work: AttachmentScanWork): AttachmentScanWork {
  return {
    ...work,
    scope: { ...work.scope },
    target: { ...work.target },
    ...(work.pendingJobUpdate
      ? { pendingJobUpdate: clonePendingJobUpdate(work.pendingJobUpdate) }
      : {})
  };
}

function boundedExpiry(
  start: Date,
  leaseMs: number,
  workExpiresAt: string,
  publicationDeadline?: Date
): string {
  return new Date(
    Math.min(
      start.getTime() + leaseMs,
      new Date(workExpiresAt).getTime(),
      publicationDeadline?.getTime() ?? Number.POSITIVE_INFINITY
    )
  ).toISOString();
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
