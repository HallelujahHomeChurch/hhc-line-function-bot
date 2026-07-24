import type {
  AppConfig,
  AppDiagnostics,
  DependencyStatus,
  NamedDependencyStatus,
  PublicReadinessResult
} from "../types.js";

export interface DiagnosticPostgresClient {
  query(sql: string): Promise<unknown>;
}

export interface DiagnosticRedisClient {
  ping(): Promise<string>;
}

export interface DependencyDiagnosticsOptions {
  config: AppConfig;
  postgres?: DiagnosticPostgresClient;
  redis?: DiagnosticRedisClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export function createDependencyDiagnostics(options: DependencyDiagnosticsOptions): AppDiagnostics {
  const timeoutMs = options.timeoutMs ?? 1500;
  const now = options.now ?? (() => new Date());

  return {
    async checkPublicReadiness(): Promise<PublicReadinessResult> {
      const required = dataLayerRequired(options.config);
      const [postgres, redis] = await Promise.all([
        checkPostgres(options.postgres, required, timeoutMs),
        checkRedis(options.redis, required, timeoutMs)
      ]);
      const status = postgres.status === "error" || redis.status === "error" ? "error" : "ok";
      return {
        service: options.config.serviceName,
        status,
        database: { postgres, redis }
      };
    },

    async formatAdminDiagnostics(): Promise<string> {
      const required = dataLayerRequired(options.config);
      const statuses: NamedDependencyStatus[] = [
        { name: "postgres", ...(await checkPostgres(options.postgres, required, timeoutMs)) },
        { name: "redis", ...(await checkRedis(options.redis, required, timeoutMs)) },
        checkEmbedding(options.config),
        {
          name: "graph",
          configured: Boolean(options.config.graph),
          status: options.config.graph ? "ok" : "missing"
        },
        {
          name: "notion",
          configured: Boolean(options.config.notion || options.config.knowledge),
          status: options.config.notion || options.config.knowledge ? "ok" : "missing"
        }
      ];
      return [
        "Diagnostics",
        `generatedAt: ${now().toISOString()}`,
        `profiles: ${options.config.profiles.map((profile) => profile.name).join(", ")}`,
        `functions: ${formatFunctions(options.config)}`,
        `rateLimit: ${formatRateLimit(options.config)}`,
        ...statuses.map(formatDependencyStatus)
      ].join("\n");
    }
  };
}

function checkEmbedding(config: AppConfig): NamedDependencyStatus {
  return config.knowledge
    ? { name: "embedding", configured: true, status: "ok" }
    : { name: "embedding", configured: false, status: "missing" };
}

export function createStaticAppDiagnostics(config: AppConfig): AppDiagnostics {
  return createDependencyDiagnostics({ config });
}

function dataLayerRequired(config: AppConfig): boolean {
  return config.profiles.some(
    (profile) =>
      profile.registration?.enabled ||
      profile.directAccessPolicy === "managed" ||
      profile.groupAccessPolicy === "managed"
  );
}

async function checkPostgres(
  client: DiagnosticPostgresClient | undefined,
  required: boolean,
  timeoutMs: number
): Promise<DependencyStatus> {
  if (!client) {
    return {
      configured: false,
      status: required ? "error" : "ok",
      message: required ? "missing" : undefined
    };
  }
  return checkTimed("postgres", () => client.query("select 1"), timeoutMs);
}

async function checkRedis(
  client: DiagnosticRedisClient | undefined,
  required: boolean,
  timeoutMs: number
): Promise<DependencyStatus> {
  if (!client) {
    return {
      configured: false,
      status: required ? "error" : "ok",
      message: required ? "missing" : undefined
    };
  }
  return checkTimed("redis", () => client.ping(), timeoutMs);
}

async function checkTimed(
  _name: string,
  fn: () => Promise<unknown>,
  timeoutMs: number
): Promise<DependencyStatus> {
  const startedAt = Date.now();
  try {
    await withTimeout(fn(), timeoutMs);
    return { configured: true, status: "ok", latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      configured: true,
      status: "error",
      latencyMs: elapsedMs(startedAt),
      message: error instanceof Error ? error.name : "error"
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatDependencyStatus(status: NamedDependencyStatus): string {
  return [
    `${status.name}: ${status.status}`,
    `configured=${status.configured}`,
    status.latencyMs === undefined ? undefined : `latencyMs=${status.latencyMs}`,
    status.message ? `message=${status.message}` : undefined
  ]
    .filter(Boolean)
    .join(" ");
}

function formatFunctions(config: AppConfig): string {
  const functions = Array.from(
    new Set(config.profiles.flatMap((profile) => profile.enabledFunctions))
  );
  return functions.length > 0 ? functions.join(", ") : "(none)";
}

function formatRateLimit(config: AppConfig): string {
  const rateLimit = config.rateLimit ?? { enabled: true, windowMs: 60_000, maxRequests: 20 };
  return `${rateLimit.enabled ? "enabled" : "disabled"}, windowMs=${rateLimit.windowMs}, max=${rateLimit.maxRequests}`;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
