import { z } from "zod";

import type { FunctionHandler, GraphDriveClient } from "../types.js";

const argsSchema = z.object({
  query: z.string().optional().default(""),
  includePdf: z.boolean().optional()
});

export interface FindPptSlidesOptions {
  graph: GraphDriveClient;
  driveId: string;
  folderItemId: string;
  allowedExtensions: string[];
  defaultIncludePdf: boolean;
  now?: () => Date;
}

export function createFindPptSlidesHandler(options: FindPptSlidesOptions): FunctionHandler {
  const now = options.now ?? (() => new Date());
  const configuredExtensions = normalizeExtensions(options.allowedExtensions);

  return async (rawArgs) => {
    const args = argsSchema.parse(rawArgs);
    const includePdf = args.includePdf ?? options.defaultIncludePdf;
    const extensions = configuredExtensions.filter(
      (extension) => includePdf || extension !== ".pdf"
    );
    const query = normalizeText(args.query);

    const allItems = await options.graph.listFolderChildren(options.driveId, options.folderItemId);
    const matched = allItems
      .filter((item) => extensions.some((extension) => item.name.toLowerCase().endsWith(extension)))
      .filter((item) => !query || normalizeText(item.name).includes(query))
      .slice(0, 3);

    if (matched.length === 0) {
      return { ok: true, replyText: "找不到符合的投影片。" };
    }

    const expiresAt = new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString();
    const lines = [`找到 ${matched.length} 個檔案，連結 24 小時內有效：`];

    for (const [index, item] of matched.entries()) {
      const link = await options.graph.createSharingLink(options.driveId, item.id, expiresAt);
      lines.push(`${index + 1}. ${item.name}`);
      lines.push(link);
      lines.push(`過期：${expiresAt}`);
    }

    return {
      ok: true,
      replyText: lines.join("\n")
    };
  };
}

function normalizeExtensions(extensions: string[]): string[] {
  return Array.from(
    new Set(
      extensions
        .map((extension) => extension.trim().toLowerCase())
        .filter(Boolean)
        .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
    )
  );
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}
