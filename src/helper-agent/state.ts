import type { CreateAgentParams } from "langchain";
import type { Pool, PoolClient } from "pg";

import { createActorFingerprint } from "../observability/opaque-identifiers.js";
import type { LineSource } from "../types.js";

type SdkCheckpointer = NonNullable<CreateAgentParams["checkpointer"]> & {
  deleteThread(threadId: string): Promise<void>;
};

interface HelperAgentStateOptions {
  checkpointer: SdkCheckpointer;
  hmacKey: string;
  now?: () => Date;
}

export interface HelperAgentRunSnapshot {
  externalSheetMusicAllowed: boolean;
  externalSheetMusicQuery?: string;
  markExternalResearch?(): Promise<void>;
}

export interface HelperAgentState {
  checkpointer: SdkCheckpointer;
  threadId(input: { profileName: string; source: LineSource }): string | undefined;
  run<T>(input: {
    threadId: string;
    policyKey: string;
    source: LineSource;
    task: (snapshot: HelperAgentRunSnapshot) => Promise<T>;
  }): Promise<T>;
  reset(threadId: string, clearScopedSessions?: () => Promise<void>): Promise<void>;
  allowExternalSheetMusic(
    threadId: string,
    source: LineSource,
    expiresAt: Date,
    query?: string
  ): Promise<void>;
  externalSheetMusicAllowed(threadId: string): Promise<boolean>;
}

export interface PostgresHelperAgentState extends HelperAgentState {
  setup(): Promise<void>;
  cleanupExpired(): Promise<number>;
}

export function helperThreadIdleTtlMs(source: LineSource): number {
  return source.type === "group" || source.type === "room" ? 15 * 60_000 : 30 * 60_000;
}

export function createHelperAgentState(options: HelperAgentStateOptions): HelperAgentState {
  const now = options.now ?? (() => new Date());
  const expiresAt = new Map<string, number>();
  const externalSearchExpiresAt = new Map<string, number>();
  const externalSearchQueries = new Map<string, string>();
  const policyKeys = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();

  return {
    checkpointer: options.checkpointer,
    threadId: createThreadId(options.hmacKey),
    run: (input) =>
      withMemoryThreadLock(locks, input.threadId, async () => {
        const observedAt = now().getTime();
        const expired = (expiresAt.get(input.threadId) ?? Number.POSITIVE_INFINITY) <= observedAt;
        const policyChanged =
          policyKeys.has(input.threadId) && policyKeys.get(input.threadId) !== input.policyKey;
        if (expired || policyChanged) {
          await options.checkpointer.deleteThread(input.threadId);
          externalSearchExpiresAt.delete(input.threadId);
          externalSearchQueries.delete(input.threadId);
        }
        expiresAt.set(input.threadId, observedAt + helperThreadIdleTtlMs(input.source));
        policyKeys.set(input.threadId, input.policyKey);
        // A provider or domain failure does not invalidate the scoped checkpoint.
        const result = await input.task({
          markExternalResearch: async () => {
            policyKeys.set(input.threadId, "research-in-progress");
          },
          externalSheetMusicQuery: externalSearchQueries.get(input.threadId),
          externalSheetMusicAllowed: (externalSearchExpiresAt.get(input.threadId) ?? 0) > observedAt
        });
        policyKeys.set(input.threadId, input.policyKey);
        expiresAt.set(input.threadId, now().getTime() + helperThreadIdleTtlMs(input.source));
        return result;
      }),
    reset: (threadId, clearScopedSessions) =>
      withMemoryThreadLock(locks, threadId, async () => {
        await clearScopedSessions?.();
        externalSearchQueries.delete(threadId);
        await clearMemoryThread(options.checkpointer, threadId, {
          expiresAt,
          externalSearchExpiresAt,
          policyKeys
        });
      }),
    allowExternalSheetMusic: (threadId, source, expiration, query) =>
      withMemoryThreadLock(locks, threadId, async () => {
        externalSearchExpiresAt.set(threadId, expiration.getTime());
        if (query) externalSearchQueries.set(threadId, query.slice(0, 300));
        else externalSearchQueries.delete(threadId);
        expiresAt.set(threadId, now().getTime() + helperThreadIdleTtlMs(source));
      }),
    async externalSheetMusicAllowed(threadId) {
      return (externalSearchExpiresAt.get(threadId) ?? 0) > now().getTime();
    }
  };
}

export function createPostgresHelperAgentState(
  options: HelperAgentStateOptions & { pool: Pool; lockPool: Pool }
): PostgresHelperAgentState {
  const now = options.now ?? (() => new Date());
  return {
    checkpointer: options.checkpointer,
    threadId: createThreadId(options.hmacKey),
    async setup() {
      await options.pool.query(`
        create table if not exists agent_sdk_threads (
          thread_id text primary key,
          expires_at timestamptz not null,
          policy_key text,
          external_search_expires_at timestamptz
        );
        alter table agent_sdk_threads add column if not exists policy_key text;
        alter table agent_sdk_threads add column if not exists external_search_query text
      `);
    },
    async run(input) {
      const outcome = await withPgThreadLock(options.lockPool, input.threadId, async () => {
        const observedAt = now();
        const current = await options.pool.query<{
          expires_at: Date;
          policy_key: string | null;
          external_search_expires_at: Date | null;
          external_search_query: string | null;
        }>(
          `select expires_at, policy_key, external_search_expires_at, external_search_query
             from agent_sdk_threads where thread_id = $1`,
          [input.threadId]
        );
        let metadata: (typeof current.rows)[number] | undefined = current.rows[0];
        if (
          metadata &&
          (metadata.expires_at.getTime() <= observedAt.getTime() ||
            (metadata.policy_key !== null && metadata.policy_key !== input.policyKey))
        ) {
          await options.checkpointer.deleteThread(input.threadId);
          await options.pool.query("delete from agent_sdk_threads where thread_id = $1", [
            input.threadId
          ]);
          metadata = undefined;
        }
        if (!metadata) {
          await options.pool.query(
            `insert into agent_sdk_threads (thread_id, expires_at, policy_key)
             values ($1, $2, $3)
             on conflict (thread_id) do update
             set expires_at = excluded.expires_at, policy_key = excluded.policy_key`,
            [
              input.threadId,
              new Date(observedAt.getTime() + helperThreadIdleTtlMs(input.source)),
              input.policyKey
            ]
          );
        }
        try {
          const result = await input.task({
            markExternalResearch: async () => {
              await options.pool.query(
                "update agent_sdk_threads set policy_key = $2 where thread_id = $1",
                [input.threadId, "research-in-progress"]
              );
            },
            externalSheetMusicQuery: metadata?.external_search_query ?? undefined,
            externalSheetMusicAllowed:
              (metadata?.external_search_expires_at?.getTime() ?? 0) > observedAt.getTime()
          });
          await options.pool.query(
            `insert into agent_sdk_threads (thread_id, expires_at, policy_key)
             values ($1, $2, $3)
             on conflict (thread_id) do update
             set expires_at = excluded.expires_at, policy_key = excluded.policy_key`,
            [
              input.threadId,
              new Date(now().getTime() + helperThreadIdleTtlMs(input.source)),
              input.policyKey
            ]
          );
          return { kind: "success" as const, result };
        } catch (error) {
          // Preserve the last durable checkpoint on transient dependency failures.
          return { kind: "failure" as const, error };
        }
      });
      if (outcome.kind === "failure") throw outcome.error;
      return outcome.result;
    },
    reset: (threadId, clearScopedSessions) =>
      withPgThreadLock(options.lockPool, threadId, async () => {
        await clearScopedSessions?.();
        await options.checkpointer.deleteThread(threadId);
        await options.pool.query("delete from agent_sdk_threads where thread_id = $1", [threadId]);
      }),
    async allowExternalSheetMusic(threadId, source, expiration, query) {
      await withPgThreadLock(options.lockPool, threadId, () =>
        options.pool.query(
          `insert into agent_sdk_threads (thread_id, expires_at, external_search_expires_at, external_search_query)
         values ($1, $2, $3, $4)
         on conflict (thread_id) do update
         set expires_at = excluded.expires_at,
             external_search_expires_at = excluded.external_search_expires_at,
             external_search_query = excluded.external_search_query`,
          [
            threadId,
            new Date(now().getTime() + helperThreadIdleTtlMs(source)),
            expiration,
            query?.slice(0, 300) ?? null
          ]
        )
      );
    },
    async externalSheetMusicAllowed(threadId) {
      const result = await options.pool.query<{ allowed: boolean }>(
        "select external_search_expires_at > $2 as allowed from agent_sdk_threads where thread_id = $1",
        [threadId, now()]
      );
      return result.rows[0]?.allowed === true;
    },
    async cleanupExpired() {
      const expired = await options.pool.query<{ thread_id: string }>(
        "select thread_id from agent_sdk_threads where expires_at <= $1 order by expires_at limit 100",
        [now()]
      );
      let removed = 0;
      for (const { thread_id: threadId } of expired.rows) {
        removed += await withPgThreadLock(options.lockPool, threadId, async () => {
          const current = await options.pool.query(
            "select 1 from agent_sdk_threads where thread_id = $1 and expires_at <= $2",
            [threadId, now()]
          );
          if (!current.rowCount) return 0;
          await options.checkpointer.deleteThread(threadId);
          const deleted = await options.pool.query(
            "delete from agent_sdk_threads where thread_id = $1 and expires_at <= $2 returning thread_id",
            [threadId, now()]
          );
          if (!deleted.rowCount) return 0;
          return 1;
        });
      }
      return removed;
    }
  };
}

function createThreadId(hmacKey: string) {
  return ({ profileName, source }: { profileName: string; source: LineSource }) => {
    const sourceType = source.type === "group" ? "group" : source.type === "room" ? "room" : "user";
    const sourceId =
      sourceType === "group" ? source.groupId : sourceType === "room" ? source.roomId : undefined;
    const fingerprint = createActorFingerprint(
      { profileName, sourceType, sourceId, requesterUserId: source.userId },
      hmacKey
    );
    return fingerprint ? `helper-${fingerprint}` : undefined;
  };
}

async function clearMemoryThread(
  checkpointer: SdkCheckpointer,
  threadId: string,
  stores: {
    expiresAt: Map<string, number>;
    externalSearchExpiresAt: Map<string, number>;
    policyKeys: Map<string, string>;
  }
): Promise<void> {
  await checkpointer.deleteThread(threadId);
  stores.expiresAt.delete(threadId);
  stores.externalSearchExpiresAt.delete(threadId);
  stores.policyKeys.delete(threadId);
}

async function withMemoryThreadLock<T>(
  locks: Map<string, Promise<void>>,
  threadId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = locks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(threadId, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(threadId) === tail) locks.delete(threadId);
  }
}

async function withPgThreadLock<T>(
  pool: Pool,
  threadId: string,
  task: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [threadId]);
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
