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
  fallbackPinned?: boolean;
  pinFallback?(): Promise<void>;
  contextReset?: "expired" | "policy_changed";
  markContextDirty?(dirty?: boolean): Promise<void>;
}

export interface HelperAgentState {
  recordReply?(input: {
    threadId: string;
    isCurrent(): Promise<boolean>;
    task(): Promise<void>;
  }): Promise<void>;
  checkpointer: SdkCheckpointer;
  threadId(input: { profileName: string; source: LineSource }): string | undefined;
  run<T>(input: {
    threadId: string;
    policyKey: string;
    source: LineSource;
    isCurrent?: () => Promise<boolean>;
    task: (snapshot: HelperAgentRunSnapshot) => Promise<T>;
  }): Promise<T>;
  reset(threadId: string, clearScopedSessions?: () => Promise<void>): Promise<void>;
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
  const policyKeys = new Map<string, string>();
  const fallbackPins = new Set<string>();
  const locks = new Map<string, Promise<void>>();

  return {
    checkpointer: options.checkpointer,
    threadId: createThreadId(options.hmacKey),
    recordReply: (input) =>
      withMemoryThreadLock(locks, input.threadId, async () => {
        if (!expiresAt.has(input.threadId) || expiresAt.get(input.threadId)! <= now().getTime())
          return;
        if (await input.isCurrent()) await guardedTask(input, options.checkpointer, input.task);
      }),
    run: (input) =>
      withMemoryThreadLock(locks, input.threadId, async () => {
        if (input.isCurrent && !(await input.isCurrent())) throw new Error("context_invalidated");
        const observedAt = now().getTime();
        const expired = (expiresAt.get(input.threadId) ?? Number.POSITIVE_INFINITY) <= observedAt;
        const policyChanged =
          policyKeys.has(input.threadId) && policyKeys.get(input.threadId) !== input.policyKey;
        if (expired || policyChanged) {
          fallbackPins.delete(input.threadId);
          await options.checkpointer.deleteThread(input.threadId);
        }
        expiresAt.set(input.threadId, observedAt + helperThreadIdleTtlMs(input.source));
        policyKeys.set(input.threadId, input.policyKey);
        const result = await guardedTask(input, options.checkpointer, async () =>
          input.task({
            fallbackPinned: fallbackPins.has(input.threadId),
            pinFallback: async () => {
              fallbackPins.add(input.threadId);
            },
            contextReset: expired ? "expired" : policyChanged ? "policy_changed" : undefined,
            markContextDirty: async (dirty = true) => {
              policyKeys.set(
                input.threadId,
                dirty ? "untrusted-context-in-progress" : input.policyKey
              );
            }
          })
        );
        policyKeys.set(input.threadId, input.policyKey);
        expiresAt.set(input.threadId, now().getTime() + helperThreadIdleTtlMs(input.source));
        return result;
      }),
    reset: (threadId, clearScopedSessions) =>
      withMemoryThreadLock(locks, threadId, async () => {
        fallbackPins.delete(threadId);
        await clearScopedSessions?.();
        await clearMemoryThread(options.checkpointer, threadId, {
          expiresAt,
          policyKeys
        });
      })
  };
}

export function createPostgresHelperAgentState(
  options: HelperAgentStateOptions & { pool: Pool; lockPool: Pool }
): PostgresHelperAgentState {
  const now = options.now ?? (() => new Date());
  return {
    checkpointer: options.checkpointer,
    threadId: createThreadId(options.hmacKey),
    recordReply: (input) =>
      withPgThreadLock(options.lockPool, input.threadId, async () => {
        const current = await options.pool.query(
          "select 1 from agent_sdk_threads where thread_id=$1 and expires_at>$2",
          [input.threadId, now()]
        );
        if (current.rowCount && (await input.isCurrent()))
          await guardedTask(input, options.checkpointer, input.task);
      }),
    async setup() {
      // Keep legacy columns for pre-retirement rollback, including fresh databases.
      await options.pool.query(`
        create table if not exists agent_sdk_threads (
          thread_id text primary key,
          expires_at timestamptz not null,
          policy_key text,
          external_search_expires_at timestamptz
        );
        alter table agent_sdk_threads add column if not exists policy_key text;
        alter table agent_sdk_threads add column if not exists fallback_pinned boolean not null default false;
        alter table agent_sdk_threads add column if not exists external_search_query text
      `);
    },
    async run(input) {
      const outcome = await withPgThreadLock(options.lockPool, input.threadId, async () => {
        if (input.isCurrent && !(await input.isCurrent())) throw new Error("context_invalidated");
        const observedAt = now();
        const current = await options.pool.query<{
          expires_at: Date;
          policy_key: string | null;
          fallback_pinned: boolean;
        }>(
          `select expires_at, policy_key, fallback_pinned
             from agent_sdk_threads where thread_id = $1`,
          [input.threadId]
        );
        let metadata: (typeof current.rows)[number] | undefined = current.rows[0];
        const contextReset = metadata
          ? metadata.expires_at.getTime() <= observedAt.getTime()
            ? "expired"
            : metadata.policy_key !== null && metadata.policy_key !== input.policyKey
              ? "policy_changed"
              : undefined
          : undefined;
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
          const result = await guardedTask(input, options.checkpointer, async () =>
            input.task({
              contextReset,
              fallbackPinned: metadata?.fallback_pinned ?? false,
              pinFallback: async () => {
                await options.pool.query(
                  "update agent_sdk_threads set fallback_pinned=true where thread_id=$1",
                  [input.threadId]
                );
              },
              markContextDirty: async (dirty = true) => {
                await options.pool.query(
                  "update agent_sdk_threads set policy_key = $2 where thread_id = $1",
                  [input.threadId, dirty ? "untrusted-context-in-progress" : input.policyKey]
                );
              }
            })
          );
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
    policyKeys: Map<string, string>;
  }
): Promise<void> {
  await checkpointer.deleteThread(threadId);
  stores.expiresAt.delete(threadId);
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

async function guardedTask<T>(
  input: { threadId: string; isCurrent?: () => Promise<boolean> },
  checkpointer: SdkCheckpointer,
  task: () => Promise<T>
): Promise<T> {
  try {
    const result = await task();
    if (input.isCurrent && !(await input.isCurrent())) throw new Error("context_invalidated");
    return result;
  } catch (error) {
    if (input.isCurrent && !(await input.isCurrent()))
      await checkpointer.deleteThread(input.threadId);
    throw error;
  }
}
