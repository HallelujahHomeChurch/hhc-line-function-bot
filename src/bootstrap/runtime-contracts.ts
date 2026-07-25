import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../types.js";

export type ProductionRuntimeConfig = Pick<AppConfig, "database" | "redis">;

export interface ApplicationRuntime {
  app: FastifyInstance;
  close(): Promise<void>;
}

export type ProductionRuntime = ApplicationRuntime;

export function assertProductionPersistence(config: ProductionRuntimeConfig): void {
  if (!config.database || !config.redis) {
    throw new Error("Production runtime requires DATABASE_URL and REDIS_URL");
  }
}
