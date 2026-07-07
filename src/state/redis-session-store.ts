import type {
  ConversationSession,
  PendingFunctionLookup,
  PendingFunctionSession,
  PptSelectionLookup,
  PptSelectionSession,
  SelectionLookup,
  SelectionSession,
  SessionStore,
  SessionStoreSummary
} from "./session-store.js";
import type { LineSource } from "../types.js";
import { requesterMatchesForSource } from "./session-safety.js";

export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export interface RedisSessionStoreOptions {
  client: RedisSessionClient;
  keyPrefix: string;
  now?: () => Date;
}

export class RedisSessionStore implements SessionStore {
  private readonly now: () => Date;

  constructor(private readonly options: RedisSessionStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async get(id: string): Promise<ConversationSession | undefined> {
    const session = await this.readSession(this.key(id));
    return this.liveSession(session);
  }

  async set(session: ConversationSession): Promise<void> {
    const ttlMs = new Date(session.expiresAt).getTime() - this.now().getTime();
    await this.options.client.setEx(
      this.key(session.id),
      ttlSeconds(ttlMs),
      JSON.stringify(session)
    );
  }

  async delete(id: string): Promise<void> {
    await this.options.client.del(this.key(id));
  }

  async findPptSelection(lookup: PptSelectionLookup): Promise<PptSelectionSession | undefined> {
    const liveSessions = (await this.liveSessions())
      .filter((session): session is PptSelectionSession => session.type === "ppt_selection")
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return latestSession(liveSessions);
  }

  async findSelection(lookup: SelectionLookup): Promise<SelectionSession | undefined> {
    const liveSessions = (await this.liveSessions())
      .filter((session): session is SelectionSession => session.type === "selection")
      .filter((session) => session.action === lookup.action)
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return latestSession(liveSessions);
  }

  async findPendingFunction(
    lookup: PendingFunctionLookup
  ): Promise<PendingFunctionSession | undefined> {
    const liveSessions = (await this.liveSessions())
      .filter((session): session is PendingFunctionSession => session.type === "pending_function")
      .filter((session) => !lookup.action || session.action === lookup.action)
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return latestSession(liveSessions);
  }

  async summary(): Promise<SessionStoreSummary> {
    const byType: SessionStoreSummary["byType"] = {};
    const sessions = await this.liveSessions();
    for (const session of sessions) {
      byType[session.type] = (byType[session.type] ?? 0) + 1;
    }
    return { total: sessions.length, byType };
  }

  async clear(): Promise<number> {
    const keys = await this.options.client.keys(this.key("*"));
    if (keys.length === 0) {
      return 0;
    }
    return this.options.client.del(keys);
  }

  private async liveSessions(): Promise<ConversationSession[]> {
    const keys = await this.options.client.keys(this.key("*"));
    const sessions = await Promise.all(keys.map((key) => this.readSession(key)));
    return sessions
      .map((session) => this.liveSession(session))
      .filter((session): session is ConversationSession => Boolean(session));
  }

  private async readSession(key: string): Promise<ConversationSession | undefined> {
    const raw = await this.options.client.get(key);
    if (!raw) {
      return undefined;
    }
    return JSON.parse(raw) as ConversationSession;
  }

  private liveSession(session: ConversationSession | undefined): ConversationSession | undefined {
    if (!session) {
      return undefined;
    }
    return new Date(session.expiresAt).getTime() > this.now().getTime() ? session : undefined;
  }

  private key(idOrPattern: string): string {
    return `${this.options.keyPrefix}:session:${idOrPattern}`;
  }
}

function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function latestSession<T extends ConversationSession>(sessions: T[]): T | undefined {
  return sessions.sort(
    (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
  )[0];
}

function sourceMatches(expected: LineSource, actual: LineSource): boolean {
  if (expected.type !== actual.type) {
    return false;
  }
  switch (expected.type) {
    case "group":
      return expected.groupId === actual.groupId;
    case "room":
      return expected.roomId === actual.roomId;
    case "user":
      return expected.userId === actual.userId;
    default:
      return false;
  }
}
