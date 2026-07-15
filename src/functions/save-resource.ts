import { randomUUID } from "node:crypto";

import { saveResourceArgumentsSchema } from "../function-arguments.js";
import type { AgentMemoryStore } from "../agent/memory-store.js";
import type { FunctionHandler } from "../types.js";
import type { SessionStore } from "../state/session-store.js";
import { storePendingFunctionQuery } from "./pending-function.js";

const RESOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SaveResourceFunctionOptions {
  memoryStore: AgentMemoryStore;
  sessionStore?: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}

export function createSaveResourceHandler(options: SaveResourceFunctionOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return async (rawArgs, context) => {
    const args = saveResourceArgumentsSchema.parse(rawArgs);
    const url = parseHttpsUrl(args.url);
    if (args.cancel || isCancelText(args.url)) {
      return { ok: true, replyText: "好，我先不保存。" };
    }
    if (!url) {
      return { ok: true, replyText: "請提供有效的 HTTPS 連結。" };
    }
    if (!args.resourceType) {
      return { ok: true, replyText: "這是投影片還是歌譜？" };
    }
    const title = args.title?.trim();
    if (!title) {
      return { ok: true, replyText: "請提供這份資源的名稱。" };
    }
    const visibility = args.visibility ?? "private";

    if (!args.confirm) {
      if (options.sessionStore) {
        await storePendingFunctionQuery({
          sessionStore: options.sessionStore,
          requestId: requestIdFactory(),
          action: "save_resource",
          arguments: {
            url: url.toString(),
            resourceType: args.resourceType,
            title,
            description: args.description?.trim(),
            visibility,
            confirm: true
          },
          context,
          now: now()
        });
      }
      return {
        ok: true,
        replyText: [
          "請確認要保存這份連結資源：",
          `名稱：${title}`,
          `類型：${args.resourceType === "ppt_slide" ? "投影片" : "歌譜"}`,
          `可見範圍：${visibility === "group" ? "群組共用" : "僅你可查"}`,
          "要保存嗎？"
        ].join("\n"),
        quickReplies: [
          { label: "保存", action: { type: "message", label: "保存", text: "保存" } },
          { label: "取消", action: { type: "message", label: "取消", text: "取消" } }
        ]
      };
    }

    const saved = await options.memoryStore.recordResource({
      profileName: context.profile.name,
      source: context.event.source,
      createdBy: context.event.source.userId,
      visibility,
      resourceType: args.resourceType,
      title,
      query: title,
      storage: {
        provider: "external_link",
        url: url.toString(),
        description: args.description?.trim()
      },
      expiresAt: new Date(now().getTime() + RESOURCE_TTL_MS).toISOString()
    });
    return {
      ok: true,
      writePhase: "commit",
      replyText: `已保存：${title}`,
      agentResult: {
        status: "success",
        replyText: "資源已保存。",
        anchors: {
          resourceId: saved.id,
          resourceKind: args.resourceType,
          title
        },
        entities: [{ type: "resource", key: saved.id, label: "已保存資源" }]
      }
    };
  };
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function isCancelText(value: string): boolean {
  return /^(取消|不要|先不要|不用)$/u.test(value.trim());
}
