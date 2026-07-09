export const FUNCTION_NAMES = [
  "find_ppt_slides",
  "query_service_schedule",
  "find_pop_sheet_music",
  "save_memory",
  "retrieve_memory"
] as const;

export type FunctionName = (typeof FUNCTION_NAMES)[number];

export const SYSTEM_ACTION_NAMES = ["introduce_bot", "small_talk"] as const;

export type SystemActionName = (typeof SYSTEM_ACTION_NAMES)[number];

export const SMALL_TALK_CATEGORIES = [
  "greeting",
  "wellbeing",
  "thanks",
  "encouragement",
  "reassurance",
  "persona",
  "light_joke"
] as const;

export type SmallTalkCategory = (typeof SMALL_TALK_CATEGORIES)[number];

export const ADMIN_ACTION_NAMES = [
  "invite_code_create",
  "web_allowlist_list",
  "web_allowlist_add",
  "function_scope_grant",
  "function_scope_revoke",
  "function_scope_list"
] as const;

export type AdminActionName = (typeof ADMIN_ACTION_NAMES)[number];

export type ActionName = FunctionName | SystemActionName | AdminActionName;

export type JsonRecord = Record<string, unknown>;

export const MODEL_PROVIDER_NAMES = ["ollama", "codex_app_server"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];
export type RouteProviderName = ModelProviderName | "keyword" | "router";

export interface ProviderCapabilities {
  structuredOutput: boolean;
  smartTalk: boolean;
  largeContext: boolean;
  requiresExternalAuth: boolean;
  subscriptionBased: boolean;
}

export type DirectAccessPolicy = "managed" | "public" | "blocked";

export type GroupAccessPolicy = "managed" | "blocked";

export interface RegistrationConfig {
  enabled: boolean;
}

export interface SmallTalkConfig {
  mode: "template" | "llm";
  maxChars: number;
}

export interface GeneralAgentConfig {
  enabled: boolean;
  conversationWindowSeconds: number;
}

export interface LongRunningJobsConfig {
  enabled: boolean;
  inlineReplyTimeoutMs: number;
  resultTtlMinutes: number;
}

export interface BotProfileConfig {
  name: string;
  webhookPath: string;
  channelSecret: string;
  channelAccessToken: string;
  allowDirectUser: boolean;
  allowRooms: boolean;
  allowedMessageTypes: string[];
  groupRequireWakeWord: boolean;
  wakeKeywords: string[];
  acceptMention: boolean;
  enabledFunctions: FunctionName[];
  adminUserId?: string;
  adminDirectOnly?: boolean;
  directAccessPolicy?: DirectAccessPolicy;
  groupAccessPolicy?: GroupAccessPolicy;
  registration?: RegistrationConfig;
  smallTalk?: SmallTalkConfig;
  llmProvider?: ModelProviderName;
  allowedProviders: ModelProviderName[];
  allowSubscriptionProviders: boolean;
  generalAgent?: GeneralAgentConfig;
  longRunningJobs?: LongRunningJobsConfig;
}

export interface LlmConfig {
  provider?: ModelProviderName;
  fallbackProvider?: ModelProviderName;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaKeepAlive?: string | number;
  codexAppServerCommand?: string;
  codexAppServerArgs?: string[];
  codexHome?: string;
  providerAuthHome?: string;
  codexAuthIssuer?: string;
  codexLoginClientId?: string;
  codexDeviceLoginTtlMs?: number;
  codexModel?: string;
  codexModelProvider?: string;
  contextWindowTokens?: number;
  runtimeContextBudgetTokens?: number;
  contextCompressionThresholdRatio?: number;
  generalMaxOutputTokens?: number;
  routeMaxOutputTokens?: number;
  timeoutMs: number;
  keywordFallbackEnabled: boolean;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveId: string;
  pptFolderItemId: string;
  sheetMusicFolderItemId?: string;
  sheetMusicFolderPath: string;
  sheetMusicAllowedExtensions: string[];
  sheetMusicRecursive: boolean;
  allowedExtensions: string[];
  defaultIncludePdf: boolean;
  linkType: "view" | "edit" | "embed";
  linkScope: "anonymous" | "organization";
}

export interface NotionConfig {
  token: string;
  databaseId: string;
  properties: {
    date: string;
    meeting: string;
    role: string;
    person: string;
  };
}

export interface AppConfig {
  serviceName: string;
  host: string;
  port: number;
  timeZone: string;
  healthPath: string;
  readyPath?: string;
  maxBodyBytes: number;
  profiles: BotProfileConfig[];
  llm: LlmConfig;
  graph?: GraphConfig;
  notion?: NotionConfig;
  redis?: RedisConfig;
  database?: DatabaseConfig;
  access?: AccessConfig;
  rateLimit?: RateLimitConfig;
  lastErrors?: LastErrorsConfig;
}

export interface RedisConfig {
  url: string;
  keyPrefix: string;
}

export interface DatabaseConfig {
  url: string;
  ssl: boolean;
}

export interface AccessConfig {
  registrationInviteCodeTtlMinutes: number;
  confirmationTtlMinutes: number;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
}

export interface LastErrorsConfig {
  maxEntries: number;
}

export type DependencyName = "postgres" | "redis" | "ollama" | "graph" | "notion";

export type DependencyStatusValue = "ok" | "degraded" | "missing" | "error";

export interface DependencyStatus {
  configured: boolean;
  status: DependencyStatusValue;
  latencyMs?: number;
  message?: string;
}

export interface NamedDependencyStatus extends DependencyStatus {
  name: DependencyName;
}

export interface PublicReadinessResult {
  service: string;
  status: "ok" | "error";
  database: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
  };
}

export interface AppDiagnostics {
  checkPublicReadiness(): Promise<PublicReadinessResult>;
  formatAdminDiagnostics(): Promise<string>;
}

export interface LineWebhookPayload {
  destination?: string;
  events: LineEvent[];
}

export interface LineEvent {
  type: string;
  replyToken?: string;
  source: LineSource;
  message?: LineMessage;
  postback?: LinePostback;
}

export interface LinePostback {
  data?: string;
  params?: Record<string, string>;
}

export interface LineSource {
  type: "group" | "user" | "room" | string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineMessage {
  type: string;
  id?: string;
  text?: string;
  mention?: {
    mentionees?: Array<{
      type?: string;
      userId?: string;
      isSelf?: boolean;
    }>;
  };
}

export interface RouteInput {
  profileName: string;
  text: string;
  enabledFunctions: FunctionName[];
  source: LineSource;
  runtimeContext?: string;
}

export type RouteResult =
  | {
      type: "execute";
      action: FunctionName;
      arguments: JsonRecord;
      confidence?: number;
      provider: ModelProviderName | "keyword";
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    }
  | {
      type: "respond";
      action: SystemActionName;
      arguments: JsonRecord;
      confidence?: number;
      provider: ModelProviderName | "keyword";
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    }
  | {
      type: "deny";
      reason: string;
      provider: RouteProviderName;
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
      fallbackProvider?: ModelProviderName;
      fallbackReason?: string;
    }
  | {
      type: "deny";
      reason: string;
      provider: ModelProviderName | "router";
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
    | "rate_limited";
  profileName: string;
  sourceType: string;
  requestId?: string;
  durationMs?: number;
  provider?: RouteResult["provider"];
  outcome?: RouteResult["type"];
  action?: FunctionName | string;
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
}

export type RouteObserver = (event: RouteObserverEvent) => void | Promise<void>;

export interface ChatProviderRequest {
  prompt: string;
  profileName: string;
  text: string;
  enabledFunctions: FunctionName[];
}

export interface ChatProvider {
  providerName?: ModelProviderName;
  capabilities?: ProviderCapabilities;
  providerNameForProfile?(profileName: string): ModelProviderName;
  completeJson(request: ChatProviderRequest): Promise<string>;
}

export interface TextGenerationRequest {
  prompt: string;
  profileName: string;
  text: string;
  category: SmallTalkCategory;
  maxChars: number;
}

export interface TextGenerationProvider {
  providerName?: ModelProviderName;
  capabilities?: ProviderCapabilities;
  providerNameForProfile?(profileName: string): ModelProviderName;
  completeText(request: TextGenerationRequest): Promise<string>;
}

export interface LineReplyClient {
  replyText(replyToken: string, text: string, options?: LineReplyOptions): Promise<void>;
}

export interface LineIdentityClient {
  getUserDisplayName(userId: string): Promise<string | undefined>;
  getGroupDisplayName(groupId: string): Promise<string | undefined>;
}

export type AgentResourceType = "ppt_slide" | "sheet_music";

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
}

export interface FunctionExecutionResult {
  ok: boolean;
  replyText: string;
  quickReplies?: QuickReplyItem[];
  agentResource?: AgentResourceReference;
}

export interface FunctionHandlerContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId?: string;
  requesterDisplayName?: string;
}

export type FunctionHandler = (
  args: JsonRecord,
  context: FunctionHandlerContext
) => Promise<FunctionExecutionResult>;

export type FunctionRegistry = Partial<Record<FunctionName, FunctionHandler>>;

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

export type PostbackHandlerRegistry = Record<string, PostbackHandler>;

export interface TextMessageRequest {
  text: string;
}

export interface TextMessageContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId?: string;
  requesterDisplayName?: string;
}

export interface TextMessageHandler {
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

export interface DriveItem {
  id: string;
  driveId?: string;
  name: string;
  webUrl?: string;
  path?: string;
  isFolder?: boolean;
  remoteItem?: {
    id?: string;
    name?: string;
    parentReference?: {
      driveId?: string;
      path?: string;
    };
  };
}

export interface GraphDriveClient {
  listFolderChildren(driveId: string, folderItemId: string): Promise<DriveItem[]>;
  listFolderFilesRecursive?(driveId: string, folderItemId: string): Promise<DriveItem[]>;
  getItemByPath?(driveId: string, path: string): Promise<DriveItem | undefined>;
  createSharingLink(driveId: string, itemId: string, expirationDateTime: string): Promise<string>;
}

export interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
}

export interface NotionDatabaseClient {
  queryDatabase(databaseId: string, query?: JsonRecord): Promise<NotionPage[]>;
}

export function isFunctionName(value: string): value is FunctionName {
  return (FUNCTION_NAMES as readonly string[]).includes(value);
}

export function isSystemActionName(value: string): value is SystemActionName {
  return (SYSTEM_ACTION_NAMES as readonly string[]).includes(value);
}

export function isAdminActionName(value: string): value is AdminActionName {
  return (ADMIN_ACTION_NAMES as readonly string[]).includes(value);
}
