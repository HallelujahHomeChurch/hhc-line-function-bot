import { createHmac } from "node:crypto";
import type { RedisRateLimitClient } from "../rate-limit.js";
import type { LineSource } from "../types.js";
import type { SearchSettingsInput } from "../search-settings/contracts.js";

const RESERVE = `
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
local used = redis.call('GET',KEYS[1])
if not used then
  -- Old counters cannot distinguish groups; conservatively carry their bounded total once.
  used = tonumber(redis.call('GET',KEYS[3]) or '0') + tonumber(redis.call('GET',KEYS[4]) or '0')
  redis.call('SET',KEYS[1],used,'EX',172800)
end
if tonumber(used) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET',KEYS[2],'1','EX',172800)
redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],172800)
return 1
`;

/** Failed/unknown completion retains its reservation; settings never reset usage. */
export function createPublicSearchQuota(options: {
  client: RedisRateLimitClient;
  keyPrefix: string;
  hmacKey: string;
  settings: () => Promise<SearchSettingsInput>;
  now?: () => Date;
}) {
  return async (profile: string, source: LineSource, eventId: string): Promise<boolean> => {
    if (profile !== "helper" || !source.userId || !eventId) return false;
    const subject =
      source.type === "user"
        ? `user:${source.userId}`
        : source.type === "group" && source.groupId
          ? `group:${source.groupId}`
          : undefined;
    if (!subject) return false;
    const digest = (value: string) =>
      createHmac("sha256", options.hmacKey).update(value).digest("hex");
    const now = options.now?.() ?? new Date();
    const day = new Date(now.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
    const prefix = `${options.keyPrefix}:public-search:${digest(profile)}`;
    const previousDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    try {
      const settings = await options.settings();
      const limit = source.type === "user" ? settings.directDailyLimit : settings.groupDailyLimit;
      if (!settings.enabled || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
        return false;
      return (
        (await options.client.eval(RESERVE, {
          keys: [
            `${prefix}:taipei:${day}:${digest(subject)}`,
            `${prefix}:event:${digest(eventId)}`,
            `${prefix}:${day}`,
            `${prefix}:${previousDay}`
          ],
          arguments: [String(limit)]
        })) === 1
      );
    } catch {
      return false;
    }
  };
}
