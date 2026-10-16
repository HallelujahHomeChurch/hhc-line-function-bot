import type { LineSource } from "../types.js";

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
}
export type QuotedText =
  | {
      status: "resolved";
      author: "user" | "bot";
      kind: "message_text" | "reply_to_request";
      text: string;
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
    }
  ): Promise<QuoteTurn | undefined>;
  recordReply(turn: QuoteTurn, messages: Array<{ id: string; text: string }>): Promise<void>;
  isCurrent(token: QuoteToken): Promise<boolean>;
  acknowledgeClear(token: QuoteToken): Promise<void>;
  reset(scope: QuoteScope): Promise<void>;
  unsend(scope: QuoteScope, messageId: string): Promise<QuoteScope[]>;
}
