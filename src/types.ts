export const FUNCTION_NAMES = [
  "find_ppt_slides",
  "query_service_schedule",
  "find_pop_sheet_music"
] as const;

export type FunctionName = (typeof FUNCTION_NAMES)[number];

export const SYSTEM_ACTION_NAMES = ["introduce_bot"] as const;

export type SystemActionName = (typeof SYSTEM_ACTION_NAMES)[number];

export type JsonRecord = Record<string, unknown>;

export type DirectAccessPolicy = "managed" | "public" | "blocked";

export type GroupAccessPolicy = "managed" | "blocked";

export interface RegistrationConfig {
  enabled: boolean;
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
}

export interface LlmConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaKeepAlive?: string | number;
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
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
}

export interface LastErrorsConfig {
  maxEntries: number;
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
}

export type RouteResult =
  | {
      type: "execute";
      action: FunctionName;
      arguments: JsonRecord;
      confidence?: number;
      provider: "ollama" | "keyword";
      fallbackProvider?: "ollama";
      fallbackReason?: string;
    }
  | {
      type: "respond";
      action: SystemActionName;
      arguments: JsonRecord;
      confidence?: number;
      provider: "ollama" | "keyword";
      fallbackProvider?: "ollama";
      fallbackReason?: string;
    }
  | {
      type: "deny";
      reason: string;
      provider: "ollama" | "keyword" | "router";
      fallbackProvider?: "ollama";
      fallbackReason?: string;
    };

export interface FunctionRouterPort {
  route(input: RouteInput): Promise<RouteResult>;
}

export interface RouteObserverEvent {
  kind:
    | "route"
    | "function_result"
    | "function_error"
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
  fallbackProvider?: "ollama";
  fallbackReason?: string;
  handler?: string;
  command?: string;
  authorized?: boolean;
  ok?: boolean;
  errorName?: string;
}

export type RouteObserver = (event: RouteObserverEvent) => void | Promise<void>;

export interface ChatProviderRequest {
  prompt: string;
  profileName: string;
  text: string;
  enabledFunctions: FunctionName[];
}

export interface ChatProvider {
  completeJson(request: ChatProviderRequest): Promise<string>;
}

export interface LineReplyClient {
  replyText(replyToken: string, text: string, options?: LineReplyOptions): Promise<void>;
}

export interface LineIdentityClient {
  getUserDisplayName(userId: string): Promise<string | undefined>;
  getGroupDisplayName(groupId: string): Promise<string | undefined>;
}

export interface FunctionExecutionResult {
  ok: boolean;
  replyText: string;
  quickReplies?: QuickReplyItem[];
}

export interface FunctionHandlerContext {
  profile: BotProfileConfig;
  event: LineEvent;
  requestId?: string;
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
