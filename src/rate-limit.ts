import type { LineSource, RateLimitConfig } from "./types.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
  /** The bucket owns one notification attempt, not guaranteed delivery. */
  shouldNotify?: boolean;
}

export interface RateLimiter {
  check(input: { profileName: string; source: LineSource }): Promise<RateLimitResult>;
}

export interface RedisRateLimitClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface RateLimiterFactoryOptions {
  config: RateLimitConfig;
  redis?: { client: RedisRateLimitClient; keyPrefix: string };
  now?: () => Date;
}

interface Bucket {
  count: number;
  resetAt: number;
  notified: boolean;
}

// One atomic operation owns counter creation/TTL repair and the notification claim.
// The group resource key retains the old group bucket; old keys expire naturally.
const CHECK_BUCKETS = `
local function hit(key, limit)
  local count = redis.call('INCR', key)
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then
    redis.call('PEXPIRE', key, ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  local notify = 0
  if count > limit then
    local claim = redis.call('SET', key .. ':notified', '1', 'NX', 'PX', math.max(1, ttl))
    if claim then notify = 1 end
  end
  return {count, ttl, notify}
end
local result = hit(KEYS[1], tonumber(ARGV[2]))
local limit = tonumber(ARGV[2])
if result[1] <= limit and #KEYS > 1 then
  local group = hit(KEYS[2], tonumber(ARGV[3]))
  if group[1] > tonumber(ARGV[3]) then
    result = group
    limit = tonumber(ARGV[3])
  end
end
return {result[1] <= limit and 1 or 0, math.max(0, limit - result[1]), result[2], result[3]}
`;

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  async check(input: { profileName: string; source: LineSource }): Promise<RateLimitResult> {
    const nowMs = this.now().getTime();
    if (!this.config.enabled) return unrestricted(nowMs);
    const keys = bucketKeys(input);
    if (!keys) return unidentified(nowMs);
    // Bound idle in-memory state. Production uses Redis expiry.
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= nowMs) this.buckets.delete(key);
    }
    const hit = (key: string, limit: number): RateLimitResult => {
      const bucket = this.buckets.get(key) ?? {
        count: 0,
        resetAt: nowMs + this.config.windowMs,
        notified: false
      };
      bucket.count += 1;
      this.buckets.set(key, bucket);
      const allowed = bucket.count <= limit;
      const shouldNotify = !allowed && !bucket.notified;
      if (shouldNotify) bucket.notified = true;
      return {
        allowed,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: new Date(bucket.resetAt).toISOString(),
        shouldNotify
      };
    };
    const requester = hit(keys[0], this.config.maxRequests);
    if (!requester.allowed || !keys[1]) return requester;
    const group = hit(keys[1], groupLimit(this.config));
    return group.allowed ? requester : group;
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly options: Required<RateLimiterFactoryOptions>) {}

  async check(input: { profileName: string; source: LineSource }): Promise<RateLimitResult> {
    const nowMs = this.options.now().getTime();
    if (!this.options.config.enabled) return unrestricted(nowMs);
    const keys = bucketKeys(input);
    if (!keys) return unidentified(nowMs);
    const result = await this.options.redis.client.eval(CHECK_BUCKETS, {
      keys: keys.map((key) => `${this.options.redis.keyPrefix}:rate-limit:${key}`),
      arguments: [
        String(this.options.config.windowMs),
        String(this.options.config.maxRequests),
        String(groupLimit(this.options.config))
      ]
    });
    if (
      !Array.isArray(result) ||
      result.length !== 4 ||
      !result.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error("Invalid rate limit result");
    }
    return {
      allowed: result[0] === 1,
      remaining: result[1],
      resetAt: new Date(nowMs + result[2]).toISOString(),
      shouldNotify: result[3] === 1
    };
  }
}

export function createRateLimiter(options: RateLimiterFactoryOptions): RateLimiter {
  if (options.redis)
    return new RedisRateLimiter({
      ...options,
      redis: options.redis,
      now: options.now ?? (() => new Date())
    });
  return new InMemoryRateLimiter(options.config, options.now);
}

function groupLimit(config: RateLimitConfig): number {
  return config.groupMaxRequests ?? Math.max(100, config.maxRequests);
}

function bucketKeys(input: { profileName: string; source: LineSource }): string[] | undefined {
  const { profileName, source } = input;
  if (source.type === "user")
    return source.userId ? [`${profileName}:user:${source.userId}`] : undefined;
  const chat =
    source.type === "group" ? source.groupId : source.type === "room" ? source.roomId : undefined;
  if (!chat) return undefined;
  const group = `${profileName}:${source.type}:${chat}`;
  return [`${group}:requester:${source.userId || "anonymous"}`, group];
}

function unrestricted(nowMs: number): RateLimitResult {
  return {
    allowed: true,
    remaining: Number.MAX_SAFE_INTEGER,
    resetAt: new Date(nowMs).toISOString(),
    shouldNotify: false
  };
}

function unidentified(nowMs: number): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    resetAt: new Date(nowMs).toISOString(),
    shouldNotify: false
  };
}
