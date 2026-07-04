export const FUNCTION_NAMES = ["find_ppt_slides", "query_service_schedule"] as const;

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
}

export interface LlmConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaKeepAlive?: string | number;
  timeoutMs: number;
  azureFallbackEnabled: boolean;
}

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveId: string;
  pptFolderItemId: string;
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
  healthPath: string;
  maxBodyBytes: number;
  profiles: BotProfileConfig[];
  llm: LlmConfig;
  azureOpenAI?: AzureOpenAIConfig;
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
  postback?: unknown;
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
      provider: "ollama" | "azure_openai";
    }
  | {
      type: "deny";
      reason: string;
      provider: "ollama" | "azure_openai" | "router";
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
  replyText(replyToken: string, text: string): Promise<void>;
}

export interface FunctionExecutionResult {
  ok: boolean;
  replyText: string;
}

export type FunctionHandler = (args: JsonRecord) => Promise<FunctionExecutionResult>;

export type FunctionRegistry = Partial<Record<FunctionName, FunctionHandler>>;

export interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
}

export interface GraphDriveClient {
  listFolderChildren(driveId: string, folderItemId: string): Promise<DriveItem[]>;
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
