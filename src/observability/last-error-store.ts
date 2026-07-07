import { sanitizeLastErrorRecord } from "./action-telemetry.js";

export interface LastErrorRecord {
  requestId: string;
  occurredAt: string;
  profileName: string;
  sourceType: string;
  phase: "router" | "function" | "admin" | "postback" | "text_handler";
  action?: string;
  command?: string;
  errorName?: string;
  message: string;
}

export interface LastErrorStore {
  record(error: LastErrorRecord): Promise<void>;
  list(): Promise<LastErrorRecord[]>;
  clear(): Promise<number>;
}

export class InMemoryLastErrorStore implements LastErrorStore {
  private readonly errors: LastErrorRecord[] = [];

  constructor(private readonly maxEntries: number) {}

  async record(error: LastErrorRecord): Promise<void> {
    this.errors.unshift(sanitizeLastErrorRecord(error));
    this.errors.splice(this.maxEntries);
  }

  async list(): Promise<LastErrorRecord[]> {
    return [...this.errors];
  }

  async clear(): Promise<number> {
    const count = this.errors.length;
    this.errors.splice(0);
    return count;
  }
}

export function formatLastErrors(errors: LastErrorRecord[]): string {
  if (errors.length === 0) {
    return "Last errors\n目前沒有錯誤紀錄。";
  }

  return [
    "Last errors",
    ...errors.map((error) =>
      [
        `- ${error.occurredAt}`,
        `requestId=${error.requestId}`,
        `phase=${error.phase}`,
        error.action ? `action=${error.action}` : undefined,
        error.command ? `command=${error.command}` : undefined,
        `error=${error.errorName ?? "Error"}`,
        `message=${error.message}`
      ]
        .filter(Boolean)
        .join(" ")
    )
  ].join("\n");
}
