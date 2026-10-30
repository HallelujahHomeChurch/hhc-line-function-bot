import type { LineSource } from "../types.js";
export interface HistoryScope {
  profileName: string;
  source: LineSource;
}
export interface HistoryDependency {
  scope: string;
  revision: string;
  epoch: string;
  keys: string[];
}
export interface HistoryQuery {
  start: string;
  end: string;
  topic?: string;
  quotedMessageId?: string;
}
export interface HistoryRecord {
  key: string;
  speaker: string;
  at: string;
  text: string;
}
export interface HistoryResult {
  status: "success" | "not_found" | "unavailable";
  start: string;
  end: string;
  incomplete: boolean;
  records: HistoryRecord[];
  coverage?: { retainedFrom: string | null; retainedUntil: string | null; hasGaps: true };
  dependency?: HistoryDependency;
}
export interface GroupHistory {
  enabledFor(scope: HistoryScope): boolean;
  recordReply?(
    scope: HistoryScope,
    messages: Array<{ id: string; text: string }>,
    dependencies?: HistoryDependency[]
  ): Promise<void>;
  ingest(
    scope: HistoryScope,
    event: {
      type: string;
      timestamp?: number;
      message?: { id?: string; type: string; text?: string; quotedMessageId?: string };
      unsend?: { messageId?: string };
    }
  ): Promise<void>;
  search(scope: HistoryScope, query: HistoryQuery, now: Date): Promise<HistoryResult>;
  validate(scope: HistoryScope, dependency: HistoryDependency): Promise<boolean>;
  purge(): Promise<void>;
}
export interface HistoryPolicy {
  profileName: string;
  groupId: string;
  revision: string;
  enabledAt: string;
  excludedRequesterIds: string[];
}
export interface HistoryConfig {
  enabled: boolean;
  generation: number;
  restoreEpoch: string;
  retentionDays: number;
  maxGroupMessages: number;
  maxGroupBytes: number;
  maxTotalMessages: number;
  maxTotalBytes: number;
  maxMessageBytes: number;
  policies: HistoryPolicy[];
}
