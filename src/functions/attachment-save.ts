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
          profile: context.profile,
          publisher
        });
      }

      const target = parseAttachmentTarget(answer, pending);
      if (!target) {
        return {
          ok: true,
          replyText: "請先說明用途：投影片、流行歌譜、詩歌歌譜或教會資料。"
        };
      }
      const sourceGate = await findWritableSource(options.catalog, pending.profileName, target);
      if (!sourceGate.ok) {
        await options.sessionStore.delete(pending.id);
        return { ok: true, replyText: sourceGate.replyText };
      }

      const updated: PendingAttachmentSession = {
        ...pending,
        stage: "awaiting_confirmation",
        target: {
          sourceKey: target.sourceKey,
          itemKind: target.itemKind,
          domain: target.domain,
          title: target.title,
          declaredFileName: pending.attachment.fileName
        },
        expiresAt: new Date(now().getTime() + ATTACHMENT_SESSION_TTL_MS).toISOString()
      };
      await options.sessionStore.set(updated);

      return {
        ok: true,
        replyText: [
          "請確認要保存這個檔案：",
          `名稱：${target.title}`,
          `檔名：${pending.attachment.fileName ?? "未提供"}`,
          `類型：${labelForItemKind(target.itemKind)}`,
          `大小：${pending.attachment.fileSize ?? "未知"} bytes`,
          "確認後會下載、驗證並掃毒，通過後才會上傳到 OneDrive。"
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
      title: inferTitle(normalized, baseTitle)
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

async function findWritableSource(
  catalog: CatalogStore,
  profileName: string,
  target: AttachmentTarget
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

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "");
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
