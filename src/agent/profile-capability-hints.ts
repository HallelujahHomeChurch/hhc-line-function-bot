import type { BotProfileConfig, FunctionName } from "../types.js";

export function profileCapabilityHints(
  profile: BotProfileConfig
): Partial<Record<FunctionName, readonly string[]>> {
  const scheduleHints = profile.schedulePolicy?.domains?.flatMap((domain) => [
    domain.displayName,
    ...domain.aliases,
    ...domain.routingHints
  ]);
  return scheduleHints?.length ? { query_schedule: scheduleHints } : {};
}
