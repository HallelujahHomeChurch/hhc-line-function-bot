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
  clear?(scope: ConversationWindowScope): Promise<void>;
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
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class InMemoryConversationWindowStore implements ConversationWindowStore {
  private readonly records = new Map<string, ConversationWindowRecord>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async clear(scope: ConversationWindowScope): Promise<void> {
    this.records.delete(conversationScopeKey(scope));
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

  async clear(scope: ConversationWindowScope): Promise<void> {
    await this.options.client.setEx(
      this.key(scope),
      1,
      JSON.stringify({ expiresAt: this.now().toISOString(), turns: [] })
    );
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
      turns: appendTurn(undefined, input.role, input.text, now)
    };
    if (this.options.client.eval) {
      await this.options.client.eval(RECORD_CONVERSATION_TURN, {
        keys: [this.key(input.scope)],
        arguments: [JSON.stringify(record), String(input.ttlMs), now.toISOString()]
      });
      return;
    }
    // shortcut: eval-less test adapters are single-process; production clients must provide eval.
    record.turns = appendTurn(await this.liveRecord(input.scope), input.role, input.text, now);
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

const RECORD_CONVERSATION_TURN = `
local record=cjson.decode(ARGV[1])
local ttl=tonumber(ARGV[2])
local raw=redis.call('GET',KEYS[1])
if raw then
  local current=cjson.decode(raw)
  if current.expiresAt > ARGV[3] then
    if current.expiresAt > record.expiresAt then record.expiresAt=current.expiresAt end
    ttl=math.max(ttl,redis.call('PTTL',KEYS[1]))
    table.insert(current.turns,record.turns[1])
    while #current.turns > 8 do table.remove(current.turns,1) end
    record.turns=current.turns
  end
end
redis.call('PSETEX',KEYS[1],math.max(1,ttl),cjson.encode(record))
return 1
`;

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
