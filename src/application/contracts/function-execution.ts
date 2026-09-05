import type { CapabilityName } from "../../capabilities/names.js";
import type { AgentReplyData, AgentResultEnvelope } from "../../agent/result-envelope.js";
import type { RetrievalDiagnostics } from "../../observability/retrieval-diagnostics.js";
import type { BotProfileConfig, JsonRecord, LineEvent, ModelProviderName } from "../../types.js";

export type AgentResourceType = "ppt_slide" | "sheet_music" | "general_resource";

export type AgentResourceStorage =
  | {
      provider: "graph";
      driveId: string;
      itemId: string;
    }
  | {
      provider: "external_link";
      url: string;
      sourceLabel?: string;
      description?: string;
    };

export interface AgentResourceReference {
  resourceType: AgentResourceType;
  title: string;
  query?: string;
  storage: AgentResourceStorage;
  /** Opaque source snapshot revision used only for bounded revalidation. */
  sourceRevision?: string;
}

export interface FunctionExecutionResult {
  ok: boolean;
  replyText: string;
  executedAction?: CapabilityName;
  writePhase?: "preview" | "commit";
  quickReplies?: QuickReplyItem[];
  /** The sole server-owned source for bounded helper-tool projection. */
  agentResult?: AgentResultEnvelope;
  /** Ephemeral response-only data. Never persist in task frames or traces. */
  responseData?: AgentReplyData;
  /** Ephemeral observability data. Never persist in task frames, memory, or replies. */
  diagnostics?: RetrievalDiagnostics;
  agentResource?: AgentResourceReference;
  smallTalkTrace?: {
    lane: "smart_talk";
    outcome: "generated" | "fallback" | "template";
    provider?: ModelProviderName;
    reason?: string;
  };
}

export interface FunctionHandlerContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId?: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
  /** The SDK agent consumes bounded evidence and owns the final wording. */
  agentTool?: boolean;
}

export type FunctionHandler = (
  args: JsonRecord,
  context: FunctionHandlerContext
) => Promise<FunctionExecutionResult>;

export type FunctionRegistry = Partial<Record<CapabilityName, FunctionHandler>>;

export interface QuickReplyItem {
  label: string;
  action:
    | {
        type: "message";
        label: string;
        text: string;
      }
    | {
        type: "postback";
        label: string;
        data: string;
        displayText?: string;
      }
    | {
        type: "uri";
        label: string;
        uri: string;
      };
}

export interface LineReplyOptions {
  quickReplies?: QuickReplyItem[];
}

export interface PostbackRequest {
  action: string;
  params: Record<string, string>;
}

export interface PostbackContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId?: string;
  requesterDisplayName?: string;
}

export type PostbackHandler = (
  request: PostbackRequest,
  context: PostbackContext
) => Promise<FunctionExecutionResult>;

export interface PostbackHandlerRegistration {
  capability: CapabilityName;
  handle: PostbackHandler;
}

export type PostbackHandlerRegistry = Record<string, PostbackHandlerRegistration>;

export interface TextMessageRequest {
  text: string;
}

export interface TextMessageContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId?: string;
  requesterDisplayName?: string;
  requesterIsAdmin?: boolean;
}

export interface TextMessageHandler {
  capability?: CapabilityName;
  matches(request: TextMessageRequest, context: TextMessageContext): Promise<boolean> | boolean;
  handle(
    request: TextMessageRequest,
    context: TextMessageContext
  ): Promise<FunctionExecutionResult | undefined>;
}

export type TextMessageHandlerRegistry = Record<string, TextMessageHandler>;

export interface AdminCommandContext {
  profile: BotProfileConfig;
  event: LineEvent;
  command: string;
  args: string[];
  requestId?: string;
}

export type AdminHandler = (
  context: AdminCommandContext
) => Promise<FunctionExecutionResult> | FunctionExecutionResult;

export type AdminHandlerRegistry = Record<string, AdminHandler>;
