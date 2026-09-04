import type { CapabilityName } from "../../capabilities/names.js";
import type { RetrievalDiagnostics } from "../../observability/retrieval-diagnostics.js";
import type {
  AdminActionName,
  JsonRecord,
  LineSource,
  ModelProviderLane,
  ModelProviderName,
  RouteProviderName,
  SystemActionName
} from "../../types.js";

export interface RouteInput {
  profileName: string;
  text: string;
  enabledFunctions: CapabilityName[];
  source: LineSource;
  runtimeContext?: string;
}

export type RouteResult =
  | {
      type: "execute";
      action: CapabilityName;
      arguments: JsonRecord;
      confidence?: number;
      provider: RouteProviderName;
      lane?: ModelProviderLane;
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    }
  | {
      type: "respond";
      action: SystemActionName;
      arguments: JsonRecord;
      confidence?: number;
      provider: RouteProviderName;
      lane?: ModelProviderLane;
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    }
  | {
      type: "deny";
      reason: string;
      provider: RouteProviderName;
      lane?: ModelProviderLane;
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    };

export interface FunctionRouterPort {
  route(input: RouteInput): Promise<RouteResult>;
}

export interface AdminActionRouteInput {
  profileName: string;
  text: string;
  enabledActions: AdminActionName[];
  source: LineSource;
}

export type AdminActionRouteResult =
  | {
      type: "execute";
      action: AdminActionName;
      arguments: JsonRecord;
      confidence?: number;
      provider: ModelProviderName;
      lane?: ModelProviderLane;
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    }
  | {
      type: "deny";
      reason: string;
      provider: ModelProviderName | "router";
      lane?: ModelProviderLane;
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    };

export interface AdminActionRouterPort {
  route(input: AdminActionRouteInput): Promise<AdminActionRouteResult>;
}

export interface RouteObserverEvent {
  kind:
    | "route"
    | "function_result"
    | "function_error"
    | "admin_action_route"
    | "admin_action_result"
    | "text_handler"
    | "postback"
    | "admin_command"
    | "rate_limited"
    | "product_event";
  profileName: string;
  sourceType: string;
  requestId?: string;
  supportId?: string;
  durationMs?: number;
  provider?: RouteResult["provider"];
  lane?: ModelProviderLane;
  outcome?: RouteResult["type"];
  action?: CapabilityName | string;
  reason?: string;
  confidence?: number;
  fallbackProvider?: ModelProviderName;
  fallbackReason?: string;
  handler?: string;
  command?: string;
  authorized?: boolean;
  ok?: boolean;
  errorName?: string;
  engagement?: string;
  smallTalkCategory?: string;
  dedup?: string;
  queryHash?: string;
  executionMode?: RetrievalDiagnostics["executionMode"];
  stateAgeBucket?: RetrievalDiagnostics["stateAgeBucket"];
  freshnessStatus?: RetrievalDiagnostics["freshnessStatus"];
  sourceRevision?: RetrievalDiagnostics["sourceRevision"];
  queryFingerprint?: string;
  referenceFingerprint?: string;
  eventName?: string;
  actorFingerprint?: string;
  resultClass?: string;
  latencyBucket?: string;
  clarificationCountBucket?: string;
  retry?: boolean;
  modelCallCount?: number;
  toolCallCount?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  contextEdited?: boolean;
  summarized?: boolean;
  selectedToolNames?: string[];
  finalStatus?: string;
}

export type RouteObserver = (event: RouteObserverEvent) => void | Promise<void>;
