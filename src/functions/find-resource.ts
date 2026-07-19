import { searchCatalogWithFreshness } from "../catalog/retrieval.js";
import { catalogSourceAllowsRead, type CatalogStore } from "../catalog/store.js";
import { findResourceArgumentsSchema } from "../function-arguments.js";
import type { FunctionExecutionResult, FunctionHandler, GraphDriveClient } from "../types.js";
import { createValidatedSharingLink } from "./validated-sharing-link.js";

const LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface FindResourceOptions {
  catalog: CatalogStore;
  graph: GraphDriveClient;
  allowedItemKinds?: string[];
  allowedSourceKeys?: string[];
  now?: () => Date;
}

export function createFindResourceHandler(options: FindResourceOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());

  return async (rawArgs, context) => {
    const args = findResourceArgumentsSchema.parse(rawArgs);
    const query = args.query.trim();
    if (!query && !args.resourceId) {
      return {
        ok: true,
        replyText: "請告訴我要查什麼教會資料，例如：週報音檔、文件名稱或關鍵字。",
        agentResult: {
          status: "ambiguous",
          replyText: "請告訴我要查什麼教會資料。",
          clarification: { prompt: "請告訴我要查什麼教會資料。" }
        }
      };
    }

    const itemKinds = [
      ...(options.allowedItemKinds ?? []),
      ...(args.itemKind ? [args.itemKind] : [])
    ];
    const limit = args.limit ?? 5;
    const retrieval = await searchCatalogWithFreshness({
      catalog: options.catalog,
      now: now(),
      search: {
        profileName: context.profile.name,
        itemIds: args.resourceId ? [args.resourceId] : undefined,
        query: args.resourceId ? undefined : query,
        itemKinds: itemKinds.length ? itemKinds : undefined,
        domains: args.domain ? [args.domain] : undefined,
        allowedSourceKeys: options.allowedSourceKeys,
        limit: Math.max(limit, 20)
      }
    });
    const items = retrieval.items
      .filter((item) =>
        catalogSourceAllowsRead(item.source, [context.profile.name, "find_resource"])
      )
      .slice(0, limit);

    if (items.length === 0) {
      if (retrieval.items.length === 0 && retrieval.status !== "not_found") {
        const replyText = "目前無法確認教會資料是否為最新，請稍後再試。";
        return {
          ok: true,
          replyText,
          agentResult: { status: "unavailable", replyText }
        };
      }
      return {
        ok: true,
        replyText: "查不到符合的教會資料。",
        agentResult: { status: "not_found", replyText: "查不到符合的教會資料。" }
      };
    }

    if (items.length > 1) {
      return {
        ok: true,
        replyText: [
          "找到多筆資料，請再縮小關鍵字：",
          ...items.map((item) => `- ${item.title}`)
        ].join("\n"),
        agentResult: {
          status: "ambiguous",
          replyText: "找到多筆教會資料，請縮小關鍵字。",
          entities: items.map((item) => ({
            type: "resource",
            key: item.id,
            label: "教會資料"
          })),
          clarification: { prompt: "找到多筆教會資料，請縮小關鍵字。" }
        }
      };
    }

    const result = await createCatalogItemReply(options.graph, items[0], now());
    if (retrieval.status === "stale_allowed") {
      return { ...result, replyText: `${result.replyText}\n資料可能不是最新版本。` };
    }
    return result;
  };
}

async function createCatalogItemReply(
  graph: GraphDriveClient,
  item: Awaited<ReturnType<CatalogStore["searchItems"]>>[number],
  now: Date
): Promise<FunctionExecutionResult> {
  if (item.storageRef.provider === "external_link") {
    return {
      ok: true,
      replyText: [item.title, item.storageRef.url].join("\n"),
      responseData: {
        kind: "resource",
        fields: { title: item.title, link: item.storageRef.url }
      },
      agentResult: catalogItemEnvelope(item.id, { resourceId: item.id })
    };
  }

  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
  const current = await createValidatedSharingLink({
    graph,
    driveId: item.storageRef.driveId,
    itemId: item.storageRef.itemId,
    expiresAt
  });
  if (!current.link) {
    const replyText = "這份資料已不存在或沒有權限，請重新查詢。";
    return { ok: true, replyText, agentResult: { status: "unavailable", replyText } };
  }
  const link = current.link;
  return {
    ok: true,
    replyText: [item.title, link].join("\n"),
    responseData: { kind: "resource", fields: { title: item.title, link } },
    agentResult: catalogItemEnvelope(item.id, {
      resourceId: item.id,
      driveId: item.storageRef.driveId,
      itemId: item.storageRef.itemId
    })
  };
}

function catalogItemEnvelope(resourceId: string, reference: Record<string, string>) {
  return {
    status: "success" as const,
    replyText: "教會資料查詢完成。",
    entities: [{ type: "resource", key: resourceId, label: "教會資料" }],
    evidence: [{ kind: "catalog_item", reference }],
    supportedOperations: ["continue", "refine", "view_full"]
  };
}
