import type { CreateAgentParams } from "langchain";
import type { Pool, PoolClient } from "pg";

import { createActorFingerprint } from "../observability/opaque-identifiers.js";
import type { LineSource } from "../types.js";

type SdkCheckpointer = NonNullable<CreateAgentParams["checkpointer"]> & {
  deleteThread(threadId: string): Promise<void>;
};

interface SdkAgentStateOptions {
  checkpointer: SdkCheckpointer;
  hmacKey: string;
  ttlMs: number;
  now?: () => Date;
}

export interface SdkAgentState {
  checkpointer: SdkCheckpointer;
  threadId(input: { profileName: string; source: LineSource }): string | undefined;
  run<T>(threadId: string, policyKey: string, task: () => Promise<T>): Promise<T>;
  allowExternalSheetMusic(threadId: string, expiresAt: Date): Promise<void>;
  externalSheetMusicAllowed(threadId: string): Promise<boolean>;
}

export interface PostgresSdkAgentState extends SdkAgentState {
  setup(): Promise<void>;
  cleanupExpired(): Promise<number>;
}

export function createSdkAgentState(options: SdkAgentStateOptions): SdkAgentState {
  const now = options.now ?? (() => new Date());
  const expiresAt = new Map<string, number>();
  const externalSearchExpiresAt = new Map<string, number>();
  const policyKeys = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();

  return {
    checkpointer: options.checkpointer,
    threadId: createThreadId(options.hmacKey),
    async run(threadId, policyKey, task) {
      const previous = locks.get(threadId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      locks.set(threadId, tail);
      await previous;
      try {
        const expired = (expiresAt.get(threadId) ?? Number.POSITIVE_INFINITY) <= now().getTime();
        const policyChanged = policyKeys.has(threadId) && policyKeys.get(threadId) !== policyKey;
        if (expired || policyChanged) {
          await options.checkpointer.deleteThread(threadId);
          externalSearchExpiresAt.delete(threadId);
        }
        try {
          const result = await task();
          expiresAt.set(threadId, now().getTime() + options.ttlMs);
          policyKeys.set(threadId, policyKey);
          return result;
        } catch (error) {
          await options.checkpointer.deleteThread(threadId);
          expiresAt.delete(threadId);
          externalSearchExpiresAt.delete(threadId);
          policyKeys.delete(threadId);
          throw error;
        }
      } finally {
        release();
        if (locks.get(threadId) === tail) locks.delete(threadId);
      }
    },
    async allowExternalSheetMusic(threadId, expiration) {
      externalSearchExpiresAt.set(threadId, expiration.getTime());
    },
    async externalSheetMusicAllowed(threadId) {
      return (externalSearchExpiresAt.get(threadId) ?? 0) > now().getTime();
    }
  };
}

export function createPostgresSdkAgentState(
  options: SdkAgentStateOptions & { pool: Pool }
): PostgresSdkAgentState {
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
    run: (threadId, policyKey, task) =>
      withPgThreadLock(options.pool, threadId, async (client) => {
        const current = await client.query<{ expires_at: Date; policy_key: string | null }>(
          "select expires_at, policy_key from agent_sdk_threads where thread_id = $1",
          [threadId]
        );
        const metadata = current.rows[0];
        if (
          metadata &&
          (metadata.expires_at.getTime() <= now().getTime() ||
            (metadata.policy_key !== null && metadata.policy_key !== policyKey))
        ) {
          await options.checkpointer.deleteThread(threadId);
          await client.query("delete from agent_sdk_threads where thread_id = $1", [threadId]);
        }
        try {
          const result = await task();
          await client.query(
            `insert into agent_sdk_threads (thread_id, expires_at, policy_key)
             values ($1, $2, $3)
             on conflict (thread_id) do update
             set expires_at = excluded.expires_at, policy_key = excluded.policy_key`,
            [threadId, new Date(now().getTime() + options.ttlMs), policyKey]
          );
          return result;
        } catch (error) {
          await options.checkpointer.deleteThread(threadId);
          await client.query("delete from agent_sdk_threads where thread_id = $1", [threadId]);
          throw error;
        }
      }),
    async allowExternalSheetMusic(threadId, expiration) {
      await options.pool.query(
        `insert into agent_sdk_threads (thread_id, expires_at, external_search_expires_at)
         values ($1, $2, $3)
         on conflict (thread_id) do update set external_search_expires_at = excluded.external_search_expires_at`,
        [threadId, new Date(now().getTime() + options.ttlMs), expiration]
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
    return fingerprint ? `sdk-${fingerprint}` : undefined;
  };
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
