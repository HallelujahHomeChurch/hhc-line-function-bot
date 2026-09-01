export async function runWarmScheduler(
  options: {
    isWarm(now: Date): Promise<boolean>;
    sendPulse(input: { ttlSeconds: number }): Promise<void>;
  },
  now = new Date()
): Promise<{ status: "cold" | "pulsed" }> {
  if (!(await options.isWarm(now))) return { status: "cold" };
  await options.sendPulse({ ttlSeconds: 120 });
  return { status: "pulsed" };
}
