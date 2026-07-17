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
  arguments?: JsonRecord;
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
  stage?: "awaiting_opt_in" | "awaiting_purpose" | "awaiting_title" | "awaiting_confirmation";
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  attachment: {
    messageId: string;
    messageType: "image" | "file";
    fileName?: string;
    fileSize?: number;
  };
  destination?: {
    sourceKey: string;
    itemKind: string;
    domain: string;
  };
  target?: {
    sourceKey: string;
    itemKind: string;
    domain: string;
    title: string;
    declaredFileName?: string;
  };
  expiresAt: string;
}

export interface UploadIntentSession {
  id: string;
  type: "upload_intent";
  profileName: string;
  requesterUserId: string;
  source: LineSource;
  expiresAt: string;
}

export interface PendingResolutionSession {
  id: string;
  type: "pending_resolution";
  profileName: string;
  requesterUserId: string;
  source: LineSource;
  capability: FunctionName;
  groundedArguments: JsonRecord;
  candidates: Array<{ id: string; domainKey: string; displayName: string }>;
  expiresAt: string;
}

export interface PendingCapabilityResolutionSession {
  id: string;
  type: "pending_capability_resolution";
  version: 1;
  profileName: string;
  requesterUserId: string;
  source: LineSource;
  originalText: string;
  candidates: Array<{ capability: FunctionName; label: string }>;
  expiresAt: string;
}

export interface ExternalSearchConsentSession {
  id: string;
  type: "external_search_consent";
  action: string;
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  query: string;
  arguments?: JsonRecord;
  expiresAt: string;
}

export interface ExternalSheetMusicImportSession {
  id: string;
  type: "external_sheet_music_import";
  stage: "selecting" | "awaiting_target" | "awaiting_confirmation";
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  query: string;
  requestedKind?: "pop_sheet" | "hymn_sheet";
  items: Array<{ title: string; url: string; snippet?: string }>;
  selectedIndex?: number;
  targetKind?: "pop_sheet" | "hymn_sheet";
  expiresAt: string;
}

export type ConversationSession =
  | PptSelectionSession
  | SelectionSession
  | PendingFunctionSession
  | PendingAttachmentSession
  | UploadIntentSession
  | PendingResolutionSession
  | PendingCapabilityResolutionSession
  | ExternalSearchConsentSession
  | ExternalSheetMusicImportSession;
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

export interface ExternalSearchConsentLookup extends PptSelectionLookup {
  action: string;
}

export interface SessionStore {
  get(id: string): Promise<ConversationSession | undefined>;
  set(session: ConversationSession): Promise<void>;
  delete(id: string): Promise<void>;
  findPptSelection(lookup: PptSelectionLookup): Promise<PptSelectionSession | undefined>;
  findSelection(lookup: SelectionLookup): Promise<SelectionSession | undefined>;
  findPendingFunction(lookup: PendingFunctionLookup): Promise<PendingFunctionSession | undefined>;
  findPendingAttachment(lookup: PptSelectionLookup): Promise<PendingAttachmentSession | undefined>;
  takePendingAttachment(lookup: PptSelectionLookup): Promise<PendingAttachmentSession | undefined>;
  findPendingResolution(lookup: PptSelectionLookup): Promise<PendingResolutionSession | undefined>;
  findPendingCapabilityResolution(
    lookup: PptSelectionLookup
  ): Promise<PendingCapabilityResolutionSession | undefined>;
  takeUploadIntent(lookup: PptSelectionLookup): Promise<UploadIntentSession | undefined>;
  findExternalSearchConsent(
    lookup: ExternalSearchConsentLookup
  ): Promise<ExternalSearchConsentSession | undefined>;
  findExternalSheetMusicImport(
    lookup: PptSelectionLookup
  ): Promise<ExternalSheetMusicImportSession | undefined>;
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

  async takePendingAttachment(
    lookup: PptSelectionLookup
  ): Promise<PendingAttachmentSession | undefined> {
    const session = Array.from(this.sessions.values())
      .map((candidate) => this.liveSession(candidate))
      .filter(
        (candidate): candidate is PendingAttachmentSession =>
          candidate?.type === "pending_attachment"
      )
      .filter((candidate) => candidate.profileName === lookup.profileName)
      .filter((candidate) => sourceMatches(candidate.source, lookup.source))
      .filter((candidate) =>
        requesterMatchesForSource(lookup.source, candidate.requesterUserId, lookup.requesterUserId)
      )
      .sort(
        (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
      )[0];
    if (session) this.sessions.delete(session.id);
    return session;
  }

  async findPendingResolution(
    lookup: PptSelectionLookup
  ): Promise<PendingResolutionSession | undefined> {
    return Array.from(this.sessions.values())
      .map((candidate) => this.liveSession(candidate))
      .filter(
        (candidate): candidate is PendingResolutionSession =>
          candidate?.type === "pending_resolution"
      )
      .filter((candidate) => candidate.profileName === lookup.profileName)
      .filter((candidate) => sourceMatches(candidate.source, lookup.source))
      .filter((candidate) =>
        requesterMatchesForSource(lookup.source, candidate.requesterUserId, lookup.requesterUserId)
      )
      .sort(
        (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
      )[0];
  }

  async findPendingCapabilityResolution(
    lookup: PptSelectionLookup
  ): Promise<PendingCapabilityResolutionSession | undefined> {
    return Array.from(this.sessions.values())
      .map((candidate) => this.liveSession(candidate))
      .filter(
        (candidate): candidate is PendingCapabilityResolutionSession =>
          candidate?.type === "pending_capability_resolution"
      )
      .filter((candidate) => candidate.profileName === lookup.profileName)
      .filter((candidate) => sourceMatches(candidate.source, lookup.source))
      .filter((candidate) =>
        requesterMatchesForSource(lookup.source, candidate.requesterUserId, lookup.requesterUserId)
      )
      .sort(
        (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
      )[0];
  }

  async takeUploadIntent(lookup: PptSelectionLookup): Promise<UploadIntentSession | undefined> {
    const session = Array.from(this.sessions.values())
      .map((candidate) => this.liveSession(candidate))
      .filter((candidate): candidate is UploadIntentSession => candidate?.type === "upload_intent")
      .filter((candidate) => candidate.profileName === lookup.profileName)
      .filter((candidate) => sourceMatches(candidate.source, lookup.source))
      .filter((candidate) =>
        requesterMatchesForSource(lookup.source, candidate.requesterUserId, lookup.requesterUserId)
      )
      .sort(
        (left, right) => new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime()
      )[0];
    if (session) this.sessions.delete(session.id);
    return session;
  }

  async findExternalSearchConsent(
    lookup: ExternalSearchConsentLookup
  ): Promise<ExternalSearchConsentSession | undefined> {
    const liveSessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter((session): session is ExternalSearchConsentSession => Boolean(session))
      .filter((session) => session.type === "external_search_consent")
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

  async findExternalSheetMusicImport(
    lookup: PptSelectionLookup
  ): Promise<ExternalSheetMusicImportSession | undefined> {
    const sessions = Array.from(this.sessions.values())
      .map((session) => this.liveSession(session))
      .filter(
        (session): session is ExternalSheetMusicImportSession =>
          session?.type === "external_sheet_music_import"
      )
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );
    return sessions.sort(
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
    if (isInteractiveSession(session)) {
      for (const existing of this.sessions.values()) {
        if (
          existing.id !== session.id &&
          isInteractiveSession(existing) &&
          existing.profileName === session.profileName &&
          sourceMatches(existing.source, session.source) &&
          requesterMatchesForSource(
            session.source,
            existing.requesterUserId,
            session.requesterUserId
          )
        ) {
          this.sessions.delete(existing.id);
        }
      }
    }
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

function isInteractiveSession(session: ConversationSession): boolean {
  return [
    "pending_function",
    "pending_resolution",
    "pending_capability_resolution",
    "pending_attachment",
    "upload_intent"
  ].includes(session.type);
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
