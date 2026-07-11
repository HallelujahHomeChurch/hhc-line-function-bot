import { extname } from "node:path";

import type { GraphDriveClient } from "../types.js";
import type { CatalogSourceRecord, CatalogStore } from "./store.js";

export interface OneDriveCatalogSyncOptions {
  catalog: CatalogStore;
  graph: GraphDriveClient;
  source: CatalogSourceRecord;
}

export interface OneDriveCatalogSyncResult {
  upserted: number;
  skipped: number;
}

export async function syncOneDriveCatalogSource(
  options: OneDriveCatalogSyncOptions
): Promise<OneDriveCatalogSyncResult> {
  const { catalog, graph, source } = options;
  if (!source.enabled || source.adapterType !== "onedrive") {
    return { upserted: 0, skipped: 0 };
  }

  const driveId = source.rootLocation.driveId;
  const folderItemId = source.rootLocation.folderItemId;
  if (!driveId || !folderItemId) {
    throw new Error(`catalog_source_missing_onedrive_root:${source.sourceKey}`);
  }

  const items = graph.listFolderFilesRecursive
    ? await graph.listFolderFilesRecursive(driveId, folderItemId)
    : await graph.listFolderChildren(driveId, folderItemId);

  let upserted = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.isFolder || !item.id || !item.name) {
      skipped += 1;
      continue;
    }
    await catalog.upsertItem({
      sourceId: source.id,
      itemKind: source.defaultItemKind,
      domain: source.domain,
      title: item.name,
      path: item.path,
      extension: extname(item.name).toLowerCase(),
      mimeType: guessMimeType(item.name),
      storageRef: {
        provider: "graph",
        driveId: item.driveId ?? driveId,
        itemId: item.id
      }
    });
    upserted += 1;
  }

  return { upserted, skipped };
}

function guessMimeType(filename: string): string | undefined {
  switch (extname(filename).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".pdf":
      return "application/pdf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return undefined;
  }
}
