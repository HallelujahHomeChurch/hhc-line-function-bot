import { randomUUID } from "node:crypto";

import { buildPostbackQuickReply } from "../line-reply.js";
import type { FunctionExecutionResult, LineSource, QuickReplyItem } from "../types.js";

export interface AgentJobScope {
  profileName: string;
  sourceKey: string;
  requesterUserId?: string;
}

export type AgentJobStatus = "pending" | "completed" | "failed";

export interface AgentJobRecord {
  id: string;
  scope: AgentJobScope;
  label: string;
  status: AgentJobStatus;
  result?: FunctionExecutionResult;
  error?: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreatePendingAgentJobInput {
  scope: AgentJobScope;
  label: string;
  ttlMs: number;
}

export interface AgentJobStore {
  createPending(input: CreatePendingAgentJobInput): Promise<AgentJobRecord>;
  complete(id: string, result: FunctionExecutionResult): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  get(id: string, scope: AgentJobScope): Promise<AgentJobRecord | undefined>;
}

export interface RedisAgentJobClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
}

export class InMemoryAgentJobStore implements AgentJobStore {
  private readonly jobs = new Map<string, AgentJobRecord>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createPending(input: CreatePendingAgentJobInput): Promise<AgentJobRecord> {
    const now = this.now();
    const record: AgentJobRecord = {
      id: randomUUID(),
      scope: { ...input.scope },
      label: input.label,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString()
    };
    this.jobs.set(record.id, record);
    return { ...record };
  }

  async complete(id: string, result: FunctionExecutionResult): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    this.jobs.set(id, { ...job, status: "completed", result });
  }

  async fail(id: string, error: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    this.jobs.set(id, { ...job, status: "failed", error });
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
    return { ...job };
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
      id: this.idFactory(),
      scope: { ...input.scope },
      label: input.label,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString()
    };
    await this.write(record);
    return { ...record };
  }

  async complete(id: string, result: FunctionExecutionResult): Promise<void> {
    const record = await this.readById(id);
    if (!record) {
      return;
    }
    await this.write({ ...record, status: "completed", result });
  }

  async fail(id: string, error: string): Promise<void> {
    const record = await this.readById(id);
    if (!record) {
      return;
    }
    await this.write({ ...record, status: "failed", error });
  }

  async get(id: string, scope: AgentJobScope): Promise<AgentJobRecord | undefined> {
    const record = await this.readById(id);
    if (!record || !scopeMatches(record.scope, scope)) {
      return undefined;
    }
    if (new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      return undefined;
    }
    return { ...record };
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
