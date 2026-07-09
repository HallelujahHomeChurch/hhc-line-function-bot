import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createNotionDatabaseClient } from "../clients/notion.js";
import { createQueryServiceScheduleHandler } from "../functions/query-service-schedule.js";
import { readTimeZone } from "../time-zone.js";
import type { BotProfileConfig, FunctionHandlerContext, NotionConfig } from "../types.js";

const requiredEnvNames = [
  "NOTION_TOKEN",
  "NOTION_SERVICE_DATABASE_ID",
  "NOTION_DATE_PROPERTY",
  "NOTION_MEETING_PROPERTY",
  "NOTION_ROLE_PROPERTY",
  "NOTION_PERSON_PROPERTY"
] as const;

const cli = parseCliArgs(process.argv.slice(2));
const env = loadEnv(cli.envFile);
const notionToken = env.NOTION_TOKEN?.trim() || env.NOTION_API_KEY?.trim() || "";
const missing = requiredEnvNames.filter((name) => {
  if (name === "NOTION_TOKEN") {
    return !notionToken;
  }
  return !env[name]?.trim();
});

if (missing.length > 0) {
  console.error("Missing Notion configuration:");
  for (const name of missing) {
    console.error(name === "NOTION_TOKEN" ? "- NOTION_TOKEN or NOTION_API_KEY" : `- ${name}`);
  }
  console.error("Create a local .env or set these variables before running this check.");
  process.exit(2);
}

const config: NotionConfig = {
  token: notionToken,
  databaseId: required("NOTION_SERVICE_DATABASE_ID"),
  properties: {
    date: required("NOTION_DATE_PROPERTY"),
    meeting: required("NOTION_MEETING_PROPERTY"),
    role: required("NOTION_ROLE_PROPERTY"),
    person: required("NOTION_PERSON_PROPERTY")
  }
};

const query = cli.query || "本週服事";
const notion = createNotionDatabaseClient(config);
const timeZone = readTimeZone(env.TIME_ZONE);
const handler = createQueryServiceScheduleHandler({
  notion,
  databaseId: config.databaseId,
  properties: config.properties,
  timeZone
});

try {
  const pages = await notion.queryDatabase(config.databaseId);
  const propertyStatus = inspectPropertyMapping(pages[0]?.properties ?? {}, config);
  const result = await handler({ query }, handlerContext());

  console.log("Notion API: ok");
  console.log(`Database id: ${mask(config.databaseId)}`);
  console.log(`Rows sampled: ${pages.length}`);
  console.log(`Time zone: ${timeZone}`);
  console.log("Property mapping:");
  for (const status of propertyStatus) {
    console.log(`- ${status.name}: ${status.property} (${status.present ? "present" : "missing"})`);
  }
  console.log(`Function query: ${query}`);
  console.log("Function reply preview:");
  console.log(result.replyText);
  if (result.quickReplies?.length) {
    console.log(`Quick replies: ${result.quickReplies.map((item) => item.label).join(", ")}`);
  }
} catch (error) {
  console.error("Notion check failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

interface CliArgs {
  envFile?: string;
  query: string;
}

function parseCliArgs(args: string[]): CliArgs {
  const queryParts: string[] = [];
  let envFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env-file") {
      envFile = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      envFile = arg.slice("--env-file=".length);
      continue;
    }
    queryParts.push(arg);
  }

  return {
    envFile,
    query: queryParts.join(" ").trim()
  };
}

function loadEnv(envFile?: string): NodeJS.ProcessEnv {
  const loaded: Record<string, string> = {};
  for (const fileName of [envFile, ".env", ".env.local"].filter(Boolean) as string[]) {
    const filePath = resolve(process.cwd(), fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    Object.assign(loaded, parseDotEnv(readFileSync(filePath, "utf8")));
  }
  return { ...loaded, ...process.env };
}

function parseDotEnv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    parsed[key] = unquote(value);
  }
  return parsed;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function required(name: (typeof requiredEnvNames)[number]): string {
  return env[name]?.trim() ?? "";
}

function inspectPropertyMapping(
  properties: Record<string, unknown>,
  config: NotionConfig
): Array<{ name: string; property: string; present: boolean }> {
  return [
    {
      name: "date",
      property: config.properties.date,
      present: hasConfiguredProperty(properties, config.properties.date)
    },
    {
      name: "meeting",
      property: config.properties.meeting,
      present: hasConfiguredProperty(properties, config.properties.meeting)
    },
    {
      name: "role",
      property: config.properties.role,
      present: hasConfiguredProperty(properties, config.properties.role)
    },
    {
      name: "person",
      property: config.properties.person,
      present: hasConfiguredProperty(properties, config.properties.person)
    }
  ];
}

function hasConfiguredProperty(
  properties: Record<string, unknown>,
  configuredKey: string
): boolean {
  if (configuredKey in properties) {
    return true;
  }

  return Object.values(properties).some(
    (property) =>
      property &&
      typeof property === "object" &&
      "id" in property &&
      String((property as { id?: unknown }).id) === configuredKey
  );
}

function handlerContext(): FunctionHandlerContext {
  const profile: BotProfileConfig = {
    name: "notion-check",
    webhookPath: "/api/line/webhook/check",
    channelSecret: "placeholder",
    channelAccessToken: "placeholder",
    allowDirectUser: true,
    allowRooms: false,
    allowedMessageTypes: ["text"],
    groupRequireWakeWord: false,
    wakeKeywords: ["小哈"],
    acceptMention: true,
    enabledFunctions: ["query_service_schedule"],
    allowedProviders: ["ollama"],
    allowSubscriptionProviders: false
  };

  return {
    profile,
    event: {
      type: "message",
      replyToken: "reply-token",
      source: { type: "user", userId: "notion-check" },
      message: { type: "text", text: query }
    }
  };
}

function mask(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
