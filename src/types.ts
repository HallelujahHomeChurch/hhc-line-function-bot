import type { LineReplyOptions } from "./application/contracts/function-execution.js";

export type {
  AdminActionRouteInput,
  AdminActionRouteResult,
  AdminActionRouterPort,
  FunctionRouterPort,
  RouteInput,
  RouteObserver,
  RouteObserverEvent,
  RouteResult
} from "./application/contracts/routing.js";
export type {
  AdminCommandContext,
  AdminHandler,
  AdminHandlerRegistry,
  AgentResourceReference,
  AgentResourceStorage,
  AgentResourceType,
  ControlledTurnStage,
  FunctionExecutionResult,
  FunctionHandler,
  FunctionHandlerContext,
  FunctionRegistry,
  LineReplyOptions,
  PostbackContext,
  PostbackHandler,
  PostbackHandlerRegistry,
  PostbackRequest,
  QuickReplyItem,
  TextMessageContext,
  TextMessageHandler,
  TextMessageHandlerRegistry,
  TextMessageRequest
} from "./application/contracts/function-execution.js";

export const FUNCTION_NAMES = [
  "find_ppt_slides",
  "query_schedule",
  "query_knowledge",
  "save_schedule",
  "find_sheet_music",
  "find_resource",
  "query_wikipedia",
  "save_memory",
  "save_resource",
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
  "function_scope_grant",
  "function_scope_revoke",
  "function_scope_list",
  "knowledge_source_add",
  "knowledge_source_list",
  "knowledge_source_sync",
  "knowledge_source_enable",
  "knowledge_source_disable",
  "knowledge_source_remove"
] as const;

export type AdminActionName = (typeof ADMIN_ACTION_NAMES)[number];

export type ActionName = FunctionName | SystemActionName | AdminActionName;

export type JsonRecord = Record<string, unknown>;

export const MODEL_PROVIDER_NAMES = ["deepseek"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];
export type RouteProviderName = ModelProviderName | "keyword" | "router";

export const AGENT_PLAN_DISPOSITIONS = [
  "execute",
  "continue",
  "refine",
  "advance",
  "select",
  "switch",
  "clarify",
  "chat",
  "deny"
] as const;

export type AgentPlanDisposition = (typeof AGENT_PLAN_DISPOSITIONS)[number];
export type AgentPlanPrimitive = string | number | boolean;
export type AgentPlanValue = AgentPlanPrimitive | AgentPlanPrimitive[];
export type AgentPlanRecord = Record<string, AgentPlanValue>;

export interface AgentPlanProposal {
  version: 1;
  disposition: AgentPlanDisposition;
  capability?: FunctionName;
  arguments: AgentPlanRecord;
  references?: AgentPlanRecord;
  confidence: number;
}

export type AgentPlannerAttemptStatus = "accepted" | "invalid_output" | "timeout" | "unavailable";

export type AgentPlannerAttemptReason =
  | "valid_proposal"
  | "invalid_json"
  | "invalid_schema"
  | "candidate_not_allowed"
  | "timeout"
  | "provider_unavailable";

export interface AgentPlannerAttemptDiagnostic {
  provider: ModelProviderName;
  status: AgentPlannerAttemptStatus;
  reason: AgentPlannerAttemptReason;
  durationMs: number;
  candidateCount: number;
}

export interface ProposedAgentPlan extends AgentPlanProposal {
  status: "proposed";
  provider: ModelProviderName;
  attempts: AgentPlannerAttemptDiagnostic[];
}

export interface NoAgentPlan {
  status: "no_plan";
  reasonCode: "no_candidates" | "providers_unavailable" | "invalid_output";
  attempts: AgentPlannerAttemptDiagnostic[];
}

export type AgentPlannerResult = ProposedAgentPlan | NoAgentPlan;

export const MODEL_PROVIDER_LANE_NAMES = [
  "function_routing",
  "admin_routing",
  "memory_routing",
  "smart_talk",
  "general_agent",
  "context_compression",
  "web_summarization"
] as const;

export type ModelProviderLane = (typeof MODEL_PROVIDER_LANE_NAMES)[number];

export interface ProviderLanePolicy {
  primary: ModelProviderName;
  fallback?: ModelProviderName;
}

export type ProviderPolicy = Record<ModelProviderLane, ProviderLanePolicy>;

export interface ProviderCapabilities {
  structuredOutput: boolean;
  smartTalk: boolean;
  largeContext: boolean;
  requiresExternalAuth: boolean;
  subscriptionBased: boolean;
  remoteApi: boolean;
}

export type DirectAccessPolicy = "managed" | "public" | "blocked";

export type GroupAccessPolicy = "managed" | "blocked";

export interface RegistrationConfig {
  enabled: boolean;
}

export interface SmallTalkConfig {
  mode: "template" | "llm";
  maxChars: number;
  prompting?: SmallTalkPromptingConfig;
}

export interface SmallTalkPromptingConfig {
  personaPrompt?: string;
  conversationRulesPrompt?: string;
  safetyRulesPrompt?: string;
  formatRulesPrompt?: string;
}

export interface GeneralAgentConfig {
  enabled: boolean;
  conversationWindowSeconds: number;
}

export interface ControlledAgentConfig {
  maxCandidates: number;
  minPlannerConfidence: number;
}

export interface MeetingWindowRule {
  key: string;
  aliases: string[];
  weekdays?: number[];
  start: string;
  end: string;
}

export interface SchedulePolicyConfig {
  meetingWindows: MeetingWindowRule[];
  domains: ScheduleDomainConfig[];
}

export type ScheduleDomainInputSchema = "assignment_rows_v1" | "family_rotation_v1";

export type ScheduleDomainBinding =
  | {
      kind: "canonical";
      sourceKeys: string[];
      allowLiveFallback: boolean;
    }
  | {
      kind: "saved_schedule";
      scheduleType: string;
    };

export interface ScheduleDomainConfig {
  key: string;
  displayName: string;
  aliases: string[];
  routingHints: string[];
  schemaVersion: number;
  inputSchema: ScheduleDomainInputSchema;
  occurrencePolicy: string;
  binding: ScheduleDomainBinding;
  origins: Array<"notion" | "line">;
  writePolicy: {
    mode: "read_only" | "replace_add";
    allowedOperations: Array<"replace" | "add_entry">;
  };
  priority: number;
  revision: string;
  freshnessPolicy: {
    maxAgeSeconds: number;
    staleBehavior: "reject" | "allow_with_notice";
  };
}

export interface LongRunningJobsConfig {
  enabled: boolean;
  inlineReplyTimeoutMs: number;
  resultTtlMinutes: number;
}

export interface AgentRuntimeConfig {
  taskFrameSeconds: number;
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
  allowedProviders: ModelProviderName[];
  allowSubscriptionProviders: boolean;
  providerPolicy?: ProviderPolicy;
  controlledAgent: ControlledAgentConfig;
  agentRuntime?: AgentRuntimeConfig;
  schedulePolicy: SchedulePolicyConfig;
  generalAgent?: GeneralAgentConfig;
  longRunningJobs?: LongRunningJobsConfig;
}

export interface LlmConfig {
  provider?: ModelProviderName;
  deepseekApiKey?: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekTimeoutMs: number;
  contextWindowTokens?: number;
  runtimeContextBudgetTokens?: number;
  contextCompressionThresholdRatio?: number;
  generalMaxOutputTokens?: number;
  routeMaxOutputTokens?: number;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveId: string;
  pptFolderItemId: string;
  sheetMusicAllowedExtensions: string[];
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

export interface WikipediaConfig {
  userAgent: string;
  timeoutMs: number;
}

export interface WebSearchConfig {
  searxngBaseUrl?: string;
  timeoutMs: number;
}

export interface AppConfig {
  serviceName: string;
  host: string;
  port: number;
  timeZone: string;
  healthPath: string;
  readyPath?: string;
  maxBodyBytes: number;
  attachments: AttachmentConfig;
  externalResources: ExternalResourceConfig;
  profiles: BotProfileConfig[];
  llm: LlmConfig;
  knowledge?: KnowledgeConfig;
  graph?: GraphConfig;
  notion?: NotionConfig;
  wikipedia?: WikipediaConfig;
  webSearch?: WebSearchConfig;
  redis?: RedisConfig;
  database?: DatabaseConfig;
  access?: AccessConfig;
  rateLimit?: RateLimitConfig;
  lastErrors?: LastErrorsConfig;
  observability?: ObservabilityConfig;
}

export interface ObservabilityConfig {
  hmacKey?: string;
}

export interface KnowledgeConfig {
  notionToken: string;
  embedding: {
    provider: "azure_openai";
    apiKey: string;
    endpoint: string;
    deployment: "text-embedding-3-small";
    apiVersion: "2024-10-21";
    model: "text-embedding-3-small";
    dimensions: 1536;
    batchSize: number;
    timeoutMs: number;
  };
}

export interface AttachmentConfig {
  maxBytes: number;
  lineDownloadTimeoutMs: number;
  scanQueueUrl?: string;
}

export interface ExternalResourceConfig {
  downloadTimeoutMs: number;
  maxRedirects: number;
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

export type DependencyName = "postgres" | "redis" | "embedding" | "graph" | "notion";

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
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
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
  fileName?: string;
  fileSize?: number;
  mention?: {
    mentionees?: Array<{
      type?: string;
      userId?: string;
      isSelf?: boolean;
    }>;
  };
}

export interface ChatProviderRequest {
  prompt: string;
  profileName: string;
  text: string;
  enabledFunctions: FunctionName[];
  signal?: AbortSignal;
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
  category?: SmallTalkCategory;
  maxChars?: number;
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

export interface DriveItem {
  id: string;
  driveId?: string;
  name: string;
  webUrl?: string;
  path?: string;
  isFolder?: boolean;
  deleted?: boolean;
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
  listFolderDelta?(
    driveId: string,
    folderItemId: string,
    deltaLink?: string
  ): Promise<{ items: DriveItem[]; deltaLink: string }>;
  getItemByPath?(driveId: string, path: string): Promise<DriveItem | undefined>;
  getItemById?(driveId: string, itemId: string): Promise<DriveItem | undefined>;
  createSharingLink(driveId: string, itemId: string, expirationDateTime: string): Promise<string>;
  uploadFile?(
    driveId: string,
    parentItemId: string,
    fileName: string,
    data: Uint8Array,
    contentType: string
  ): Promise<DriveItem>;
  deleteItem?(driveId: string, itemId: string): Promise<void>;
}

export type GraphReferenceUnavailableReason =
  "validator_unavailable" | "item_missing" | "item_deleted" | "validation_failed";

export type ValidatedSharingLinkResult =
  | { status: "available"; item: DriveItem; link: string }
  | {
      status: "unavailable";
      reason: GraphReferenceUnavailableReason;
      item?: undefined;
      link?: undefined;
    };

export interface LineContent {
  data: Uint8Array;
  contentType?: string;
}

export interface BinaryReadLimits {
  maxBytes: number;
  timeoutMs: number;
}

export interface LineContentClient {
  getMessageContent(
    messageId: string,
    profile: Pick<BotProfileConfig, "name" | "channelAccessToken">,
    limits: BinaryReadLimits
  ): Promise<LineContent>;
}

export interface WebSearchInput {
  query: string;
  language?: string;
  limit?: number;
}

export interface WebSearchResult {
  title: string;
  snippet?: string;
  url: string;
}

export interface WebSearchClient {
  search(input: WebSearchInput): Promise<WebSearchResult[]>;
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
