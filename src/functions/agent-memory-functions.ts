import { retrieveMemoryArgumentsSchema, saveMemoryArgumentsSchema } from "../function-arguments.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type { FunctionHandler } from "../types.js";
import type { SessionStore } from "../state/session-store.js";
import { storePendingFunctionQuery } from "./pending-function.js";
import { randomUUID } from "node:crypto";

const TEXT_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentMemoryFunctionOptions {
  memoryStore: AgentMemoryStore;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}

export function createSaveMemoryHandler(options: AgentMemoryFunctionOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  return async (rawArgs, context) => {
    const args = saveMemoryArgumentsSchema.parse(rawArgs);
    const content = (args.content || args.query || "").trim();
    if (args.cancel || isCancelText(args.query)) {
      return { ok: true, replyText: "好，我先不保存。" };
    }
    if (!content) {
      return { ok: true, replyText: "請直接告訴我要記住的內容。" };
    }
    const title = args.title?.trim() || inferTitle(content);
    const visibility =
      context.event.source.type === "group" && args.visibility === "group" ? "group" : "private";
    if (!args.confirm) {
      if (options.sessionStore) {
        await storePendingFunctionQuery({
          sessionStore: options.sessionStore,
          requestId: requestIdFactory(),
          action: "save_memory",
          arguments: { title, content, query: args.query, visibility, confirm: true },
          context,
          now: now()
        });
      }
      return {
        ok: true,
        replyText: [
          "請確認要記住這段資訊：",
          `名稱：${title}`,
          `可見範圍：${visibility === "group" ? "群組共用" : "僅你可查"}`,
          "保存期限：30 天",
          "要保存嗎？"
        ].join("\n"),
        quickReplies: [
          { label: "保存", action: { type: "message", label: "保存", text: "保存" } },
          { label: "取消", action: { type: "message", label: "取消", text: "取消" } }
        ]
      };
    }
    const saved = await options.memoryStore.saveTextMemory({
      profileName: context.profile.name,
      source: context.event.source,
      createdBy: context.event.source.userId,
      visibility,
      title,
      content,
      query: args.query,
      expiresAt: new Date(now().getTime() + TEXT_MEMORY_TTL_MS).toISOString()
    });
    return {
      ok: true,
      writePhase: "commit",
      replyText: "已記住，之後你可以請我查這段資訊。",
      agentResult: {
        status: "success",
        replyText: "資訊已保存。",
        anchors: { memoryId: saved.id },
        entities: [{ type: "memory", key: saved.id, label: "已保存資訊" }]
      }
    };
  };
}

function isCancelText(value: string | undefined): boolean {
  return /^(取消|不要|先不要|不用)$/u.test(value?.trim() ?? "");
}

export function createRetrieveMemoryHandler(options: AgentMemoryFunctionOptions): FunctionHandler {
  return async (rawArgs, context) => {
    const args = retrieveMemoryArgumentsSchema.parse(rawArgs);
    const memories = await options.memoryStore.searchTextMemories({
      profileName: context.profile.name,
      source: context.event.source,
      requesterUserId: context.event.source.userId,
      query: args.query,
      limit: 3
    });
    if (memories.length === 0) {
      return {
        ok: true,
        replyText: "我目前找不到符合的記憶。",
        agentResult: { status: "not_found", replyText: "我目前找不到符合的記憶。" }
      };
    }
    return {
      ok: true,
      replyText: ["我找到這些記住的資訊：", ...memories.map(formatTextMemory)].join("\n"),
      responseData: {
        kind: "memory",
        fields: {
          ...(memories.length === 1
            ? { title: memories[0].title ?? "已保存資訊", answer: memories[0].content }
            : {})
        },
        records: memories.map((memory) => ({
          title: memory.title ?? "已保存資訊",
          answer: memory.content
        }))
      },
      agentResult: {
        status: "success",
        replyText: "記憶查詢完成。",
        entities: memories.map(({ id }) => ({ type: "memory", key: id, label: "已保存資訊" })),
        evidence: memories.map(({ id }) => ({
          kind: "saved_memory",
          reference: { memoryId: id }
        })),
        supportedOperations: []
      }
    };
  };
}

function inferTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 20) || "記憶";
}

function formatTextMemory(memory: { id: string; title?: string; content: string }): string {
  const title = memory.title?.trim() || memory.content.slice(0, 16);
  return `- ${title} (${memory.id})\n${memory.content}`;
}
