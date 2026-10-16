import type { QuoteToken } from "../quotes/types.js";
import type { CapabilityName } from "../capabilities/names.js";
import { randomUUID } from "node:crypto";

import { buildPostbackQuickReply } from "../line-reply.js";
import type { FunctionExecutionResult, LineSource, QuickReplyItem } from "../types.js";

export interface AgentJobScope {
  profileName: string;
  sourceKey: string;
  requesterUserId?: string;
}

export type AgentJobStatus = "pending" | "completed" | "failed" | "uncertain";

export interface AgentJobRecord {
  contextToken?: QuoteToken;
  id: string;
  scope: AgentJobScope;
  capability?: CapabilityName;
  label: string;
  status: AgentJobStatus;
  result?: FunctionExecutionResult;
  error?: string;
  executionStartedAt?: string;
  executionLeaseUntil?: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreatePendingAgentJobInput {
  contextToken?: QuoteToken;
  id?: string;
  scope: AgentJobScope;
  capability?: CapabilityName;
  label: string;
  ttlMs: number;
}

export interface AgentJobStore {
  createPending(input: CreatePendingAgentJobInput): Promise<AgentJobRecord>;
  markStarted?(id: string, leaseMs: number): Promise<boolean>;
  renewExecution?(id: string, leaseMs: number): Promise<boolean>;
  complete(id: string, result: FunctionExecutionResult, capability?: CapabilityName): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  get(id: string, scope: AgentJobScope): Promise<AgentJobRecord | undefined>;
}

export interface RedisAgentJobClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const FAIL_PENDING_JOB_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local record = cjson.decode(value)
if record.status ~= 'pending' then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
record.status = ARGV[1] == 'execution_uncertain' and 'uncertain' or 'failed'
record.error = ARGV[1]
redis.call('PSETEX', KEYS[1], ttl, cjson.encode(record))
return 1
`;

export class InMemoryAgentJobStore implements AgentJobStore {
  private readonly jobs = new Map<string, AgentJobRecord>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createPending(input: CreatePendingAgentJobInput): Promise<AgentJobRecord> {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.expiresAt) <= now.getTime()) this.jobs.delete(id);
    }
    const record: AgentJobRecord = {
      id: input.id ?? randomUUID(),
      scope: { ...input.scope },
      contextToken: input.contextToken,
      capability: input.capability,
      label: input.label,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString()
    };
    const existing = this.jobs.get(record.id);
    if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
      if (!scopeMatches(existing.scope, input.scope)) throw new Error("agent_job_scope_conflict");
      return { ...existing };
    }
    this.jobs.set(record.id, record);
    return { ...record };
  }

  async markStarted(id: string, leaseMs: number): Promise<boolean> {
    const job = this.jobs.get(id);
    const now = this.now().getTime();
    if (
      !job ||
      job.status !== "pending" ||
      job.executionStartedAt ||
      Date.parse(job.expiresAt) <= now
    )
      return false;
    job.executionStartedAt = new Date(now).toISOString();
    job.executionLeaseUntil = new Date(now + leaseMs).toISOString();
    return true;
  }
  async renewExecution(id: string, leaseMs: number): Promise<boolean> {
    const job = this.jobs.get(id);
    const now = this.now().getTime();
    if (
      !job ||
      job.status !== "pending" ||
      !job.executionLeaseUntil ||
      Date.parse(job.executionLeaseUntil) <= now
    )
      return false;
    job.executionLeaseUntil = new Date(now + leaseMs).toISOString();
    return true;
  }

  async complete(
    id: string,
    result: FunctionExecutionResult,
    capability?: CapabilityName
  ): Promise<void> {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.status === "completed" ||
      job.status === "failed" ||
      Date.parse(job.expiresAt) <= this.now().getTime()
    ) {
      return;
    }
    this.jobs.set(id, {
      ...job,
      capability: capability ?? job.capability,
      status: "completed",
      result
    });
  }

  async fail(id: string, error: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "pending") {
      return;
    }
    this.jobs.set(id, {
      ...job,
      status: error === "execution_uncertain" ? "uncertain" : "failed",
      error
    });
  }

  async get(id: string, scope: AgentJobScope): Promise<AgentJobRecord | undefined> {
    const job = this.jobs.get(id);
    if (!job || !scopeMatches(job.scope, scope)) {
      return undefined;
    }
    if (new Date(job.expiresAt).getTime() <= this.now().getTime()) {
      this.jobs.delete(id);
      return undefined;
    }
    return projectJob(job, this.now());
  }
}

export class RedisAgentJobStore implements AgentJobStore {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly options: {
      client: RedisAgentJobClient;
      keyPrefix: string;
      now?: () => Date;
      idFactory?: () => string;
    }
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async createPending(input: CreatePendingAgentJobInput): Promise<AgentJobRecord> {
    const now = this.now();
    const record: AgentJobRecord = {
      id: input.id ?? this.idFactory(),
      scope: { ...input.scope },
      contextToken: input.contextToken,
      capability: input.capability,
      label: input.label,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString()
    };
    if (input.id) {
      if (!this.options.client.eval) throw new Error("agent_job_atomic_store_required");
      const raw = await this.options.client.eval(CREATE_JOB, {
        keys: [this.key(record.id)],
        arguments: [JSON.stringify(record), String(input.ttlMs)]
      });
      if (typeof raw !== "string") throw new Error("agent_job_invalid_record");
      const existing = JSON.parse(raw) as AgentJobRecord;
      if (!scopeMatches(existing.scope, input.scope)) throw new Error("agent_job_scope_conflict");
      return existing;
    }
    await this.write(record);
    return { ...record };
  }

  async markStarted(id: string, leaseMs: number): Promise<boolean> {
    return this.executionTransition(id, leaseMs, "start");
  }
  async renewExecution(id: string, leaseMs: number): Promise<boolean> {
    return this.executionTransition(id, leaseMs, "renew");
  }
  private async executionTransition(id: string, leaseMs: number, action: string): Promise<boolean> {
    if (!this.options.client.eval) throw new Error("agent_job_atomic_store_required");
    const now = this.now().getTime();
    return (
      (await this.options.client.eval(EXECUTION_JOB, {
        keys: [this.key(id)],
        arguments: [action, new Date(now).toISOString(), new Date(now + leaseMs).toISOString()]
      })) === 1
    );
  }

  async complete(
    id: string,
    result: FunctionExecutionResult,
    capability?: CapabilityName
  ): Promise<void> {
    const record = await this.readById(id);
    if (
      !record ||
      record.status === "completed" ||
      record.status === "failed" ||
      Date.parse(record.expiresAt) <= this.now().getTime()
    ) {
      return;
    }
    const completed = {
      ...record,
      capability: capability ?? record.capability,
      status: "completed" as const,
      result
    };
    if (this.options.client.eval) {
      await this.options.client.eval(COMPLETE_JOB, {
        keys: [this.key(id)],
        arguments: [JSON.stringify(completed)]
      });
    } else {
      if (record.executionStartedAt) throw new Error("agent_job_atomic_store_required");
      await this.write(completed);
    }
  }

  async fail(id: string, error: string): Promise<void> {
    if (!this.options.client.eval) return;
    await this.options.client.eval(FAIL_PENDING_JOB_SCRIPT, {
      keys: [this.key(id)],
      arguments: [boundedJobError(error)]
    });
  }

  async get(id: string, scope: AgentJobScope): Promise<AgentJobRecord | undefined> {
    const record = await this.readById(id);
    if (!record || !scopeMatches(record.scope, scope)) {
      return undefined;
    }
    if (new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      return undefined;
    }
    return projectJob(record, this.now());
  }

  private async readById(id: string): Promise<AgentJobRecord | undefined> {
    const raw = await this.options.client.get(this.key(id));
    if (!raw) {
      return undefined;
    }
    return JSON.parse(raw) as AgentJobRecord;
  }

  private async write(record: AgentJobRecord): Promise<void> {
    const ttlMs = new Date(record.expiresAt).getTime() - this.now().getTime();
    await this.options.client.setEx(
      this.key(record.id),
      Math.max(1, Math.ceil(ttlMs / 1000)),
      JSON.stringify(record)
    );
  }

  private key(id: string): string {
    return `${this.options.keyPrefix}:agent-job:${encodeURIComponent(id)}`;
  }
}

function boundedJobError(error: string): string {
  return (
    error
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .trim()
      .slice(0, 160) || "failed"
  );
}

export function scopeKey(scope: AgentJobScope): string {
  return `${scope.profileName}:${scope.sourceKey}:${scope.requesterUserId ?? ""}`;
}

export function scopeMatches(expected: AgentJobScope, actual: AgentJobScope): boolean {
  return (
    expected.profileName === actual.profileName &&
    expected.sourceKey === actual.sourceKey &&
    expected.requesterUserId === actual.requesterUserId
  );
}

export function buildAgentJobScope(
  profileName: string,
  source: LineSource
): (AgentJobScope & { requesterUserId: string }) | undefined {
  if (!source.userId) return undefined;
  const sourceKey = sourceKeyForJob(source);
  if (!sourceKey) return undefined;
  return {
    profileName,
    sourceKey,
    requesterUserId: source.userId
  };
}

export function buildAgentJobQuickReply(jobId: string): QuickReplyItem {
  return buildPostbackQuickReply(
    "查看結果",
    `action=agent_job_result&jobId=${encodeURIComponent(jobId)}`,
    "查看結果"
  );
}

function sourceKeyForJob(source: LineSource): string | undefined {
  switch (source.type) {
    case "group":
      return source.groupId ? `group:${source.groupId}` : undefined;
    case "room":
      return source.roomId ? `room:${source.roomId}` : undefined;
    case "user":
      return source.userId ? `user:${source.userId}` : undefined;
    default:
      return undefined;
  }
}

function projectJob(job: AgentJobRecord, now: Date): AgentJobRecord {
  return job.status === "pending" &&
    job.executionLeaseUntil &&
    Date.parse(job.executionLeaseUntil) <= now.getTime()
    ? { ...job, status: "uncertain", error: "execution_uncertain" }
    : { ...job };
}
const CREATE_JOB = `
local value = redis.call('GET', KEYS[1])
if value then return value end
redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
return ARGV[1]
`;
const EXECUTION_JOB = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or job.status ~= 'pending' then return 0 end
if ARGV[1] == 'start' then
  if job.executionStartedAt then return 0 end
  job.executionStartedAt = ARGV[2]
else
  if not job.executionLeaseUntil or job.executionLeaseUntil <= ARGV[2] then return 0 end
end
job.executionLeaseUntil = ARGV[3]
redis.call('PSETEX', KEYS[1], ttl, cjson.encode(job))
return 1
`;
const COMPLETE_JOB = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or job.status == 'completed' or job.status == 'failed' then return 0 end
redis.call('PSETEX', KEYS[1], ttl, ARGV[1])
return 1
`;
