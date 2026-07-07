import { sanitizeLastRouteRecord } from "./action-telemetry.js";

export interface LastRouteRecord {
  requestId: string;
  occurredAt: string;
  profileName: string;
  sourceType: string;
  phase: "route" | "function" | "admin_route" | "admin_action";
  provider?: string;
  outcome?: "execute" | "respond" | "deny";
  action?: string;
  reason?: string;
  fallbackProvider?: string;
  fallbackReason?: string;
  query?: "present" | "empty" | "missing";
  fileType?: string;
  ok?: boolean;
  durationMs?: number;
  errorName?: string;
}

export interface LastRouteStore {
  record(route: LastRouteRecord): Promise<void>;
  list(): Promise<LastRouteRecord[]>;
  clear(): Promise<number>;
}

export class InMemoryLastRouteStore implements LastRouteStore {
  private readonly routes: LastRouteRecord[] = [];

  constructor(private readonly maxEntries: number) {}

  async record(route: LastRouteRecord): Promise<void> {
    this.routes.unshift(sanitizeLastRouteRecord(route));
    this.routes.splice(this.maxEntries);
  }

  async list(): Promise<LastRouteRecord[]> {
    return [...this.routes];
  }

  async clear(): Promise<number> {
    const count = this.routes.length;
    this.routes.splice(0);
    return count;
  }
}

export function formatLastRoutes(routes: LastRouteRecord[]): string {
  if (routes.length === 0) {
    return "Last routes\n目前沒有 route 紀錄。";
  }

  return [
    "Last routes",
    ...routes.map((route) =>
      [
        `- ${route.occurredAt}`,
        `requestId=${route.requestId}`,
        `phase=${route.phase}`,
        route.provider ? `provider=${route.provider}` : undefined,
        route.outcome ? `outcome=${route.outcome}` : undefined,
        route.action ? `action=${route.action}` : undefined,
        route.reason ? `reason=${route.reason}` : undefined,
        route.query ? `query=${route.query}` : undefined,
        route.fileType ? `fileType=${route.fileType}` : undefined,
        typeof route.ok === "boolean" ? `ok=${route.ok}` : undefined,
        route.errorName ? `error=${route.errorName}` : undefined,
        route.fallbackProvider ? `fallbackProvider=${route.fallbackProvider}` : undefined,
        route.fallbackReason ? `fallbackReason=${route.fallbackReason}` : undefined,
        typeof route.durationMs === "number" ? `durationMs=${route.durationMs}` : undefined
      ]
        .filter(Boolean)
        .join(" ")
    )
  ].join("\n");
}
