export interface MediaSyncWindow {
  startsAt: string;
  endsAt: string;
}

type Fetcher = typeof fetch;

export function meetingAccessTokenScope(audience: string): string {
  return `${audience.replace(/\/+$/u, "")}/.default`;
}

export class MeetingWindowClient {
  private windows: MediaSyncWindow[] = [];
  private refreshedAt = 0;
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly options: {
      baseUrl: string;
      getAccessToken: () => Promise<string>;
      fetcher?: Fetcher;
      refreshMs?: number;
      leadMs?: number;
      tailMs?: number;
    }
  ) {}

  async isWarm(now = new Date()): Promise<boolean> {
    if (now.getTime() - this.refreshedAt >= (this.options.refreshMs ?? 60_000)) {
      this.refreshPromise ??= this.refresh(now).finally(() => {
        this.refreshPromise = undefined;
      });
      await this.refreshPromise;
    }
    const value = now.getTime();
    const lead = this.options.leadMs ?? 5 * 60_000;
    const tail = this.options.tailMs ?? 10 * 60_000;
    return this.windows.some((window) => {
      const startsAt = Date.parse(window.startsAt);
      const endsAt = Date.parse(window.endsAt);
      return value >= startsAt - lead && value <= endsAt + tail;
    });
  }

  private async refresh(now: Date): Promise<void> {
    const lead = this.options.leadMs ?? 5 * 60_000;
    const tail = this.options.tailMs ?? 10 * 60_000;
    const url = new URL("/priv/meeting-sync-windows", this.options.baseUrl);
    url.searchParams.set("from", new Date(now.getTime() - tail).toISOString());
    url.searchParams.set("to", new Date(now.getTime() + lead).toISOString());
    const response = await (this.options.fetcher ?? fetch)(url, {
      headers: { authorization: `Bearer ${await this.options.getAccessToken()}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`meeting_api_${response.status}`);
    const body = (await response.json()) as unknown;
    if (!isWindowEnvelope(body)) throw new Error("meeting_api_invalid_response");
    this.windows = body.data;
    this.refreshedAt = now.getTime();
  }
}

function isWindowEnvelope(value: unknown): value is { data: MediaSyncWindow[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    Array.isArray(value.data) &&
    value.data.every(
      (window) =>
        typeof window === "object" &&
        window !== null &&
        Object.keys(window).length === 2 &&
        "startsAt" in window &&
        "endsAt" in window &&
        typeof window.startsAt === "string" &&
        typeof window.endsAt === "string" &&
        Number.isFinite(Date.parse(window.startsAt)) &&
        Number.isFinite(Date.parse(window.endsAt)) &&
        Date.parse(window.startsAt) <= Date.parse(window.endsAt)
    )
  );
}
