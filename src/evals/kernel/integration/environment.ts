import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";

export interface KernelPostgresEnvironment {
  pools: [Pool, Pool];
  schemaName: string;
  cleanup(): Promise<void>;
}

export async function createKernelPostgresEnvironment(): Promise<KernelPostgresEnvironment> {
  const connectionString = process.env.KERNEL_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error("kernel_integration_postgres_url_required");
  }

  const schemaName = `kernel_v1_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteKernelSchema(schemaName);
  const ownerPool = new Pool({ connectionString, max: 1 });
  let pools: [Pool, Pool] | undefined;
  try {
    const vector = await ownerPool.query(
      "select extversion from pg_extension where extname = 'vector'"
    );
    if (vector.rows.length !== 1) {
      throw new Error("kernel_integration_pgvector_not_ready");
    }
    await ownerPool.query(`create schema ${quotedSchema}`);
    pools = [
      createSchemaPool(connectionString, schemaName),
      createSchemaPool(connectionString, schemaName)
    ];
    await Promise.all(pools.map(async (pool) => pool.query("select 1")));
  } catch (error) {
    await Promise.allSettled(pools?.map(async (pool) => pool.end()) ?? []);
    await ownerPool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => undefined);
    await ownerPool.end().catch(() => undefined);
    throw error;
  }

  let cleaned = false;
  return {
    pools,
    schemaName,
    async cleanup() {
      if (cleaned) return;
      const closeResults = await Promise.allSettled(pools.map(async (pool) => pool.end()));
      let cleanupError: unknown;
      try {
        await ownerPool.query(`drop schema if exists ${quotedSchema} cascade`);
      } catch (error) {
        cleanupError = error;
      }
      await ownerPool.end();
      if (cleanupError) throw cleanupError;
      if (closeResults.some((result) => result.status === "rejected")) {
        throw new Error("kernel_integration_postgres_cleanup_close_failed");
      }
      cleaned = true;
    }
  };
}

export interface KernelRedisEnvironment {
  clients: [RedisClientType, RedisClientType];
  keyPrefix: string;
  reconnectReplica(index: 0 | 1): Promise<RedisClientType>;
  disconnectReplicas(): Promise<void>;
  reconnectReplicas(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createKernelRedisEnvironment(): Promise<KernelRedisEnvironment> {
  const url = process.env.KERNEL_REDIS_URL?.trim();
  if (!url) {
    throw new Error("kernel_integration_redis_url_required");
  }

  const keyPrefix = `kernel-v1:${randomUUID()}`;
  const clients = [createRedisClient(url), createRedisClient(url)] as [
    RedisClientType,
    RedisClientType
  ];

  try {
    await Promise.all(clients.map(async (client) => client.connect()));
    const pongs = await Promise.all(clients.map(async (client) => client.ping()));
    if (pongs.some((pong) => pong !== "PONG")) {
      throw new Error("kernel_integration_redis_not_ready");
    }
  } catch (error) {
    await Promise.allSettled(clients.map(async (client) => closeRedisClient(client)));
    throw error;
  }

  let cleaned = false;
  return {
    clients,
    keyPrefix,
    async reconnectReplica(index) {
      await closeRedisClient(clients[index]);
      const replacement = createRedisClient(url);
      await replacement.connect();
      if ((await replacement.ping()) !== "PONG") {
        await closeRedisClient(replacement);
        throw new Error("kernel_integration_redis_not_ready");
      }
      clients[index] = replacement;
      return replacement;
    },
    async disconnectReplicas() {
      const results = await Promise.allSettled(
        clients.map(async (client) => closeRedisClient(client))
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("kernel_integration_redis_disconnect_failed");
      }
    },
    async reconnectReplicas() {
      for (const index of [0, 1] as const) {
        if (clients[index].isOpen) await closeRedisClient(clients[index]);
        const replacement = createRedisClient(url);
        await replacement.connect();
        if ((await replacement.ping()) !== "PONG") {
          await closeRedisClient(replacement);
          throw new Error("kernel_integration_redis_not_ready");
        }
        clients[index] = replacement;
      }
    },
    async cleanup() {
      if (cleaned) return;
      let cleanupClient = clients.find((client) => client.isReady);
      let ownsCleanupClient = false;
      let cleanupFailure: unknown;
      try {
        if (!cleanupClient) {
          cleanupClient = createRedisClient(url);
          ownsCleanupClient = true;
          await cleanupClient.connect();
          if ((await cleanupClient.ping()) !== "PONG") {
            throw new Error("kernel_integration_redis_not_ready");
          }
        }
        const keys = await cleanupClient.keys(`${keyPrefix}:*`);
        if (keys.length > 0) await cleanupClient.del(keys);
        if ((await cleanupClient.keys(`${keyPrefix}:*`)).length > 0) {
          throw new Error("kernel_integration_redis_cleanup_incomplete");
        }
      } catch (error) {
        cleanupFailure = error;
      }
      const clientsToClose =
        ownsCleanupClient && cleanupClient ? [...clients, cleanupClient] : clients;
      const closeResults = await Promise.allSettled(
        clientsToClose.map(async (client) => closeRedisClient(client))
      );
      if (cleanupFailure) throw cleanupFailure;
      if (closeResults.some((result) => result.status === "rejected")) {
        throw new Error("kernel_integration_redis_cleanup_close_failed");
      }
      cleaned = true;
    }
  };
}

function createRedisClient(url: string): RedisClientType {
  const client = createClient({ url });
  client.on("error", () => undefined);
  return client;
}

async function closeRedisClient(client: RedisClientType): Promise<void> {
  if (client.isOpen) {
    await client.quit();
  }
}

function createSchemaPool(connectionString: string, schemaName: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${schemaName},public`
  });
}

function quoteKernelSchema(schemaName: string): string {
  if (!/^kernel_v1_[a-f0-9]{32}$/.test(schemaName)) {
    throw new Error("kernel_integration_postgres_schema_invalid");
  }
  return `"${schemaName}"`;
}
