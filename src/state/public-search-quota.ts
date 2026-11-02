import { createHmac } from "node:crypto";
import type { RedisRateLimitClient } from "../rate-limit.js";

export const PUBLIC_SEARCH_DAILY_PROFILE_LIMIT = 20;
export const PUBLIC_SEARCH_DAILY_REQUESTER_LIMIT = 3;
const RESERVE = `
if redis.call('EXISTS',KEYS[3]) == 1 then return 0 end
if tonumber(redis.call('GET',KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
if tonumber(redis.call('GET',KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 0 end
redis.call('SET',KEYS[3],'1','EX',172800)
redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],172800)
redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],172800)
return 1
`;

/** No refunds: a timeout or unknown completion may already have incurred provider cost. */
export function createPublicSearchQuota(options: {
  client: RedisRateLimitClient;
  keyPrefix: string;
  hmacKey: string;
  now?: () => Date;
}) {
  return async (profile: string, requester: string, eventId: string): Promise<boolean> => {
    const digest = (value: string) =>
      createHmac("sha256", options.hmacKey).update(value).digest("hex");
    const day = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
    const prefix = `${options.keyPrefix}:public-search:${digest(profile)}`;
    try {
      return (
        (await options.client.eval(RESERVE, {
          keys: [
            `${prefix}:${day}`,
            `${prefix}:${day}:${digest(requester)}`,
            `${prefix}:event:${digest(eventId)}`
          ],
          arguments: [
            String(PUBLIC_SEARCH_DAILY_PROFILE_LIMIT),
            String(PUBLIC_SEARCH_DAILY_REQUESTER_LIMIT)
          ]
        })) === 1
      );
    } catch {
      return false;
    }
  };
}
