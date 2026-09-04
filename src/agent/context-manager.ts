export interface ConversationWindowScope {
  profileName: string;
  sourceKey: string;
  requesterUserId?: string;
}

type ConversationTurnRole = "user" | "assistant";

interface ConversationWindowTurn {
  role: ConversationTurnRole;
  text: string;
  createdAt: string;
}

interface ConversationWindowRecord {
  expiresAt: string;
  turns: ConversationWindowTurn[];
}

export interface ConversationWindowStore {
  isActive(scope: ConversationWindowScope): Promise<boolean>;
  recordTurn(input: {
    scope: ConversationWindowScope;
    role: ConversationTurnRole;
    text: string;
    ttlMs: number;
  }): Promise<void>;
  recentTurns(scope: ConversationWindowScope, limit: number): Promise<string[]>;
}

export interface RedisConversationWindowClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
}

export class InMemoryConversationWindowStore implements ConversationWindowStore {
  private readonly records = new Map<string, ConversationWindowRecord>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async isActive(scope: ConversationWindowScope): Promise<boolean> {
    return Boolean(this.liveRecord(scope));
  }

  async recordTurn(input: {
    scope: ConversationWindowScope;
    role: ConversationTurnRole;
    text: string;
    ttlMs: number;
  }): Promise<void> {
    const now = this.now();
    this.records.set(conversationScopeKey(input.scope), {
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      turns: appendTurn(this.liveRecord(input.scope), input.role, input.text, now)
    });
  }

  async recentTurns(scope: ConversationWindowScope, limit: number): Promise<string[]> {
    return formatTurns(this.liveRecord(scope), limit);
  }

  private liveRecord(scope: ConversationWindowScope): ConversationWindowRecord | undefined {
    const key = conversationScopeKey(scope);
    const record = this.records.get(key);
    if (record && Date.parse(record.expiresAt) > this.now().getTime()) return record;
    this.records.delete(key);
    return undefined;
  }
}

export class RedisConversationWindowStore implements ConversationWindowStore {
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      client: RedisConversationWindowClient;
      keyPrefix: string;
      now?: () => Date;
    }
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async isActive(scope: ConversationWindowScope): Promise<boolean> {
    return Boolean(await this.liveRecord(scope));
  }

  async recordTurn(input: {
    scope: ConversationWindowScope;
    role: ConversationTurnRole;
    text: string;
    ttlMs: number;
  }): Promise<void> {
    const now = this.now();
    const record: ConversationWindowRecord = {
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      turns: appendTurn(await this.liveRecord(input.scope), input.role, input.text, now)
    };
    await this.options.client.setEx(
      this.key(input.scope),
      Math.max(1, Math.ceil(input.ttlMs / 1000)),
      JSON.stringify(record)
    );
  }

  async recentTurns(scope: ConversationWindowScope, limit: number): Promise<string[]> {
    return formatTurns(await this.liveRecord(scope), limit);
  }

  private async liveRecord(
    scope: ConversationWindowScope
  ): Promise<ConversationWindowRecord | undefined> {
    const raw = await this.options.client.get(this.key(scope));
    if (!raw) return undefined;
    const record = JSON.parse(raw) as ConversationWindowRecord;
    return Date.parse(record.expiresAt) > this.now().getTime() ? record : undefined;
  }

  private key(scope: ConversationWindowScope): string {
    return `${this.options.keyPrefix}:conversation-window:${conversationScopeKey(scope)}`;
  }
}

function appendTurn(
  record: ConversationWindowRecord | undefined,
  role: ConversationTurnRole,
  text: string,
  now: Date
): ConversationWindowTurn[] {
  return [
    ...(record?.turns ?? []),
    { role, text: text.replace(/\s+/gu, " ").trim().slice(0, 1_000), createdAt: now.toISOString() }
  ].slice(-8);
}

function formatTurns(record: ConversationWindowRecord | undefined, limit: number): string[] {
  return (record?.turns ?? [])
    .slice(-Math.max(0, limit))
    .map((turn) => `${turn.role}: ${turn.text}`);
}

function conversationScopeKey(scope: ConversationWindowScope): string {
  return [scope.profileName, scope.sourceKey, scope.requesterUserId ?? "anonymous"]
    .map((part) => encodeURIComponent(part))
    .join(":");
}
