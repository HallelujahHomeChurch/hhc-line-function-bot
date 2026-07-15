import type { JsonRecord, QuickReplyItem } from "../types.js";

export type AgentResultStatus = "success" | "not_found" | "ambiguous" | "unavailable";

export interface AgentEntity {
  type: string;
  key: string;
  label: string;
  aliases?: string[];
}

export interface AgentReplyData {
  kind: string;
  fields: JsonRecord;
  records?: JsonRecord[];
}

export interface AgentResultEnvelope {
  status: AgentResultStatus;
  anchors?: JsonRecord;
  entities?: AgentEntity[];
  evidence?: Array<{ kind: string; reference: JsonRecord }>;
  supportedOperations?: string[];
  clarification?: { prompt: string; choices?: string[] };
  replyText: string;
  quickReplies?: QuickReplyItem[];
  replyData?: AgentReplyData;
  projectionHint?: "focused" | "full";
}
