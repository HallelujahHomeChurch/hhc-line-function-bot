import { createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createActorFingerprint } from "../observability/opaque-identifiers.js";
import type { LineSource } from "../types.js";
import type { QuoteScope, QuoteStore, QuoteToken, QuoteTurn, QuotedText } from "./types.js";

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_LINEAGE = 64;
interface ThreadRow {
  thread_id: string;
  generation: string;
  lineage: string[];
  expires_at: Date;
  scope: QuoteScope;
  clear_pending: boolean;
}
interface MessageRow {
  thread_id: string;
  generation: string;
  author: "user" | "bot";
  safe_text: string | null;
  reference: boolean;
  lineage: string[];
}

export class PostgresQuoteStore implements QuoteStore {
  constructor(
    private readonly pool: Pool,
    private readonly hmacKey: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async setup(): Promise<void> {
    await this.pool.query(`
      create table if not exists line_quote_threads (
        thread_id text primary key, chat_key text not null, generation text not null,
        scope jsonb not null, lineage text[] not null default '{}',
        expires_at timestamptz not null, gc_after timestamptz not null, clear_pending boolean not null default false
      );
      alter table line_quote_threads add column if not exists clear_pending boolean not null default false;
      create index if not exists line_quote_threads_chat on line_quote_threads(chat_key);
      create index if not exists line_quote_threads_lineage on line_quote_threads using gin(lineage);
      create table if not exists line_quote_messages (
        message_key text primary key, chat_key text not null,
        thread_id text not null references line_quote_threads(thread_id) on delete cascade,
        generation text not null, author text not null check(author in ('user','bot')),
        safe_text text, reference boolean not null default false, lineage text[] not null, expires_at timestamptz not null
      );
      alter table line_quote_messages add column if not exists reference boolean not null default false;
      create index if not exists line_quote_messages_expiry on line_quote_messages(expires_at);
      create table if not exists line_quote_tombstones (
        message_key text primary key, expires_at timestamptz not null
      );
    `);
  }

  async inspect(scope: QuoteScope, messageId: string): Promise<{ bot: boolean }> {
    const chat = this.chat(scope);
    if (!chat || !opaque(messageId)) return { bot: false };
    const message = await this.message(this.pool, chat, this.key(chat, messageId));
    return { bot: message?.author === "bot" };
  }

  async begin(
    input: QuoteScope & {
      messageId?: string;
      quotedMessageId?: string;
      text?: string;
      timestamp?: number;
    }
  ): Promise<QuoteTurn | undefined> {
    const chat = this.chat(input);
    const threadId = this.threadId(input);
    if (
      !chat ||
      !threadId ||
      !this.fresh(input.timestamp) ||
      (input.messageId !== undefined && !opaque(input.messageId))
    )
      return undefined;
    return this.transaction(chat, async (client) => {
      const now = this.now();
      const ownKey = input.messageId ? this.key(chat, input.messageId) : undefined;
      if (ownKey && (await this.tombstoned(client, [ownKey]))) return undefined;
      let thread = (
        await client.query<ThreadRow>(
          "select * from line_quote_threads where thread_id=$1 for update",
          [threadId]
        )
      ).rows[0];
      const expired = Boolean(thread && thread.expires_at <= now);
      let clearCheckpoint = Boolean(thread?.clear_pending || expired);
      if (!thread || expired) {
        await client.query("delete from line_quote_messages where thread_id=$1", [threadId]);
        thread = {
          thread_id: threadId,
          generation: randomUUID(),
          lineage: [],
          expires_at: now,
          scope: minimalScope(input),
          clear_pending: clearCheckpoint
        };
      }
      const quotedKey =
        input.quotedMessageId && opaque(input.quotedMessageId)
          ? this.key(chat, input.quotedMessageId)
          : undefined;
      const reference = quotedKey ? await this.message(client, chat, quotedKey) : undefined;
      let quoted: QuotedText | undefined;
      if (input.quotedMessageId) {
        quoted = !reference
          ? { status: "unavailable" }
          : reference.thread_id !== threadId
            ? { status: "other_requester" }
            : reference.generation !== thread.generation || !reference.safe_text
              ? { status: "unavailable" }
              : {
                  status: "resolved",
                  author: reference.author,
                  kind: reference.reference ? "reply_to_request" : "message_text",
                  text: reference.safe_text
                };
      }
      let lineage = [
        ...new Set([
          ...thread.lineage,
          ...(ownKey ? [ownKey] : []),
          ...(reference && quotedKey ? [quotedKey, ...reference.lineage] : [])
        ])
      ];
      if (lineage.length > MAX_LINEAGE) {
        clearCheckpoint = true;
        thread.generation = randomUUID();
        lineage = ownKey ? [ownKey] : [];
        if (quoted) quoted = { status: "unavailable" };
        await client.query("delete from line_quote_messages where thread_id=$1", [threadId]);
      }
      if (await this.tombstoned(client, lineage)) return undefined;
      const expiresAt = new Date(now.getTime() + ttl(input.source));
      await client.query(
        `insert into line_quote_threads(thread_id,chat_key,generation,scope,lineage,expires_at,gc_after,clear_pending)
        values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(thread_id) do update
        set generation=excluded.generation, lineage=excluded.lineage, expires_at=excluded.expires_at, gc_after=excluded.gc_after, clear_pending=excluded.clear_pending`,
        [
          threadId,
          chat,
          thread.generation,
          JSON.stringify(thread.scope),
          lineage,
          expiresAt,
          new Date(now.getTime() + RETENTION_MS),
          clearCheckpoint
        ]
      );
      if (ownKey)
        await this.saveMessage(client, {
          key: ownKey,
          chat,
          threadId,
          generation: thread.generation,
          author: "user",
          text: safeQuoteText(input.text ?? ""),
          lineage,
          expiresAt
        });
      return {
        token: {
          threadId,
          generation: thread.generation,
          chatKey: chat,
          sourceKeys: lineage,
          eventTimestamp: input.timestamp!
        },
        quoted,
        clearCheckpoint,
        requestText: safeQuoteText(input.text ?? "")
      };
    });
  }

  async recordReply(turn: QuoteTurn, messages: Array<{ id: string; text: string }>): Promise<void> {
    if (!this.fresh(turn.token.eventTimestamp)) return;
    await this.transaction(turn.token.chatKey, async (client) => {
      const thread = (
        await client.query<ThreadRow>(
          "select * from line_quote_threads where thread_id=$1 and generation=$2 and expires_at>$3 for update",
          [turn.token.threadId, turn.token.generation, this.now()]
        )
      ).rows[0];
      if (!thread || (await this.tombstoned(client, turn.token.sourceKeys))) return;
      const expiresAt = new Date(this.now().getTime() + ttl(thread.scope.source));
      await client.query("update line_quote_threads set expires_at=$2 where thread_id=$1", [
        thread.thread_id,
        expiresAt
      ]);
      for (const message of messages.slice(0, 5)) {
        if (!opaque(message.id)) continue;
        const key = this.key(turn.token.chatKey, message.id);
        if (await this.tombstoned(client, [key])) continue;
        await this.saveMessage(client, {
          key,
          chat: turn.token.chatKey,
          threadId: thread.thread_id,
          generation: thread.generation,
          author: "bot",
          text: turn.requestText ?? null,
          reference: true,
          lineage: thread.lineage,
          expiresAt
        });
      }
    });
  }

  async isCurrent(token: QuoteToken): Promise<boolean> {
    if (!this.fresh(token.eventTimestamp)) return false;
    const row = (
      await this.pool.query(
        `select 1 from line_quote_threads where thread_id=$1 and generation=$2 and expires_at>$3
      and not exists(select 1 from line_quote_tombstones where message_key=any($4::text[]) and expires_at>$3)`,
        [token.threadId, token.generation, this.now(), token.sourceKeys]
      )
    ).rows[0];
    return Boolean(row);
  }

  async acknowledgeClear(token: QuoteToken): Promise<void> {
    await this.pool.query(
      "update line_quote_threads set clear_pending=false where thread_id=$1 and generation=$2",
      [token.threadId, token.generation]
    );
  }

  async reset(scope: QuoteScope): Promise<void> {
    const chat = this.chat(scope);
    const threadId = this.threadId(scope);
    if (!chat || !threadId) return;
    await this.transaction(chat, async (client) => {
      // Retain a generation even when reset races the very first inbound turn.
      const now = this.now();
      await client.query(
        `insert into line_quote_threads(thread_id,chat_key,generation,scope,lineage,expires_at,gc_after,clear_pending)
        values($1,$2,$3,$4,'{}',$5,$6,true) on conflict(thread_id) do update
        set generation=excluded.generation, lineage='{}', expires_at=excluded.expires_at, gc_after=excluded.gc_after, clear_pending=true`,
        [
          threadId,
          chat,
          randomUUID(),
          JSON.stringify(minimalScope(scope)),
          new Date(now.getTime() + ttl(scope.source)),
          new Date(now.getTime() + RETENTION_MS)
        ]
      );
      await client.query("delete from line_quote_messages where thread_id=$1", [threadId]);
    });
  }

  async unsend(scope: QuoteScope, messageId: string): Promise<QuoteScope[]> {
    const chat = this.chat(scope);
    if (!chat || !opaque(messageId)) return [];
    const key = this.key(chat, messageId);
    return this.transaction(chat, async (client) => {
      await client.query(
        `insert into line_quote_tombstones(message_key,expires_at) values($1,$2)
        on conflict(message_key) do update set expires_at=greatest(line_quote_tombstones.expires_at,excluded.expires_at)`,
        [key, new Date(this.now().getTime() + RETENTION_MS)]
      );
      const affected = await client.query<ThreadRow>(
        `select * from line_quote_threads where chat_key=$1 and
        ($2=any(lineage) or clear_pending or thread_id in (select thread_id from line_quote_messages where message_key=$2)) for update`,
        [chat, key]
      );
      const ids = affected.rows.map((row) => row.thread_id);
      if (ids.length) {
        await client.query(
          "update line_quote_threads set generation=$2, lineage='{}', clear_pending=true where thread_id=any($1::text[])",
          [ids, randomUUID()]
        );
        await client.query("delete from line_quote_messages where thread_id=any($1::text[])", [
          ids
        ]);
      }
      return affected.rows.map((row) => row.scope);
    });
  }

  async cleanupExpired(): Promise<void> {
    const now = this.now();
    await this.pool.query("delete from line_quote_messages where expires_at<=$1", [now]);
    await this.pool.query("delete from line_quote_threads where gc_after<=$1", [now]);
    await this.pool.query("delete from line_quote_tombstones where expires_at<=$1", [now]);
  }

  private async message(
    client: Pick<Pool, "query">,
    chat: string,
    key: string
  ): Promise<MessageRow | undefined> {
    return (
      await client.query<MessageRow>(
        `select m.* from line_quote_messages m join line_quote_threads t on t.thread_id=m.thread_id
      where m.message_key=$1 and m.chat_key=$2 and m.expires_at>$3 and t.expires_at>$3 and t.generation=m.generation
      and not exists(select 1 from line_quote_tombstones x where (x.message_key=m.message_key or x.message_key=any(m.lineage)) and x.expires_at>$3)`,
        [key, chat, this.now()]
      )
    ).rows[0];
  }
  private async tombstoned(client: Pick<Pool, "query">, keys: string[]): Promise<boolean> {
    return (
      (
        await client.query(
          "select 1 from line_quote_tombstones where message_key=any($1::text[]) and expires_at>$2 limit 1",
          [keys, this.now()]
        )
      ).rows.length > 0
    );
  }
  private async saveMessage(
    client: PoolClient,
    input: {
      key: string;
      chat: string;
      threadId: string;
      generation: string;
      author: string;
      text: string | null;
      reference?: boolean;
      lineage: string[];
      expiresAt: Date;
    }
  ): Promise<void> {
    await client.query(
      `insert into line_quote_messages(message_key,chat_key,thread_id,generation,author,safe_text,lineage,expires_at,reference)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(message_key) do nothing`,
      [
        input.key,
        input.chat,
        input.threadId,
        input.generation,
        input.author,
        input.text,
        input.lineage,
        input.expiresAt,
        input.reference ?? false
      ]
    );
  }
  private async transaction<T>(chat: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `line-quote:${chat}`
      ]);
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  private threadId(scope: QuoteScope): string | undefined {
    const source = scope.source;
    if (
      !opaque(source.userId) ||
      (source.type !== "user" && source.type !== "group" && source.type !== "room")
    )
      return undefined;
    const fingerprint = createActorFingerprint(
      {
        profileName: scope.profileName,
        sourceType: source.type,
        sourceId:
          source.type === "group"
            ? source.groupId
            : source.type === "room"
              ? source.roomId
              : undefined,
        requesterUserId: source.userId
      },
      this.hmacKey
    );
    return fingerprint ? `helper-${fingerprint}` : undefined;
  }
  private chat(scope: QuoteScope): string | undefined {
    const source = scope.source;
    const id =
      source.type === "group"
        ? source.groupId
        : source.type === "room"
          ? source.roomId
          : source.type === "user"
            ? source.userId
            : undefined;
    return opaque(id) ? this.hash(JSON.stringify([scope.profileName, source.type, id])) : undefined;
  }
  private key(chat: string, id: string): string {
    return this.hash(JSON.stringify([chat, id]));
  }
  private hash(value: string): string {
    return createHmac("sha256", this.hmacKey).update(value).digest("hex");
  }
  private fresh(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > this.now().getTime() - RETENTION_MS &&
      value <= this.now().getTime() + 60_000
    );
  }
}
function ttl(source: LineSource): number {
  return source.type === "user" ? 30 * 60_000 : 15 * 60_000;
}
function opaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\s\p{Cc}]/u.test(value)
  );
}
export function safeQuoteText(value: string): string | null {
  // Credential links, commands and approval drafts are reference-only. Never retain their secrets.
  if (
    /https?:\/\/|(?:^|\s)\/[a-z]|(?:token|nonce|secret|password|api\s*key|access\s*key|密碼|私鑰|金鑰|驗證碼|邀請碼|綁定碼|確認碼)\s*[:：=]?|action=|Bearer\s/iu.test(
      value
    )
  )
    return null;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return text ? text.slice(0, 1000) : null;
}

function minimalScope(scope: QuoteScope): QuoteScope {
  const { type, userId, groupId, roomId } = scope.source;
  return {
    profileName: scope.profileName,
    source: {
      type,
      ...(userId ? { userId } : {}),
      ...(type === "group" && groupId ? { groupId } : {}),
      ...(type === "room" && roomId ? { roomId } : {})
    }
  };
}
