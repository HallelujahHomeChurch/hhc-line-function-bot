export const DEFAULT_TIME_ZONE = "Asia/Taipei";

export function readTimeZone(value: string | undefined, envName = "TIME_ZONE"): string {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid ${envName}: ${timeZone}`);
  }
  return timeZone;
}
