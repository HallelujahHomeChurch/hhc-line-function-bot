import type { CatalogSourceRecord, CatalogStore } from "../catalog/store.js";
import type { PendingAttachmentSession, SessionStore } from "../state/session-store.js";
import type {
  BotProfileConfig,
  FunctionExecutionResult,
  GraphDriveClient,
  LineContentClient,
  TextMessageHandler,
  VirusScanner
} from "../types.js";
import { createResourceBinaryPublisher } from "./resource-binary-publisher.js";

const ATTACHMENT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_LINE_DOWNLOAD_TIMEOUT_MS = 30_000;

type AttachmentTargetKind =
  "ppt_slide" | "pop_sheet" | "hymn_sheet" | "church_document" | "church_image" | "church_other";

interface AttachmentTarget {
  sourceKey: string;
  itemKind: AttachmentTargetKind;
  domain: string;
  title: string;
}

type AttachmentDestination = Omit<AttachmentTarget, "title">;

export interface PendingAttachmentTextMessageOptions {
  sessionStore: SessionStore;
  catalog: CatalogStore;
  lineContent: LineContentClient;
  graph: GraphDriveClient;
  scanner?: VirusScanner;
  maxBytes?: number;
  lineDownloadTimeoutMs?: number;
  now?: () => Date;
}

export function createPendingAttachmentTextMessageHandler(
  options: PendingAttachmentTextMessageOptions
): TextMessageHandler {
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const publisher = createResourceBinaryPublisher({
    catalog: options.catalog,
    graph: options.graph,
    scanner: options.scanner,
    maxBytes
  });

  return {
    turnStage: "attachment",
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

      const stage = pending.stage ?? "awaiting_purpose";
      if (stage === "awaiting_opt_in") {
        if (!isOptIn(answer)) {
          return {
            ok: true,
            replyText: "請選擇「是」或「否」。",
            quickReplies: optInQuickReplies()
          };
        }
        await options.sessionStore.set(refreshPending(pending, "awaiting_purpose", now()));
        return purposePrompt();
      }

      if (stage === "awaiting_confirmation") {
        if (!isConfirm(answer)) {
          return {
            ok: true,
            replyText: "請回覆「保存」確認，或回覆「取消」。",
            quickReplies: confirmationQuickReplies()
          };
        }
        const claimed = await options.sessionStore.takePendingAttachment({
          profileName: context.profile.name,
          source: context.event.source,
          requesterUserId: context.event.source.userId
        });
        if (!claimed) {
          return { ok: true, replyText: "這個檔案保存流程已經在處理或已完成。" };
        }
        return publishAttachment({
          options,
          pending: claimed,
          maxBytes,
          now: now(),
          profile: context.profile,
          publisher
        });
      }

      if (stage === "awaiting_title") {
        const destination = pending.destination;
        if (!destination || !isAttachmentTargetKind(destination.itemKind)) {
          await options.sessionStore.delete(pending.id);
          return { ok: true, replyText: "保存流程已失效，請重新上傳檔案。" };
        }
        if (!answer) {
          return { ok: true, replyText: "請輸入這份檔案的名稱。" };
        }
        const target: AttachmentTarget = {
          sourceKey: destination.sourceKey,
          itemKind: destination.itemKind,
          domain: destination.domain,
          title: answer
        };
        const sourceGate = await findWritableSource(options.catalog, pending.profileName, target);
        if (!sourceGate.ok) {
          await options.sessionStore.delete(pending.id);
          return { ok: true, replyText: sourceGate.replyText };
        }
        const updated: PendingAttachmentSession = {
          ...refreshPending(pending, "awaiting_confirmation", now()),
          target: { ...target, declaredFileName: pending.attachment.fileName }
        };
        await options.sessionStore.set(updated);
        return confirmationPreview(updated, target);
      }

      const destination = parseAttachmentDestination(answer);
      if (!destination) {
        return purposePrompt();
      }
      const sourceGate = await findWritableSource(
        options.catalog,
        pending.profileName,
        destination
      );
      if (!sourceGate.ok) {
        await options.sessionStore.delete(pending.id);
        return { ok: true, replyText: sourceGate.replyText };
      }

      const updated: PendingAttachmentSession = {
        ...refreshPending(pending, "awaiting_title", now()),
        destination
      };
      await options.sessionStore.set(updated);
      return { ok: true, replyText: "請輸入這份檔案的名稱。" };
    }
  };
}

async function publishAttachment(input: {
  options: PendingAttachmentTextMessageOptions;
  pending: PendingAttachmentSession;
  maxBytes: number;
  now: Date;
  profile: BotProfileConfig;
  publisher: ReturnType<typeof createResourceBinaryPublisher>;
}): Promise<FunctionExecutionResult> {
  const sessionTarget = input.pending.target;
  if (!sessionTarget || !isAttachmentTargetKind(sessionTarget.itemKind)) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: "保存流程已失效，請重新上傳檔案。" };
  }
  const target: AttachmentTarget = {
    sourceKey: sessionTarget.sourceKey,
    itemKind: sessionTarget.itemKind,
    domain: sessionTarget.domain,
    title: sessionTarget.title
  };
  const sourceGate = await findWritableSource(
    input.options.catalog,
    input.pending.profileName,
    target
  );
  if (!sourceGate.ok) {
    await input.options.sessionStore.delete(input.pending.id);
    return { ok: true, replyText: sourceGate.replyText };
  }
  try {
    const content = await input.options.lineContent.getMessageContent(
      input.pending.attachment.messageId,
      input.profile,
      {
        maxBytes: input.maxBytes,
        timeoutMs: input.options.lineDownloadTimeoutMs ?? DEFAULT_LINE_DOWNLOAD_TIMEOUT_MS
      }
    );
    return await input.publisher.publish({
      binary: {
        data: content.data,
        declaredFileName: input.pending.attachment.fileName,
        declaredContentType: content.contentType,
        sourceKind: "line"
      },
      target: {
        profileName: input.pending.profileName,
        sourceKey: target.sourceKey,
        itemKind: target.itemKind,
        domain: target.domain,
        title: target.title
      },
      now: input.now
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "line_content_too_large") {
      return { ok: true, replyText: "檔案太大，無法保存。" };
    }
    if (code === "line_content_timeout") {
      return { ok: true, replyText: "下載檔案逾時，請重新上傳後再試。" };
    }
    if (code === "line_content_empty") {
      return { ok: true, replyText: "檔案是空的，無法保存。" };
    }
    throw error;
  } finally {
    await input.options.sessionStore.delete(input.pending.id);
  }
}

function parseAttachmentDestination(text: string): AttachmentDestination | undefined {
  const normalized = text.normalize("NFKC");
  if (/流行.*歌譜|歌譜.*流行/u.test(normalized)) {
    return {
      sourceKey: "pop_sheet_music",
      itemKind: "pop_sheet",
      domain: "sheet_music"
    };
  }
  if (/詩歌.*歌譜|歌譜.*詩歌|敬拜.*歌譜/u.test(normalized)) {
    return {
      sourceKey: "hymn_sheet_music",
      itemKind: "hymn_sheet",
      domain: "sheet_music"
    };
  }
  if (/投影片|簡報|ppt/i.test(normalized)) {
    return {
      sourceKey: "ppt_slides",
      itemKind: "ppt_slide",
      domain: "presentation"
    };
  }
  if (/小哈資料庫|教會資料|一般資料|文件|資料|圖片|照片/u.test(normalized)) {
    return {
      sourceKey: "xiaoha_database",
      itemKind: "church_document",
      domain: "general"
    };
  }
  return undefined;
}

async function findWritableSource(
  catalog: CatalogStore,
  profileName: string,
  target: AttachmentDestination
): Promise<{ ok: true; source: CatalogSourceRecord } | { ok: false; replyText: string }> {
  const sources = await catalog.listSources({
    profileName,
    enabled: true,
    sourceKeys: [target.sourceKey]
  });
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

function isConfirm(text: string): boolean {
  return /^(保存|確認|好|yes|y)$/iu.test(text.trim());
}

function isCancel(text: string): boolean {
  return /^(否|取消|不要|先不要|不用)$/u.test(text.trim());
}

function isOptIn(text: string): boolean {
  return /^(是|好|要|yes|y)$/iu.test(text.trim());
}

function refreshPending(
  pending: PendingAttachmentSession,
  stage: NonNullable<PendingAttachmentSession["stage"]>,
  now: Date
): PendingAttachmentSession {
  return {
    ...pending,
    stage,
    expiresAt: new Date(now.getTime() + ATTACHMENT_SESSION_TTL_MS).toISOString()
  };
}

function optInQuickReplies() {
  return [
    { label: "是", action: { type: "message" as const, label: "是", text: "是" } },
    { label: "否", action: { type: "message" as const, label: "否", text: "否" } }
  ];
}

function purposePrompt() {
  return {
    ok: true as const,
    replyText: "這個檔案要保存成哪一種用途？",
    quickReplies: [
      { label: "投影片", action: { type: "message" as const, label: "投影片", text: "投影片" } },
      {
        label: "流行歌譜",
        action: { type: "message" as const, label: "流行歌譜", text: "流行歌譜" }
      },
      {
        label: "詩歌歌譜",
        action: { type: "message" as const, label: "詩歌歌譜", text: "詩歌歌譜" }
      },
      {
        label: "小哈資料庫",
        action: { type: "message" as const, label: "小哈資料庫", text: "小哈資料庫" }
      }
    ]
  };
}

function confirmationPreview(pending: PendingAttachmentSession, target: AttachmentTarget) {
  const sourceLines =
    pending.attachment.messageType === "image"
      ? ["來源：LINE 圖片"]
      : [
          ...(pending.attachment.fileName ? [`檔名：${pending.attachment.fileName}`] : []),
          ...(pending.attachment.fileSize !== undefined
            ? [`大小：${formatBytes(pending.attachment.fileSize)}`]
            : [])
        ];
  return {
    ok: true as const,
    replyText: [
      "請確認要保存這個檔案：",
      `名稱：${target.title}`,
      ...sourceLines,
      `類型：${labelForItemKind(target.itemKind)}`,
      "確認後會下載、驗證並掃毒，通過後才會上傳到 OneDrive。"
    ].join("\n"),
    quickReplies: confirmationQuickReplies()
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
