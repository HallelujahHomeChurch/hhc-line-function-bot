export const FUNCTION_NAMES = [
  "find_ppt_slides",
  "query_service_schedule",
  "find_pop_sheet_music"
] as const;

export type FunctionName = (typeof FUNCTION_NAMES)[number];

export type JsonRecord = Record<string, unknown>;

export interface BotProfileConfig {
  name: string;
  webhookPath: string;
  channelSecret: string;
  channelAccessToken: string;
  allowedGroupIds: string[];
  allowedUserIds: string[];
  allowDirectUser: boolean;
  allowRooms: boolean;
  allowedMessageTypes: string[];
  groupRequireWakeWord: boolean;
  wakeKeywords: string[];
  acceptMention: boolean;
  enabledFunctions: FunctionName[];
  adminUserIds?: string[];
  adminDirectOnly?: boolean;
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
    }
  | {
      type: "deny";
      reason: string;
      provider: "ollama" | "keyword" | "router";
    };

export interface FunctionRouterPort {
  route(input: RouteInput): Promise<RouteResult>;
}

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

export interface FunctionExecutionResult {
  ok: boolean;
  replyText: string;
  quickReplies?: QuickReplyItem[];
}

export interface FunctionHandlerContext {
  profile: BotProfileConfig;
  event: LineEvent;
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
}

export interface TextMessageHandler {
  matches(request: TextMessageRequest, context: TextMessageContext): boolean;
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
