import type { DriveItem, LineSource } from "../types.js";

export interface PptSelectionSession {
  id: string;
  type: "ppt_selection";
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  driveId: string;
  items: Array<Pick<DriveItem, "id" | "name">>;
  expiresAt: string;
}

export interface SelectionSession {
  id: string;
  type: "selection";
  action: string;
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  items: Array<Pick<DriveItem, "id" | "name" | "driveId">>;
  expiresAt: string;
}

export type ConversationSession = PptSelectionSession | SelectionSession;

export interface PptSelectionLookup {
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
}

export interface SelectionLookup extends PptSelectionLookup {
  action: string;
}

export interface SessionStore {
  get(id: string): ConversationSession | undefined;
  set(session: ConversationSession): void;
  delete(id: string): void;
  findPptSelection(lookup: PptSelectionLookup): PptSelectionSession | undefined;
  findSelection(lookup: SelectionLookup): SelectionSession | undefined;
}

export interface InMemorySessionStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  }

  get(id: string): ConversationSession | undefined {
    const session = this.sessions.get(id);
    return this.liveSession(session);
  }

  findPptSelection(lookup: PptSelectionLookup): PptSelectionSession | undefined {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is PptSelectionSession => Boolean(session))
      .filter((session) => session.type === "ppt_selection")
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter(
        (session) =>
          !session.requesterUserId ||
          !lookup.requesterUserId ||
          session.requesterUserId === lookup.requesterUserId
      );

    return liveSessions.sort(
      (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
    )[0];
  }

  findSelection(lookup: SelectionLookup): SelectionSession | undefined {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is SelectionSession => Boolean(session))
      .filter((session) => session.type === "selection")
      .filter((session) => session.action === lookup.action)
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter(
        (session) =>
          !session.requesterUserId ||
          !lookup.requesterUserId ||
          session.requesterUserId === lookup.requesterUserId
      );

    return liveSessions.sort(
      (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
    )[0];
  }

  private liveSession(session: ConversationSession | undefined): ConversationSession | undefined {
    if (!session) {
      return undefined;
    }
    if (new Date(session.expiresAt).getTime() <= this.now().getTime()) {
      this.sessions.delete(session.id);
      return undefined;
    }
    return session;
  }

  set(session: ConversationSession): void {
    this.sessions.set(session.id, {
      ...session,
      expiresAt: session.expiresAt || new Date(this.now().getTime() + this.ttlMs).toISOString()
    });
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
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
