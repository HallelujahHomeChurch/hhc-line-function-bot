import { extname } from "node:path";

import type { GraphDriveClient } from "../types.js";
import {
  catalogStorageIdentity,
  type CatalogItemInput,
  type CatalogSourceRecord,
  type CatalogStore
} from "./store.js";

export interface OneDriveCatalogSyncOptions {
  catalog: CatalogStore;
  graph: GraphDriveClient;
  source: CatalogSourceRecord;
  now?: () => Date;
}

export interface OneDriveCatalogSyncResult {
  upserted: number;
  skipped: number;
  tombstoned: number;
}

export async function syncOneDriveCatalogSource(
  options: OneDriveCatalogSyncOptions
): Promise<OneDriveCatalogSyncResult> {
  const { catalog, graph } = options;
  const source =
    (await catalog.listSources({ profileName: options.source.profileName })).find(
      (candidate) => candidate.id === options.source.id
    ) ?? options.source;
  options = { ...options, source };
  if (!source.enabled || source.adapterType !== "onedrive") {
    return { upserted: 0, skipped: 0, tombstoned: 0 };
  }

  const driveId = source.rootLocation.driveId;
  const folderItemId = source.rootLocation.folderItemId;
  if (!driveId || !folderItemId) {
    throw new Error(`catalog_source_missing_onedrive_root:${source.sourceKey}`);
  }

  if (graph.listFolderDelta) {
    try {
      return await syncOneDriveDelta({ ...options, driveId, folderItemId });
    } catch (error) {
      if (isDeltaResetError(error) && source.syncCursor) {
        await catalog.updateSourceSyncCursor(source.id, undefined);
        return syncOneDriveDelta({
          ...options,
          source: { ...source, syncCursor: undefined },
          driveId,
          folderItemId
        });
      }
      if (!isDeltaUnsupportedError(error)) {
        throw error;
      }
    }
  }

  const items = graph.listFolderFilesRecursive
    ? await graph.listFolderFilesRecursive(driveId, folderItemId)
    : await graph.listFolderChildren(driveId, folderItemId);

  let skipped = 0;
  const snapshotItems: CatalogItemInput[] = [];
  const allowedExtensions = new Set(
    source.syncPolicy.allowedExtensions?.map((extension) => extension.toLowerCase()) ?? []
  );
  for (const item of items) {
    const extension = extname(item.name).toLowerCase();
    if (
      item.isFolder ||
      !item.id ||
      !item.name ||
      (allowedExtensions.size > 0 && !allowedExtensions.has(extension))
    ) {
      skipped += 1;
      continue;
    }
    const storageRef = {
      provider: "graph" as const,
      driveId: item.driveId ?? driveId,
      itemId: item.id
    };
    snapshotItems.push({
      sourceId: source.id,
      itemKind: source.defaultItemKind,
      domain: source.domain,
      title: item.name,
      path: item.path,
      extension,
      mimeType: guessMimeType(item.name),
      storageRef
    });
  }

  const publishedAt = (options.now ?? (() => new Date()))().toISOString();
  const published = await catalog.publishSourceSnapshot({
    sourceId: source.id,
    expectedRevision: source.revision,
    items: snapshotItems,
    publishedAt
  });
  if (!published) throw new Error(`catalog_publication_revision_conflict:${source.sourceKey}`);

  return {
    upserted: snapshotItems.length,
    skipped,
    tombstoned: Math.max(0, source.publishedItemCount - snapshotItems.length)
  };
}

async function syncOneDriveDelta(
  options: OneDriveCatalogSyncOptions & { driveId: string; folderItemId: string }
): Promise<OneDriveCatalogSyncResult> {
  const { catalog, graph, source, driveId, folderItemId } = options;
  if (!graph.listFolderDelta) {
    throw new Error("graph_delta_unavailable");
  }
  const delta = await graph.listFolderDelta(driveId, folderItemId, source.syncCursor);
  const allowedExtensions = new Set(
    source.syncPolicy.allowedExtensions?.map((extension) => extension.toLowerCase()) ?? []
  );
  const deletedStorageIdentities: string[] = [];
  const upserts: CatalogItemInput[] = [];
  let skipped = 0;
  for (const item of delta.items) {
    const storageRef = {
      provider: "graph" as const,
      driveId: item.driveId ?? driveId,
      itemId: item.id
    };
    const storageIdentity = catalogStorageIdentity(storageRef);
    if (item.deleted) {
      deletedStorageIdentities.push(storageIdentity);
      continue;
    }
    if (item.isFolder || !item.id || !item.name) {
      skipped += 1;
      continue;
    }
    const extension = extname(item.name).toLowerCase();
    if (allowedExtensions.size > 0 && !allowedExtensions.has(extension)) {
      skipped += 1;
      continue;
    }
    upserts.push({
      sourceId: source.id,
      itemKind: source.defaultItemKind,
      domain: source.domain,
      title: item.name,
      path: item.path,
      extension,
      mimeType: guessMimeType(item.name),
      storageRef
    });
  }
  const publishedAt = (options.now ?? (() => new Date()))().toISOString();
  const published = source.syncCursor
    ? await catalog.publishSourceDelta({
        sourceId: source.id,
        expectedRevision: source.revision,
        upserts,
        deletedStorageIdentities,
        syncCursor: delta.deltaLink,
        publishedAt
      })
    : await catalog.publishSourceSnapshot({
        sourceId: source.id,
        expectedRevision: source.revision,
        items: upserts,
        syncCursor: delta.deltaLink,
        publishedAt
      });
  if (!published) throw new Error(`catalog_publication_revision_conflict:${source.sourceKey}`);
  return { upserted: upserts.length, skipped, tombstoned: deletedStorageIdentities.length };
}

function isDeltaResetError(error: unknown): boolean {
  return Number((error as { statusCode?: unknown })?.statusCode) === 410;
}

function isDeltaUnsupportedError(error: unknown): boolean {
  return [400, 404, 405, 422].includes(Number((error as { statusCode?: unknown })?.statusCode));
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
