import { createHash } from "node:crypto";

import type { CatalogItemRecord, CatalogSourceInput, CatalogStore } from "../catalog/store.js";
import type { PendingAttachmentSession, SessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  GraphDriveClient,
  LineContentClient,
  TextMessageHandler,
  VirusScanner
} from "../types.js";

const ATTACHMENT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const XIAOHA_DATABASE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type AttachmentTargetKind =
  "ppt_slide" | "pop_sheet" | "hymn_sheet" | "church_document" | "church_image" | "church_other";

interface AttachmentTarget {
  sourceKey: string;
  itemKind: AttachmentTargetKind;
  domain: string;
  title: string;
  autoKind?: boolean;
}

export interface PendingAttachmentTextMessageOptions {
  sessionStore: SessionStore;
  catalog: CatalogStore;
  lineContent: LineContentClient;
  graph: GraphDriveClient;
  scanner?: VirusScanner;
  sources: CatalogSourceInput[];
  maxBytes?: number;
  now?: () => Date;
}

interface ValidatedAttachment {
  data: Uint8Array;
  fileName: string;
  title: string;
  mimeType: string;
  extension: string;
  sha256: string;
  sizeBytes: number;
}

export function createPendingAttachmentTextMessageHandler(
  options: PendingAttachmentTextMessageOptions
): TextMessageHandler {
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  return {
    matches: async (_request, context) =>
      Boolean(
        await options.sessionStore.findPendingAttachment({
          profileName: context.profile.name,
          source: context.event.source,
          requesterUserId: context.event.source.userId
        })
      ),

    handle: async (request, context) => {
      const pending = await options.sessionStore.findPendingAttachment({
        profileName: context.profile.name,
        source: context.event.source,
        requesterUserId: context.event.source.userId
      });
      if (!pending) {
        return undefined;
      }
      if (!context.profile.enabledFunctions.includes("save_resource")) {
        await options.sessionStore.delete(pending.id);
        return { ok: true, replyText: "目前沒有開放保存檔案。" };
      }

      const answer = request.text.trim();
      if (isCancel(answer)) {
        await options.sessionStore.delete(pending.id);
        return { ok: true, replyText: "好，我先不保存這個檔案。" };
      }

      if (pending.stage === "awaiting_confirmation") {
        if (!isConfirm(answer)) {
          return {
            ok: true,
            replyText: "請回覆「保存」確認，或回覆「取消」。",
            quickReplies: confirmationQuickReplies()
          };
        }
        return publishAttachment({
          options,
          pending,
          maxBytes,
          now: now(),
          profile: context.profile
        });
      }

      const target = parseAttachmentTarget(answer, pending);
      if (!target) {
        return {
          ok: true,
          replyText: "請先說明用途：投影片、流行歌譜、詩歌歌譜或教會資料。"
        };
      }
      const sourceGate = findWritableSource(options.sources, pending.profileName, target);
      if (!sourceGate.ok) {
        await options.sessionStore.delete(pending.id);
        return { ok: true, replyText: sourceGate.replyText };
      }

      const prepared = await prepareAttachment({
        options,
        pending,
        target,
        maxBytes,
        profile: context.profile
      });
      if (!prepared.ok) {
        await options.sessionStore.delete(pending.id);
        return { ok: true, replyText: prepared.replyText };
      }

      const updated: PendingAttachmentSession = {
        ...pending,
        stage: "awaiting_confirmation",
        target: {
          sourceKey: prepared.target.sourceKey,
          itemKind: prepared.target.itemKind,
          domain: prepared.target.domain,
          title: prepared.target.title,
          fileName: prepared.attachment.fileName,
          contentType: prepared.attachment.mimeType
        },
        preview: {
          sha256: prepared.attachment.sha256,
          sizeBytes: prepared.attachment.sizeBytes,
          mimeType: prepared.attachment.mimeType,
          extension: prepared.attachment.extension,
          fileName: prepared.attachment.fileName
        },
        expiresAt: new Date(now().getTime() + ATTACHMENT_SESSION_TTL_MS).toISOString()
      };
      await options.sessionStore.set(updated);

      return {
        ok: true,
        replyText: [
          "請確認要保存這個檔案：",
          `名稱：${prepared.target.title}`,
          `檔名：${prepared.attachment.fileName}`,
          `類型：${labelForItemKind(prepared.target.itemKind)}`,
          `大小：${prepared.attachment.sizeBytes} bytes`,
          "確認後才會上傳到 OneDrive。"
        ].join("\n"),
        quickReplies: confirmationQuickReplies()
      };
    }
  };
}

async function publishAttachment(input: {
  options: PendingAttachmentTextMessageOptions;
  pending: PendingAttachmentSession;
  maxBytes: number;
  now: Date;
  profile: BotProfileConfig;
}): Promise<FunctionExecutionResult> {
  const sessionTarget = input.pending.target;
  const preview = input.pending.preview;
  if (!sessionTarget || !preview || !isAttachmentTargetKind(sessionTarget.itemKind)) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: "保存流程已失效，請重新上傳檔案。" };
  }
  const target: AttachmentTarget = {
    sourceKey: sessionTarget.sourceKey,
    itemKind: sessionTarget.itemKind,
    domain: sessionTarget.domain,
    title: sessionTarget.title
  };
  const prepared = await prepareAttachment({
    options: input.options,
    pending: input.pending,
    target,
    maxBytes: input.maxBytes,
    profile: input.profile
  });
  if (!prepared.ok) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: prepared.replyText };
  }
  if (prepared.attachment.sha256 !== preview.sha256) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: "檔案內容已變更，為安全起見請重新上傳。" };
  }

  const sourceGate = findWritableSource(input.options.sources, input.pending.profileName, target);
  if (!sourceGate.ok) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: sourceGate.replyText };
  }
  const sourceInput = sourceGate.source;
  const driveId = sourceInput.rootLocation.driveId;
  const folderItemId = folderItemIdForTarget(sourceInput, target);
  if (!driveId || !folderItemId || !input.options.graph.uploadFile) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: "目前沒有可用的 OneDrive 上傳服務。" };
  }
  const conflict = await findCatalogConflict({
    catalog: input.options.catalog,
    profileName: input.pending.profileName,
    target: prepared.target,
    sha256: prepared.attachment.sha256
  });
  if (conflict?.kind === "same_hash") {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: `已經有相同檔案：${conflict.item.title}` };
  }
  if (conflict?.kind === "same_title") {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: "已經有同名檔案，請換一個名稱後重新上傳。" };
  }

  const source = await input.options.catalog.upsertSource(sourceInput);
  const item = await input.options.graph.uploadFile(
    driveId,
    folderItemId,
    prepared.attachment.fileName,
    prepared.attachment.data,
    prepared.attachment.mimeType
  );
  await input.options.catalog.upsertItem({
    sourceId: source.id,
    itemKind: prepared.target.itemKind,
    domain: prepared.target.domain,
    title: prepared.target.title,
    path: item.path ?? item.name,
    mimeType: prepared.attachment.mimeType,
    extension: prepared.attachment.extension,
    sizeBytes: prepared.attachment.sizeBytes,
    sha256: prepared.attachment.sha256,
    storageRef: {
      provider: "graph",
      driveId: item.driveId ?? driveId,
      itemId: item.id
    },
    externalUpdatedAt: input.now.toISOString(),
    expiresAt: expiresAtForTarget(prepared.target, input.now)
  });
  await input.options.sessionStore.delete(input.pending.id);
  return {
    ok: true,
    replyText: `已保存：${prepared.target.title}`,
    executedAction: "save_resource"
  };
}

async function prepareAttachment(input: {
  options: PendingAttachmentTextMessageOptions;
  pending: PendingAttachmentSession;
  target: AttachmentTarget;
  maxBytes: number;
  profile: BotProfileConfig;
}): Promise<
  | { ok: true; attachment: ValidatedAttachment; target: AttachmentTarget }
  | { ok: false; replyText: string }
> {
  const content = await input.options.lineContent.getMessageContent(
    input.pending.attachment.messageId,
    input.profile
  );
  const sizeBytes = content.data.byteLength;
  if (sizeBytes === 0) {
    return { ok: false, replyText: "檔案是空的，無法保存。" };
  }
  if (sizeBytes > input.maxBytes) {
    return { ok: false, replyText: "檔案太大，無法保存。" };
  }

  const extension = extensionFromFileName(input.pending.attachment.fileName ?? "");
  const detected = detectContent(content.data, content.contentType, extension);
  if (!detected) {
    return { ok: false, replyText: "檔案格式不支援或內容與副檔名不符。" };
  }
  const target = resolveTargetForDetectedContent(input.target, detected.extension);
  if (!allowedExtensions(target.itemKind).includes(detected.extension)) {
    return { ok: false, replyText: "這個用途不支援此檔案格式。" };
  }

  const fileName = sanitizeFileName(`${target.title}${detected.extension}`);
  const sha256 = sha256Hex(content.data);
  const scan = input.options.scanner
    ? await input.options.scanner.scan({
        data: content.data,
        fileName,
        contentType: detected.mimeType,
        sha256
      })
    : { status: "unavailable" as const };
  if (scan.status === "infected") {
    return { ok: false, replyText: "掃毒未通過，為安全起見不保存這個檔案。" };
  }
  if (scan.status !== "clean") {
    return { ok: false, replyText: "掃毒服務目前不可用，為安全起見不保存這個檔案。" };
  }

  return {
    ok: true,
    attachment: {
      data: content.data,
      fileName,
      title: target.title,
      mimeType: detected.mimeType,
      extension: detected.extension,
      sha256,
      sizeBytes
    },
    target
  };
}

function parseAttachmentTarget(
  text: string,
  pending: PendingAttachmentSession
): AttachmentTarget | undefined {
  const normalized = text.normalize("NFKC");
  const baseTitle = stripExtension(pending.attachment.fileName ?? "").trim();
  if (/流行.*歌譜|歌譜.*流行/u.test(normalized)) {
    return {
      sourceKey: "pop_sheet_music",
      itemKind: "pop_sheet",
      domain: "sheet_music",
      title: inferTitle(normalized, baseTitle)
    };
  }
  if (/詩歌.*歌譜|歌譜.*詩歌|敬拜.*歌譜/u.test(normalized)) {
    return {
      sourceKey: "hymn_sheet_music",
      itemKind: "hymn_sheet",
      domain: "sheet_music",
      title: inferTitle(normalized, baseTitle)
    };
  }
  if (/投影片|簡報|ppt/i.test(normalized)) {
    return {
      sourceKey: "ppt_slides",
      itemKind: "ppt_slide",
      domain: "presentation",
      title: inferTitle(normalized, baseTitle)
    };
  }
  if (/小哈資料庫|教會資料|一般資料|文件|資料|圖片|照片/u.test(normalized)) {
    return {
      sourceKey: "xiaoha_database",
      itemKind: "church_document",
      domain: "general",
      title: inferTitle(normalized, baseTitle),
      autoKind: true
    };
  }
  return undefined;
}

function inferTitle(text: string, fallback: string): string {
  const title = text
    .replace(
      /小哈資料庫|教會資料|一般資料|資料庫|存成|保存|存到|放到|幫我|小哈|請|到|檔案|用途|是|投影片|簡報|ppt|流行|詩歌|歌譜|文件|資料|圖片|照片/giu,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  return title || fallback || "未命名檔案";
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
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0])) {
    if ([".ppt", ".doc", ".xls"].includes(extension)) {
      return { mimeType: mimeTypeForExtension(extension, declaredContentType), extension };
    }
    return undefined;
  }
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    if ([".pptx", ".key", ".odp", ".docx", ".xlsx"].includes(extension)) {
      return { mimeType: mimeTypeForExtension(extension, declaredContentType), extension };
    }
  }
  if ([".txt", ".md"].includes(extension) && isProbablyText(data, declaredContentType)) {
    return { mimeType: declaredContentType || "text/plain", extension };
  }
  return undefined;
}

function allowedExtensions(itemKind: AttachmentTargetKind): string[] {
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

function findWritableSource(
  sources: CatalogSourceInput[],
  profileName: string,
  target: AttachmentTarget
): { ok: true; source: CatalogSourceInput } | { ok: false; replyText: string } {
  const source = sources.find(
    (candidate) =>
      candidate.profileName === profileName &&
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

function resolveTargetForDetectedContent(
  target: AttachmentTarget,
  extension: string
): AttachmentTarget {
  if (!target.autoKind) {
    return { ...target };
  }
  return {
    ...target,
    itemKind: genericChurchItemKindForExtension(extension),
    autoKind: undefined
  };
}

function genericChurchItemKindForExtension(extension: string): AttachmentTargetKind {
  if ([".jpg", ".jpeg", ".png"].includes(extension)) {
    return "church_image";
  }
  if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".md"].includes(extension)) {
    return "church_document";
  }
  return "church_other";
}

function folderItemIdForTarget(
  source: CatalogSourceInput,
  target: AttachmentTarget
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

function expiresAtForTarget(target: AttachmentTarget, now: Date): string | undefined {
  if (target.sourceKey !== "xiaoha_database") {
    return undefined;
  }
  return new Date(now.getTime() + XIAOHA_DATABASE_RETENTION_MS).toISOString();
}

async function findCatalogConflict(input: {
  catalog: CatalogStore;
  profileName: string;
  target: AttachmentTarget;
  sha256: string;
}): Promise<
  | { kind: "same_hash"; item: CatalogItemRecord }
  | { kind: "same_title"; item: CatalogItemRecord }
  | undefined
> {
  const candidates = await input.catalog.searchItems({
    profileName: input.profileName,
    query: input.target.title,
    itemKinds: [input.target.itemKind],
    allowedSourceKeys: [input.target.sourceKey],
    limit: 20
  });
  const exactTitle = candidates.filter(
    (item) => item.title.normalize("NFKC") === input.target.title.normalize("NFKC")
  );
  const sameHash = exactTitle.find((item) => item.sha256 === input.sha256);
  if (sameHash) {
    return { kind: "same_hash", item: sameHash };
  }
  if (exactTitle.length > 0) {
    return { kind: "same_title", item: exactTitle[0] };
  }
  return undefined;
}

function isAttachmentTargetKind(value: string): value is AttachmentTargetKind {
  return (
    value === "ppt_slide" ||
    value === "pop_sheet" ||
    value === "hymn_sheet" ||
    value === "church_document" ||
    value === "church_image" ||
    value === "church_other"
  );
}

function startsWith(data: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

function mimeTypeForExtension(extension: string, declaredContentType: string | undefined): string {
  if (declaredContentType?.trim()) {
    return declaredContentType;
  }
  switch (extension) {
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".key":
      return "application/vnd.apple.keynote";
    case ".odp":
      return "application/vnd.oasis.opendocument.presentation";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".md":
      return "text/markdown";
    default:
      return "text/plain";
  }
}

function isProbablyText(data: Uint8Array, declaredContentType: string | undefined): boolean {
  if (declaredContentType?.toLowerCase().startsWith("text/")) {
    return true;
  }
  return data.every(
    (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f)
  );
}

function extensionFromFileName(fileName: string): string {
  const match = fileName
    .trim()
    .toLowerCase()
    .match(/(\.[a-z0-9]+)$/u);
  return match?.[1] ?? "";
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "");
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

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isConfirm(text: string): boolean {
  return /^(保存|確認|好|yes|y)$/iu.test(text.trim());
}

function isCancel(text: string): boolean {
  return /^(取消|不要|先不要|不用)$/u.test(text.trim());
}

function confirmationQuickReplies() {
  return [
    { label: "保存", action: { type: "message" as const, label: "保存", text: "保存" } },
    { label: "取消", action: { type: "message" as const, label: "取消", text: "取消" } }
  ];
}

function labelForItemKind(itemKind: AttachmentTargetKind): string {
  switch (itemKind) {
    case "ppt_slide":
      return "投影片";
    case "pop_sheet":
      return "流行歌譜";
    case "hymn_sheet":
      return "詩歌歌譜";
    case "church_document":
      return "教會文件";
    case "church_image":
      return "教會圖片";
    case "church_other":
      return "教會資料";
  }
}
