import type {
  AgentResourceReference,
  DriveItem,
  FunctionName,
  JsonRecord,
  LineSource
} from "../types.js";
import { requesterMatchesForSource } from "./session-safety.js";

export type SelectionItem = Pick<DriveItem, "id" | "name" | "driveId"> & {
  memoryResource?: AgentResourceReference;
};

export interface PptSelectionSession {
  id: string;
  type: "ppt_selection";
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  driveId: string;
  items: SelectionItem[];
  expiresAt: string;
}

export interface SelectionSession {
  id: string;
  type: "selection";
  action: string;
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  items: SelectionItem[];
  expiresAt: string;
}

export interface PendingFunctionSession {
  id: string;
  type: "pending_function";
  action: FunctionName;
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  arguments: JsonRecord;
  expiresAt: string;
}

export interface PendingAttachmentSession {
  id: string;
  type: "pending_attachment";
  action: "save_resource";
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  attachment: {
    messageId: string;
    messageType: "image" | "file";
    fileName?: string;
    fileSize?: number;
  };
  expiresAt: string;
}

export type ConversationSession =
  PptSelectionSession | SelectionSession | PendingFunctionSession | PendingAttachmentSession;
export type ConversationSessionType = ConversationSession["type"];

export interface SessionStoreSummary {
  total: number;
  byType: Partial<Record<ConversationSessionType, number>>;
}

export interface PptSelectionLookup {
  profileName: string;
  source: LineSource;
  requesterUserId?: string;
}

export interface SelectionLookup extends PptSelectionLookup {
  action: string;
}

export interface PendingFunctionLookup extends PptSelectionLookup {
  action?: FunctionName;
}

export interface SessionStore {
  get(id: string): Promise<ConversationSession | undefined>;
  set(session: ConversationSession): Promise<void>;
  delete(id: string): Promise<void>;
  findPptSelection(lookup: PptSelectionLookup): Promise<PptSelectionSession | undefined>;
  findSelection(lookup: SelectionLookup): Promise<SelectionSession | undefined>;
  findPendingFunction(lookup: PendingFunctionLookup): Promise<PendingFunctionSession | undefined>;
  findPendingAttachment(lookup: PptSelectionLookup): Promise<PendingAttachmentSession | undefined>;
  summary(): Promise<SessionStoreSummary>;
  clear(): Promise<number>;
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

  async get(id: string): Promise<ConversationSession | undefined> {
    const session = this.sessions.get(id);
    return this.liveSession(session);
  }

  async findPptSelection(lookup: PptSelectionLookup): Promise<PptSelectionSession | undefined> {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is PptSelectionSession => Boolean(session))
      .filter((session) => session.type === "ppt_selection")
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return liveSessions.sort(
      (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
    )[0];
  }

  async findSelection(lookup: SelectionLookup): Promise<SelectionSession | undefined> {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is SelectionSession => Boolean(session))
      .filter((session) => session.type === "selection")
      .filter((session) => session.action === lookup.action)
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return liveSessions.sort(
      (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
    )[0];
  }

  async findPendingFunction(
    lookup: PendingFunctionLookup
  ): Promise<PendingFunctionSession | undefined> {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is PendingFunctionSession => Boolean(session))
      .filter((session) => session.type === "pending_function")
      .filter((session) => !lookup.action || session.action === lookup.action)
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return liveSessions.sort(
      (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
    )[0];
  }

  async findPendingAttachment(
    lookup: PptSelectionLookup
  ): Promise<PendingAttachmentSession | undefined> {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is PendingAttachmentSession => Boolean(session))
      .filter((session) => session.type === "pending_attachment")
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
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

  async set(session: ConversationSession): Promise<void> {
    this.sessions.set(session.id, {
      ...session,
      expiresAt: session.expiresAt || new Date(this.now().getTime() + this.ttlMs).toISOString()
    });
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async summary(): Promise<SessionStoreSummary> {
    const byType: SessionStoreSummary["byType"] = {};
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is ConversationSession => Boolean(session));

    for (const session of liveSessions) {
      byType[session.type] = (byType[session.type] ?? 0) + 1;
    }

    return {
      total: liveSessions.length,
      byType
    };
  }

  async clear(): Promise<number> {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
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
