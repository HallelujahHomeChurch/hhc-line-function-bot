import { createHash } from "node:crypto";

import type { CatalogItemRecord, CatalogSourceRecord, CatalogStore } from "../catalog/store.js";
import type { FunctionExecutionResult, GraphDriveClient, VirusScanner } from "../types.js";

const XIAOHA_DATABASE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type ResourcePublishItemKind =
  "ppt_slide" | "pop_sheet" | "hymn_sheet" | "church_document" | "church_image" | "church_other";

export interface ResourcePublishTarget {
  profileName: string;
  sourceKey: string;
  itemKind: ResourcePublishItemKind;
  domain: string;
  title: string;
}

export interface ResourceBinaryInput {
  data: Uint8Array;
  declaredFileName?: string;
  declaredContentType?: string;
  sourceKind: "line" | "external";
}

export interface ResourceBinaryPublisher {
  publish(input: {
    binary: ResourceBinaryInput;
    target: ResourcePublishTarget;
    now: Date;
  }): Promise<FunctionExecutionResult>;
}

export interface ResourceBinaryPublisherOptions {
  catalog: CatalogStore;
  graph: GraphDriveClient;
  scanner?: VirusScanner;
  maxBytes: number;
}

export function createResourceBinaryPublisher(
  options: ResourceBinaryPublisherOptions
): ResourceBinaryPublisher {
  return {
    async publish(input) {
      const sizeBytes = input.binary.data.byteLength;
      if (sizeBytes === 0) {
        return { ok: true, replyText: "檔案是空的，無法保存。" };
      }
      if (sizeBytes > options.maxBytes) {
        return { ok: true, replyText: "檔案太大，無法保存。" };
      }

      const declaredExtension = extensionFromFileName(input.binary.declaredFileName ?? "");
      const detected = detectContent(
        input.binary.data,
        input.binary.declaredContentType,
        declaredExtension
      );
      if (!detected || (declaredExtension && declaredExtension !== detected.extension)) {
        return { ok: true, replyText: "檔案格式不支援或內容與副檔名不符。" };
      }
      const target = resolveTargetForDetectedContent(input.target, detected.extension);
      if (!allowedExtensions(target.itemKind).includes(detected.extension)) {
        return { ok: true, replyText: "這個用途不支援此檔案格式。" };
      }

      const fileName = sanitizeFileName(`${target.title}${detected.extension}`);
      const sha256 = createHash("sha256").update(input.binary.data).digest("hex");
      const scan = options.scanner
        ? await options.scanner.scan({
            data: input.binary.data,
            fileName,
            contentType: detected.mimeType,
            sha256
          })
        : { status: "unavailable" as const };
      if (scan.status === "infected") {
        return { ok: true, replyText: "掃毒未通過，為安全起見不保存這個檔案。" };
      }
      if (scan.status !== "clean") {
        return { ok: true, replyText: "掃毒服務目前不可用，為安全起見不保存這個檔案。" };
      }

      const sourceGate = await findWritableSource(options.catalog, target);
      if (!sourceGate.ok) {
        return { ok: true, replyText: sourceGate.replyText };
      }
      const driveId = sourceGate.source.rootLocation.driveId;
      const folderItemId = folderItemIdForTarget(sourceGate.source, target);
      if (!driveId || !folderItemId || !options.graph.uploadFile) {
        return { ok: true, replyText: "目前沒有可用的 OneDrive 上傳服務。" };
      }

      const conflict = await findCatalogConflict(options.catalog, target, sha256);
      if (conflict?.kind === "same_hash") {
        return { ok: true, replyText: `已經有相同檔案：${conflict.item.title}` };
      }
      if (conflict?.kind === "same_title") {
        return { ok: true, replyText: "已經有同名檔案，請換一個名稱後重新上傳。" };
      }

      const item = await options.graph.uploadFile(
        driveId,
        folderItemId,
        fileName,
        input.binary.data,
        detected.mimeType
      );
      const uploadedDriveId = item.driveId ?? driveId;
      let catalogItem: CatalogItemRecord;
      try {
        catalogItem = await options.catalog.upsertItem({
          sourceId: sourceGate.source.id,
          itemKind: target.itemKind,
          domain: target.domain,
          title: target.title,
          path: item.path ?? item.name,
          mimeType: detected.mimeType,
          extension: detected.extension,
          sizeBytes,
          sha256,
          storageRef: {
            provider: "graph",
            driveId: uploadedDriveId,
            itemId: item.id
          },
          externalUpdatedAt: input.now.toISOString(),
          expiresAt:
            target.sourceKey === "xiaoha_database"
              ? new Date(input.now.getTime() + XIAOHA_DATABASE_RETENTION_MS).toISOString()
              : undefined
        });
      } catch {
        if (options.graph.deleteItem) {
          try {
            await options.graph.deleteItem(uploadedDriveId, item.id);
          } catch {
            // A later catalog sync can reconcile an upload that could not be compensated.
          }
        }
        return { ok: true, replyText: "檔案索引建立失敗，這次沒有完成保存，請稍後重試。" };
      }
      return {
        ok: true,
        writePhase: "commit",
        replyText: [
          "已保存檔案：",
          `名稱：${target.title}`,
          `檔名：${item.name || fileName}`,
          `用途：${purposeLabel(target.itemKind)}`,
          `大小：${formatBytes(sizeBytes)}`
        ].join("\n"),
        executedAction: "save_resource",
        agentResult: {
          status: "success",
          replyText: "檔案已保存。",
          anchors: {
            resourceId: catalogItem.id,
            resourceKind:
              resourceTypeForItemKind(target.itemKind) === "general_resource"
                ? "resource"
                : resourceTypeForItemKind(target.itemKind),
            title: target.title
          },
          entities: [{ type: "resource", key: catalogItem.id, label: "已保存資源" }]
        },
        agentResource: {
          resourceType: resourceTypeForItemKind(target.itemKind),
          title: target.title,
          storage: {
            provider: "graph",
            driveId: uploadedDriveId,
            itemId: item.id
          }
        }
      };
    }
  };
}

function resourceTypeForItemKind(itemKind: ResourcePublishItemKind) {
  if (itemKind === "ppt_slide") return "ppt_slide" as const;
  if (itemKind === "pop_sheet" || itemKind === "hymn_sheet") return "sheet_music" as const;
  return "general_resource" as const;
}

function purposeLabel(itemKind: ResourcePublishItemKind): string {
  switch (itemKind) {
    case "ppt_slide":
      return "投影片";
    case "pop_sheet":
      return "流行歌譜";
    case "hymn_sheet":
      return "詩歌歌譜";
    case "church_image":
    case "church_document":
    case "church_other":
      return "小哈資料庫";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectContent(
  data: Uint8Array,
  declaredContentType: string | undefined,
  extension: string
): { mimeType: string; extension: string } | undefined {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mimeType: "application/pdf", extension: ".pdf" };
  }
  if (startsWith(data, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: extension === ".jpeg" ? ".jpeg" : ".jpg" };
  }
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) {
    return { mimeType: "image/png", extension: ".png" };
  }
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0]) && [".ppt", ".doc", ".xls"].includes(extension)) {
    return { mimeType: mimeTypeForExtension(extension, declaredContentType), extension };
  }
  if (
    startsWith(data, [0x50, 0x4b, 0x03, 0x04]) &&
    [".pptx", ".key", ".odp", ".docx", ".xlsx"].includes(extension)
  ) {
    return { mimeType: mimeTypeForExtension(extension, declaredContentType), extension };
  }
  if ([".txt", ".md"].includes(extension) && isProbablyText(data, declaredContentType)) {
    return { mimeType: declaredContentType || "text/plain", extension };
  }
  return undefined;
}

function resolveTargetForDetectedContent(
  target: ResourcePublishTarget,
  extension: string
): ResourcePublishTarget {
  if (target.sourceKey !== "xiaoha_database") {
    return target;
  }
  const itemKind: ResourcePublishItemKind = [".jpg", ".jpeg", ".png"].includes(extension)
    ? "church_image"
    : [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".md"].includes(extension)
      ? "church_document"
      : "church_other";
  return { ...target, itemKind };
}

function allowedExtensions(itemKind: ResourcePublishItemKind): string[] {
  switch (itemKind) {
    case "ppt_slide":
      return [".pptx", ".ppt", ".key", ".odp", ".pdf"];
    case "pop_sheet":
    case "hymn_sheet":
      return [".pdf", ".jpg", ".jpeg", ".png"];
    case "church_document":
      return [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".md"];
    case "church_image":
      return [".jpg", ".jpeg", ".png"];
    case "church_other":
      return [".pptx", ".ppt", ".key", ".odp"];
  }
}

async function findWritableSource(
  catalog: CatalogStore,
  target: ResourcePublishTarget
): Promise<{ ok: true; source: CatalogSourceRecord } | { ok: false; replyText: string }> {
  const sources = await catalog.listSources({
    profileName: target.profileName,
    enabled: true,
    sourceKeys: [target.sourceKey]
  });
  const source = sources.find(
    (candidate) =>
      candidate.profileName === target.profileName &&
      candidate.sourceKey === target.sourceKey &&
      candidate.enabled
  );
  if (!source) {
    return { ok: false, replyText: "找不到可寫入的目標資料夾。" };
  }
  if (source.capabilities.write.length === 0) {
    return { ok: false, replyText: "目標資料夾沒有開放寫入。" };
  }
  return { ok: true, source };
}

function folderItemIdForTarget(
  source: CatalogSourceRecord,
  target: ResourcePublishTarget
): string | undefined {
  if (source.sourceKey !== "xiaoha_database") {
    return source.rootLocation.folderItemId;
  }
  switch (target.itemKind) {
    case "church_document":
      return source.rootLocation.documentFolderItemId ?? source.rootLocation.folderItemId;
    case "church_image":
      return source.rootLocation.imageFolderItemId ?? source.rootLocation.folderItemId;
    case "church_other":
      return source.rootLocation.otherFolderItemId ?? source.rootLocation.folderItemId;
    default:
      return source.rootLocation.folderItemId;
  }
}

async function findCatalogConflict(
  catalog: CatalogStore,
  target: ResourcePublishTarget,
  sha256: string
): Promise<
  | { kind: "same_hash"; item: CatalogItemRecord }
  | { kind: "same_title"; item: CatalogItemRecord }
  | undefined
> {
  const candidates = await catalog.searchItems({
    profileName: target.profileName,
    query: target.title,
    itemKinds: [target.itemKind],
    allowedSourceKeys: [target.sourceKey],
    limit: 20
  });
  const exactTitle = candidates.filter(
    (item) => item.title.normalize("NFKC") === target.title.normalize("NFKC")
  );
  const sameHash = exactTitle.find((item) => item.sha256 === sha256);
  return sameHash
    ? { kind: "same_hash", item: sameHash }
    : exactTitle[0]
      ? { kind: "same_title", item: exactTitle[0] }
      : undefined;
}

function startsWith(data: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

function extensionFromFileName(fileName: string): string {
  return (
    fileName
      .trim()
      .toLowerCase()
      .match(/(\.[a-z0-9]+)$/u)?.[1] ?? ""
  );
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*]/gu, "_")
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? "_" : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function mimeTypeForExtension(extension: string, declaredContentType?: string): string {
  if (declaredContentType?.trim()) {
    return declaredContentType;
  }
  return (
    {
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".key": "application/vnd.apple.keynote",
      ".odp": "application/vnd.oasis.opendocument.presentation",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".md": "text/markdown"
    }[extension] ?? "text/plain"
  );
}

function isProbablyText(data: Uint8Array, declaredContentType?: string): boolean {
  return (
    Boolean(declaredContentType?.toLowerCase().startsWith("text/")) ||
    data.every(
      (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f)
    )
  );
}
