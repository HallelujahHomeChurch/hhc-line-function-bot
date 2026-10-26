// Deployment configuration survives a lost or stale Redis store.
export function recoveryCutoff(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.LINE_REDIS_RECOVERY_CUTOFF_MS;
  if (raw === undefined || raw === "") {
    if (
      (env.LINE_REDIS_RECOVERY && env.LINE_REDIS_RECOVERY !== "null") ||
      env.REDIS_KEY_PREFIX?.includes(":recovery:")
    )
      throw new Error("redis_recovery_configuration_invalid");
    return undefined;
  }
  let identity: { cutoffMs?: unknown; prefix?: unknown };
  try {
    identity = JSON.parse(env.LINE_REDIS_RECOVERY ?? "null");
  } catch {
    throw new Error("redis_recovery_configuration_invalid");
  }
  if (!identity || identity.cutoffMs !== Number(raw) || identity.prefix !== env.REDIS_KEY_PREFIX)
    throw new Error("redis_recovery_configuration_invalid");
  const cutoff = Number(raw);
  if (
    !/^\d{13}$/.test(raw) ||
    !Number.isSafeInteger(cutoff) ||
    cutoff <= 0 ||
    !/^hhc-line-function-bot:recovery:[0-9a-f-]{36}$/.test(env.REDIS_KEY_PREFIX ?? "")
  ) {
    throw new Error("redis_recovery_configuration_invalid");
  }
  return cutoff;
}

export function recoveryAllowsEvent(event: unknown, cutoff: number, now = Date.now()): boolean {
  if (!event || typeof event !== "object") return false;
  const timestamp = (event as { timestamp?: unknown }).timestamp;
  return (
    typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    timestamp > cutoff &&
    timestamp <= now + 60_000
  );
}
