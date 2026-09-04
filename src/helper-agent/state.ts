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

export interface HelperAgentState {
  checkpointer: SdkCheckpointer;
  threadId(input: { profileName: string; source: LineSource }): string | undefined;
  run<T>(input: {
    threadId: string;
    policyKey: string;
    source: LineSource;
    task: () => Promise<T>;
  }): Promise<T>;
  reset(threadId: string): Promise<void>;
  allowExternalSheetMusic(threadId: string, source: LineSource, expiresAt: Date): Promise<void>;
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
  const policyKeys = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();

  return {
    checkpointer: options.checkpointer,
    threadId: createThreadId(options.hmacKey),
    run: (input) =>
      withMemoryThreadLock(locks, input.threadId, async () => {
        const expired =
          (expiresAt.get(input.threadId) ?? Number.POSITIVE_INFINITY) <= now().getTime();
        const policyChanged =
          policyKeys.has(input.threadId) && policyKeys.get(input.threadId) !== input.policyKey;
        if (expired || policyChanged) {
          await options.checkpointer.deleteThread(input.threadId);
          externalSearchExpiresAt.delete(input.threadId);
        }
        try {
          const result = await input.task();
          expiresAt.set(input.threadId, now().getTime() + helperThreadIdleTtlMs(input.source));
          policyKeys.set(input.threadId, input.policyKey);
          return result;
        } catch (error) {
          await clearMemoryThread(options.checkpointer, input.threadId, {
            expiresAt,
            externalSearchExpiresAt,
            policyKeys
          });
          throw error;
        }
      }),
    reset: (threadId) =>
      withMemoryThreadLock(locks, threadId, () =>
        clearMemoryThread(options.checkpointer, threadId, {
          expiresAt,
          externalSearchExpiresAt,
          policyKeys
        })
      ),
    async allowExternalSheetMusic(threadId, _source, expiration) {
      externalSearchExpiresAt.set(threadId, expiration.getTime());
    },
    async externalSheetMusicAllowed(threadId) {
      return (externalSearchExpiresAt.get(threadId) ?? 0) > now().getTime();
    }
  };
}

export function createPostgresHelperAgentState(
  options: HelperAgentStateOptions & { pool: Pool }
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
        alter table agent_sdk_threads add column if not exists policy_key text
      `);
    },
    async run(input) {
      const outcome = await withPgThreadLock(options.pool, input.threadId, async (client) => {
        const current = await client.query<{ expires_at: Date; policy_key: string | null }>(
          "select expires_at, policy_key from agent_sdk_threads where thread_id = $1",
          [input.threadId]
        );
        const metadata = current.rows[0];
        if (
          metadata &&
          (metadata.expires_at.getTime() <= now().getTime() ||
            (metadata.policy_key !== null && metadata.policy_key !== input.policyKey))
        ) {
          await options.checkpointer.deleteThread(input.threadId);
          await client.query("delete from agent_sdk_threads where thread_id = $1", [
            input.threadId
          ]);
        }
        try {
          const result = await input.task();
          await client.query(
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
          await options.checkpointer.deleteThread(input.threadId);
          await client.query("delete from agent_sdk_threads where thread_id = $1", [
            input.threadId
          ]);
          return { kind: "failure" as const, error };
        }
      });
      if (outcome.kind === "failure") throw outcome.error;
      return outcome.result;
    },
    reset: (threadId) =>
      withPgThreadLock(options.pool, threadId, async (client) => {
        await options.checkpointer.deleteThread(threadId);
        await client.query("delete from agent_sdk_threads where thread_id = $1", [threadId]);
      }),
    async allowExternalSheetMusic(threadId, source, expiration) {
      await withPgThreadLock(options.pool, threadId, (client) =>
        client.query(
          `insert into agent_sdk_threads (thread_id, expires_at, external_search_expires_at)
         values ($1, $2, $3)
         on conflict (thread_id) do update
         set expires_at = excluded.expires_at,
             external_search_expires_at = excluded.external_search_expires_at`,
          [threadId, new Date(now().getTime() + helperThreadIdleTtlMs(source)), expiration]
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
        removed += await withPgThreadLock(options.pool, threadId, async (client) => {
          const deleted = await client.query(
            "delete from agent_sdk_threads where thread_id = $1 and expires_at <= $2 returning thread_id",
            [threadId, now()]
          );
          if (!deleted.rowCount) return 0;
          await options.checkpointer.deleteThread(threadId);
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
