import { catalogSourceAllowsRead, type CatalogStore } from "../catalog/store.js";
import { findResourceArgumentsSchema } from "../function-arguments.js";
import type { FunctionExecutionResult, FunctionHandler, GraphDriveClient } from "../types.js";

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
    if (!query) {
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
    const items = (
      await options.catalog.searchItems({
        profileName: context.profile.name,
        query,
        itemKinds: itemKinds.length ? itemKinds : undefined,
        domains: args.domain ? [args.domain] : undefined,
        allowedSourceKeys: options.allowedSourceKeys,
        limit: Math.max(limit, 20)
      })
    )
      .filter((item) =>
        catalogSourceAllowsRead(item.source, [context.profile.name, "find_resource"])
      )
      .slice(0, limit);

    if (items.length === 0) {
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

    return createCatalogItemReply(options.graph, items[0], now());
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
  const link = await graph.createSharingLink(
    item.storageRef.driveId,
    item.storageRef.itemId,
    expiresAt
  );
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
    supportedOperations: []
  };
}
