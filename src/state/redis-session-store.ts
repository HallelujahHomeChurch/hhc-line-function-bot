import type {
  ActionReviewLookup,
  ActionReviewSession,
  ConversationSession,
  ExternalSearchConsentLookup,
  ExternalSearchConsentSession,
  ExternalSheetMusicImportSession,
  PendingAttachmentSession,
  PendingCapabilityResolutionSession,
  PendingFunctionLookup,
  PendingFunctionSession,
  PendingResolutionSession,
  PptSelectionLookup,
  PptSelectionSession,
  SelectionLookup,
  SelectionSession,
  SessionStore,
  SessionStoreSummary,
  UploadIntentPromotion,
  UploadIntentSession
} from "./session-store.js";
import type { LineSource } from "../types.js";
import { requesterMatchesForSource } from "./session-safety.js";

export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  getDel(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const REPLACE_INTERACTIVE_SESSION_SCRIPT = `
local previousId = redis.call('GET', KEYS[1])
if previousId and previousId ~= ARGV[3] then
  redis.call('DEL', ARGV[4] .. previousId)
end
redis.call('PSETEX', KEYS[2], ARGV[1], ARGV[2])
redis.call('PSETEX', KEYS[1], ARGV[1], ARGV[3])
return previousId
`;

const CONSUME_INDEXED_SESSION_SCRIPT = `
local value = redis.call('GETDEL', KEYS[2])
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return value
`;

const TAKE_ACTION_REVIEW_SCRIPT = `
local value = redis.call('GET', KEYS[2])
if not value then return nil end
local session = cjson.decode(value)
local source = session.source or {}
local function same(optional, expected)
  if optional == nil or optional == cjson.null then optional = '' end
  return optional == expected
end
if session.type ~= 'action_review'
  or session.id ~= ARGV[1]
  or session.profileName ~= ARGV[2]
  or session.requesterUserId ~= ARGV[3]
  or source.type ~= ARGV[4]
  or not same(source.userId, ARGV[5])
  or not same(source.groupId, ARGV[6])
  or not same(source.roomId, ARGV[7])
  or session.expiresAt <= ARGV[8] then
  return nil
end
redis.call('DEL', KEYS[2])
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then redis.call('DEL', KEYS[1]) end
return value
`;

const DELETE_INDEXED_SESSION_SCRIPT = `
redis.call('DEL', KEYS[2])
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return 1
`;

const PROMOTE_UPLOAD_INTENT_SCRIPT = `
local currentId = redis.call('GET', KEYS[1])
if currentId == ARGV[1] then
  local pendingValue = redis.call('GET', KEYS[2])
  if not pendingValue then return nil end
  return {pendingValue}
end
if not currentId then return nil end
local currentKey = ARGV[4] .. currentId
local currentValue = redis.call('GET', currentKey)
if not currentValue then return nil end
local current = cjson.decode(currentValue)
if current.type ~= 'upload_intent' then return nil end
redis.call('PSETEX', KEYS[2], ARGV[3], ARGV[2])
redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[1])
redis.call('DEL', currentKey)
return {ARGV[2], currentValue}
`;

const RESTORE_UPLOAD_INTENT_SCRIPT = `
local currentId = redis.call('GET', KEYS[1])
if currentId ~= ARGV[1] then return 0 end
if not redis.call('GET', KEYS[2]) then return 0 end
redis.call('DEL', KEYS[2])
local ttlMs = tonumber(ARGV[4])
if ttlMs and ttlMs > 0 then
  redis.call('PSETEX', KEYS[3], ttlMs, ARGV[3])
  redis.call('PSETEX', KEYS[1], ttlMs, ARGV[2])
else
  redis.call('DEL', KEYS[1])
end
return 1
`;

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

  async take(id: string): Promise<ConversationSession | undefined> {
    const sessionKey = this.key(id);
    const existing = await this.readSession(sessionKey);
    const indexKey =
      existing && isInteractiveSession(existing)
        ? this.interactiveIndexKey({
            profileName: existing.profileName,
            source: existing.source,
            requesterUserId: existing.requesterUserId
          })
        : undefined;
    const raw =
      indexKey && this.options.client.eval
        ? await this.consumeIndexedSessionByKey(indexKey, sessionKey, id)
        : await this.options.client.getDel(sessionKey);
    if (!raw) return undefined;
    return this.liveSession(JSON.parse(raw) as ConversationSession);
  }

  async set(session: ConversationSession): Promise<void> {
    if (isInteractiveSession(session)) {
      if (!this.options.client.eval) {
        const conflicts = (await this.liveSessions()).filter(
          (existing) =>
            existing.id !== session.id &&
            isInteractiveSession(existing) &&
            existing.profileName === session.profileName &&
            sourceMatches(existing.source, session.source) &&
            requesterMatchesForSource(
              session.source,
              existing.requesterUserId,
              session.requesterUserId
            )
        );
        if (conflicts.length > 0) {
          await this.options.client.del(conflicts.map((existing) => this.key(existing.id)));
        }
      }
      const indexKey = this.interactiveIndexKey({
        profileName: session.profileName,
        source: session.source,
        requesterUserId: session.requesterUserId
      });
      if (indexKey && this.options.client.eval) {
        const ttlMs = new Date(session.expiresAt).getTime() - this.now().getTime();
        await this.options.client.eval(REPLACE_INTERACTIVE_SESSION_SCRIPT, {
          keys: [indexKey, this.key(session.id)],
          arguments: [
            String(Math.max(1, Math.ceil(ttlMs))),
            JSON.stringify(session),
            session.id,
            this.key("")
          ]
        });
        return;
      }
    }
    const ttlMs = new Date(session.expiresAt).getTime() - this.now().getTime();
    await this.options.client.setEx(
      this.key(session.id),
      ttlSeconds(ttlMs),
      JSON.stringify(session)
    );
  }

  async delete(id: string): Promise<void> {
    const sessionKey = this.key(id);
    const existing = await this.readSession(sessionKey);
    const indexKey =
      existing && isInteractiveSession(existing)
        ? this.interactiveIndexKey({
            profileName: existing.profileName,
            source: existing.source,
            requesterUserId: existing.requesterUserId
          })
        : undefined;
    if (indexKey && this.options.client.eval) {
      await this.options.client.eval(DELETE_INDEXED_SESSION_SCRIPT, {
        keys: [indexKey, sessionKey],
        arguments: [id]
      });
      return;
    }
    await this.options.client.del(sessionKey);
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
    const session = await this.indexedInteractiveSession(lookup);
    return session?.type === "pending_function" &&
      (!lookup.action || session.action === lookup.action)
      ? session
      : undefined;
  }

  async findPendingAttachment(
    lookup: PptSelectionLookup
  ): Promise<PendingAttachmentSession | undefined> {
    const session = await this.indexedInteractiveSession(lookup);
    return session?.type === "pending_attachment" ? session : undefined;
  }

  async takePendingAttachment(
    lookup: PptSelectionLookup
  ): Promise<PendingAttachmentSession | undefined> {
    const selected = await this.findPendingAttachment(lookup);
    if (!selected) return undefined;
    const raw = await this.consumeIndexedSession(selected, lookup);
    if (!raw) return undefined;
    return this.liveSession(JSON.parse(raw) as PendingAttachmentSession) as
      PendingAttachmentSession | undefined;
  }

  async findPendingResolution(
    lookup: PptSelectionLookup
  ): Promise<PendingResolutionSession | undefined> {
    const session = await this.indexedInteractiveSession(lookup);
    return session?.type === "pending_resolution" ? session : undefined;
  }

  async findPendingCapabilityResolution(
    lookup: PptSelectionLookup
  ): Promise<PendingCapabilityResolutionSession | undefined> {
    const session = await this.indexedInteractiveSession(lookup);
    return session?.type === "pending_capability_resolution" ? session : undefined;
  }

  async takeUploadIntent(lookup: PptSelectionLookup): Promise<UploadIntentSession | undefined> {
    const candidate = await this.indexedInteractiveSession(lookup);
    const selected = candidate?.type === "upload_intent" ? candidate : undefined;
    if (!selected) return undefined;
    const raw = await this.consumeIndexedSession(selected, lookup);
    if (!raw) return undefined;
    return this.liveSession(JSON.parse(raw) as UploadIntentSession) as
      UploadIntentSession | undefined;
  }

  async takeActionReview(lookup: ActionReviewLookup): Promise<ActionReviewSession | undefined> {
    const indexKey = this.interactiveIndexKey(lookup);
    if (!indexKey) return undefined;
    if (!this.options.client.eval) {
      const session = await this.get(lookup.id);
      if (
        session?.type !== "action_review" ||
        session.profileName !== lookup.profileName ||
        session.requesterUserId !== lookup.requesterUserId ||
        !sourceMatchesExact(session.source, lookup.source)
      ) {
        return undefined;
      }
      const raw = await this.options.client.getDel(this.key(lookup.id));
      return raw ? (JSON.parse(raw) as ActionReviewSession) : undefined;
    }
    const raw = await this.options.client.eval(TAKE_ACTION_REVIEW_SCRIPT, {
      keys: [indexKey, this.key(lookup.id)],
      arguments: [
        lookup.id,
        lookup.profileName,
        lookup.requesterUserId,
        lookup.source.type,
        lookup.source.userId ?? "",
        lookup.source.groupId ?? "",
        lookup.source.roomId ?? "",
        this.now().toISOString()
      ]
    });
    return typeof raw === "string" ? (JSON.parse(raw) as ActionReviewSession) : undefined;
  }

  async promoteUploadIntent(
    pending: PendingAttachmentSession
  ): Promise<UploadIntentPromotion | undefined> {
    const lookup = {
      profileName: pending.profileName,
      source: pending.source,
      requesterUserId: pending.requesterUserId
    };
    const current = await this.indexedInteractiveSession(lookup);
    if (current?.type === "pending_attachment") {
      return current.id === pending.id &&
        current.attachment.messageId === pending.attachment.messageId
        ? { pending: current }
        : undefined;
    }
    if (current?.type !== "upload_intent") return undefined;
    if (!this.options.client.eval) {
      const consumed = await this.takeUploadIntent(lookup);
      if (!consumed) return undefined;
      try {
        await this.set(pending);
      } catch (error) {
        await this.set(consumed);
        throw error;
      }
      return { pending, replaced: consumed };
    }
    const indexKey = this.interactiveIndexKey(lookup);
    if (!indexKey) return undefined;
    const ttlMs = Math.max(
      1,
      Math.ceil(new Date(pending.expiresAt).getTime() - this.now().getTime())
    );
    const raw = await this.options.client.eval(PROMOTE_UPLOAD_INTENT_SCRIPT, {
      keys: [indexKey, this.key(pending.id)],
      arguments: [pending.id, JSON.stringify(pending), String(ttlMs), this.key("")]
    });
    if (!Array.isArray(raw) || typeof raw[0] !== "string") return undefined;
    const promoted = this.liveSession(JSON.parse(raw[0]) as PendingAttachmentSession) as
      PendingAttachmentSession | undefined;
    if (!promoted) return undefined;
    const replaced =
      typeof raw[1] === "string"
        ? (this.liveSession(JSON.parse(raw[1]) as UploadIntentSession) as
            UploadIntentSession | undefined)
        : undefined;
    return { pending: promoted, ...(replaced ? { replaced } : {}) };
  }

  async restoreUploadIntentPromotion(promotion: UploadIntentPromotion): Promise<boolean> {
    if (!promotion.replaced) return false;
    const lookup = {
      profileName: promotion.pending.profileName,
      source: promotion.pending.source,
      requesterUserId: promotion.pending.requesterUserId
    };
    if (!this.options.client.eval) {
      const current = await this.indexedInteractiveSession(lookup);
      if (
        current?.type !== "pending_attachment" ||
        current.id !== promotion.pending.id ||
        current.attachment.messageId !== promotion.pending.attachment.messageId
      ) {
        return false;
      }
      await this.delete(current.id);
      if (this.liveSession(promotion.replaced)) {
        await this.set(promotion.replaced);
      }
      return true;
    }
    const indexKey = this.interactiveIndexKey(lookup);
    if (!indexKey) return false;
    const replaced = promotion.replaced;
    const ttlMs = Math.ceil(new Date(replaced.expiresAt).getTime() - this.now().getTime());
    const restored = await this.options.client.eval(RESTORE_UPLOAD_INTENT_SCRIPT, {
      keys: [indexKey, this.key(promotion.pending.id), this.key(replaced.id)],
      arguments: [promotion.pending.id, replaced.id, JSON.stringify(replaced), String(ttlMs)]
    });
    return Number(restored) === 1;
  }

  async findExternalSearchConsent(
    lookup: ExternalSearchConsentLookup
  ): Promise<ExternalSearchConsentSession | undefined> {
    const liveSessions = (await this.liveSessions())
      .filter(
        (session): session is ExternalSearchConsentSession =>
          session.type === "external_search_consent"
      )
      .filter((session) => session.action === lookup.action)
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );

    return latestSession(liveSessions);
  }

  async findExternalSheetMusicImport(
    lookup: PptSelectionLookup
  ): Promise<ExternalSheetMusicImportSession | undefined> {
    const sessions = (await this.liveSessions())
      .filter(
        (session): session is ExternalSheetMusicImportSession =>
          session.type === "external_sheet_music_import"
      )
      .filter((session) => session.profileName === lookup.profileName)
      .filter((session) => sourceMatches(session.source, lookup.source))
      .filter((session) =>
        requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
      );
    return latestSession(sessions);
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
    const [sessionKeys, indexKeys] = await Promise.all([
      this.options.client.keys(this.key("*")),
      this.options.client.keys(`${this.options.keyPrefix}:interactive-session-v1:*`)
    ]);
    const keys = [...sessionKeys, ...indexKeys];
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

  private async indexedInteractiveSession(
    lookup: PptSelectionLookup
  ): Promise<ConversationSession | undefined> {
    if (!this.options.client.eval) {
      return latestSession(
        (await this.liveSessions())
          .filter((session) => isInteractiveSession(session))
          .filter((session) => session.profileName === lookup.profileName)
          .filter((session) => sourceMatches(session.source, lookup.source))
          .filter((session) =>
            requesterMatchesForSource(
              lookup.source,
              session.requesterUserId,
              lookup.requesterUserId
            )
          )
      );
    }
    const indexKey = this.interactiveIndexKey(lookup);
    if (!indexKey) return undefined;
    const sessionId = await this.options.client.get(indexKey);
    if (!sessionId) return undefined;
    const sessionKey = this.key(sessionId);
    const session = this.liveSession(await this.readSession(sessionKey));
    if (
      !session ||
      !isInteractiveSession(session) ||
      session.profileName !== lookup.profileName ||
      !sourceMatches(session.source, lookup.source) ||
      !requesterMatchesForSource(lookup.source, session.requesterUserId, lookup.requesterUserId)
    ) {
      return undefined;
    }
    return session;
  }

  private async consumeIndexedSession(
    session: ConversationSession,
    lookup: PptSelectionLookup
  ): Promise<string | null> {
    if (!this.options.client.eval) {
      return this.options.client.getDel(this.key(session.id));
    }
    const indexKey = this.interactiveIndexKey(lookup);
    if (!indexKey) return null;
    const raw = await this.options.client.eval(CONSUME_INDEXED_SESSION_SCRIPT, {
      keys: [indexKey, this.key(session.id)],
      arguments: [session.id]
    });
    return typeof raw === "string" ? raw : null;
  }

  private async consumeIndexedSessionByKey(
    indexKey: string,
    sessionKey: string,
    sessionId: string
  ): Promise<string | null> {
    if (!this.options.client.eval) return null;
    const raw = await this.options.client.eval(CONSUME_INDEXED_SESSION_SCRIPT, {
      keys: [indexKey, sessionKey],
      arguments: [sessionId]
    });
    return typeof raw === "string" ? raw : null;
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

  private interactiveIndexKey(lookup: PptSelectionLookup): string | undefined {
    const requesterUserId = lookup.requesterUserId ?? lookup.source.userId;
    if ((lookup.source.type === "group" || lookup.source.type === "room") && !requesterUserId) {
      return undefined;
    }
    return `${this.options.keyPrefix}:interactive-session-v1:${[
      lookup.profileName,
      lineSourceKey(lookup.source),
      requesterUserId ?? ""
    ]
      .map((part) => encodeURIComponent(part))
      .join(":")}`;
  }
}

function isInteractiveSession(session: ConversationSession): boolean {
  return [
    "pending_function",
    "pending_resolution",
    "pending_capability_resolution",
    "pending_attachment",
    "upload_intent",
    "action_review"
  ].includes(session.type);
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

function sourceMatchesExact(expected: LineSource, actual: LineSource): boolean {
  return (
    expected.type === actual.type &&
    expected.userId === actual.userId &&
    expected.groupId === actual.groupId &&
    expected.roomId === actual.roomId
  );
}

function lineSourceKey(source: LineSource): string {
  switch (source.type) {
    case "group":
      return `group:${source.groupId}`;
    case "room":
      return `room:${source.roomId}`;
    case "user":
      return `user:${source.userId}`;
    default:
      return "unknown";
  }
}
