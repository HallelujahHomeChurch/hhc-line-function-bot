import type { JsonRecord, LineSource } from "../types.js";
import type { CapabilityName } from "../capabilities/names.js";

export interface ConversationReadReference {
  capability: CapabilityName;
  arguments: JsonRecord;
}
export interface QuoteReplyProjection {
  kind: "conversation" | "read" | "preview" | "commit" | "status";
  publicRead?: ConversationReadReference;
}

export interface QuoteScope {
  profileName: string;
  source: LineSource;
}
export interface QuoteToken {
  threadId: string;
  generation: string;
  chatKey: string;
  sourceKeys: string[];
  eventTimestamp: number;
  turnId?: string;
}
export type QuotedText =
  | {
      status: "resolved";
      author: "user" | "bot";
      otherMember?: true;
      kind: "message_text" | "reply_to_request" | "public_lookup";
      text: string;
      lookup?: ConversationReadReference;
    }
  | { status: "unavailable" | "other_requester" };
export interface QuoteTurn {
  token: QuoteToken;
  quoted?: QuotedText;
  clearCheckpoint: boolean;
  requestText?: string | null;
}
export interface QuoteContext {
  token: QuoteToken;
  quoted?: QuotedText;
  cleared?: boolean;
  replyProjection?: QuoteReplyProjection;
  isCurrent(): Promise<boolean>;
}
export interface QuoteStore {
  inspect(scope: QuoteScope, messageId: string): Promise<{ bot: boolean }>;
  begin(
    input: QuoteScope & {
      messageId?: string;
      quotedMessageId?: string;
      text?: string;
      timestamp?: number;
      deferRequest?: boolean;
      expectedGeneration?: string;
      expectedQuoted?: QuotedText;
    }
  ): Promise<QuoteTurn | undefined>;
  recordReply(
    turn: QuoteTurn,
    messages: Array<{ id: string; text: string }>,
    projection?: QuoteReplyProjection
  ): Promise<void>;
  isCurrent(token: QuoteToken): Promise<boolean>;
  acknowledgeClear(token: QuoteToken): Promise<void>;
  reset(scope: QuoteScope): Promise<void>;
  unsend(scope: QuoteScope, messageId: string): Promise<QuoteScope[]>;
}
