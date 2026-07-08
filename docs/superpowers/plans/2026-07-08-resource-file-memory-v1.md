# Resource File Memory v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users explicitly ask Xia ha to remember uploaded LINE files as controlled resource memories, so later function searches can include both existing OneDrive/Graph files and user-collected files.

**Architecture:** Keep the current controlled agent runtime and resource memory model. Add a storage port for durable file objects, use Azure Blob as the first implementation, store only stable metadata in Postgres, and route remembered files through the same resource search path already used by external links and Graph resources.

**Tech Stack:** TypeScript, Fastify, LINE Messaging API SDK, Azure Blob Storage, Postgres, Redis-backed session store when configured, Vitest, pnpm.

## Global Constraints

- User data collection must be explicit; never save normal group chatter or unsolicited files automatically.
- The first version supports LINE `file`, `image`, and `video` message content as stored binary resources, but only `file` and common document/image extensions are searchable by title.
- Do not store generated Graph sharing links in memory; store durable storage metadata only.
- Do not expose Azure Blob container names, account names, SAS tokens, tenant ids, group ids, or user ids in committed docs/config.
- Group sessions must stay requester-scoped by LINE `source.userId`.
- If Redis is configured, pending file-save state must survive restarts and multiple replicas; otherwise the existing in-memory behavior is acceptable locally.
- Pushing to `main` deploys through Azure DevOps; do not push until deployment is intentionally requested.

---

## Product Behavior

### Supported User Flow

1. User sends a LINE file or image.
2. Bot does not save it immediately.
3. Bot creates a short pending attachment session and replies with a soft prompt such as: `收到檔案了。若要保存，請回覆：小哈幫我記住這個，名稱：...，類型：投影片/樂譜/資料`.
4. User replies with an explicit save request within the session TTL.
5. Bot validates requester/source, downloads the LINE content, uploads it to Azure Blob, records a resource memory row, and replies with the saved name and memory id.
6. Later searches for投影片 or流行歌譜 include the stored file alongside OneDrive/Graph and external-link memories.

### Deny / Clarification Behavior

- If a user sends a file but never asks to save it, the bot forgets the pending session after TTL.
- If the save request lacks title, ask: `要用什麼名稱保存這個檔案？`
- If the save request lacks type, ask: `這份檔案要保存成投影片、樂譜，還是一般資料？`
- If the file type is unsupported, reply: `這個檔案格式目前還不能保存，請改用 PDF、PPT、PPTX、圖片或一般文件。`
- If the matching pending attachment belongs to a different requester in a group, ignore it and do not save.

## File Structure

- `src/types.ts`: Extend `AgentResourceStorage` with a `blob` provider.
- `src/storage/resource-object-store.ts`: Create storage port and object metadata types.
- `src/storage/azure-blob-resource-store.ts`: Implement Azure Blob upload and read-link creation.
- `src/clients/line-content.ts`: Create a small LINE content download client wrapping Messaging API content fetch.
- `src/state/session-store.ts`: Add pending attachment session type.
- `src/agent/agent-runtime.ts`: Detect explicit save intent for a pending attachment and record the resource.
- `src/agent/memory-store.ts`: Support `blob` resources in in-memory memory store.
- `src/agent/postgres-memory-store.ts`: Support `blob` resource insert/read/search mapping.
- `src/agent/migrations.ts`: Add blob columns and constraints to `agent_resources`.
- `src/functions/find-ppt-slides.ts`: Return saved blob resources in the existing merged candidate flow.
- `src/functions/find-pop-sheet-music.ts`: Return saved blob resources in the existing merged candidate flow.
- `src/functions/modules.ts`: Pass object store dependency into file-capable functions if needed for read links.
- `src/server.ts`: Capture LINE file/image/video events and create pending attachment sessions after access/engagement checks.
- `src/config.ts`: Add Azure Blob and attachment-memory config.
- `src/index.ts`: Wire LINE content client, object store, config, and runtime dependencies.
- `.env.example`: Document placeholder env vars.
- `README.md`: Document user-facing file memory behavior and limits.
- `docs/architecture-context.md`: Update the agent runtime and memory cookbook.
- Tests:
  - `src/__tests__/agent-file-memory.test.ts`
  - `src/__tests__/entrance.test.ts`
  - `src/__tests__/functions.test.ts`
  - `src/__tests__/sheet-music.test.ts`
  - `src/__tests__/config.test.ts`

## Interfaces

### Resource Storage Type

```ts
export type AgentResourceStorage =
  | { provider: "graph"; driveId: string; itemId: string }
  | { provider: "external_link"; url: string; sourceLabel?: string; description?: string }
  | {
      provider: "blob";
      container: string;
      blobName: string;
      contentType?: string;
      originalFileName?: string;
      sizeBytes?: number;
      sha256?: string;
    };
```

### Object Store Port

```ts
export interface ResourceObjectUploadInput {
  profileName: string;
  sourceKey: string;
  resourceType: AgentResourceRecord["resourceType"];
  originalFileName?: string;
  contentType?: string;
  body: Buffer;
}

export interface ResourceObjectUploadResult {
  storage: Extract<AgentResourceStorage, { provider: "blob" }>;
}

export interface ResourceObjectReadLinkInput {
  storage: Extract<AgentResourceStorage, { provider: "blob" }>;
  expiresAt: string;
}

export interface ResourceObjectStore {
  upload(input: ResourceObjectUploadInput): Promise<ResourceObjectUploadResult>;
  createReadLink(input: ResourceObjectReadLinkInput): Promise<string>;
}
```

### Pending Attachment Session

```ts
export interface PendingAttachmentSession {
  id: string;
  type: "pending_attachment";
  profileName: string;
  requesterUserId?: string;
  source: LineSource;
  messageId: string;
  lineMessageType: "file" | "image" | "video";
  originalFileName?: string;
  contentType?: string;
  sizeBytes?: number;
  expiresAt: string;
}
```

## Tasks

### Task 1: Blob Storage Metadata And Migrations

**Files:**

- Modify: `src/types.ts`
- Modify: `src/agent/memory-store.ts`
- Modify: `src/agent/postgres-memory-store.ts`
- Modify: `src/agent/migrations.ts`
- Test: `src/__tests__/agent-file-memory.test.ts`

**Interfaces:**

- Consumes: existing `AgentResourceRecord`, `AgentResourceStorage`, `AgentMemoryStore`.
- Produces: `blob` storage support in all memory store implementations.

- [ ] Add failing tests for in-memory and Postgres mapping of a `blob` resource.
- [ ] Run `pnpm vitest run src/__tests__/agent-file-memory.test.ts` and verify failures mention unsupported `blob` provider or missing columns.
- [ ] Extend `AgentResourceStorage` with the `blob` variant from the Interfaces section.
- [ ] Add nullable columns in migration:
  - `blob_container text`
  - `blob_name text`
  - `content_type text`
  - `original_file_name text`
  - `size_bytes bigint`
  - `sha256 text`
- [ ] Update `agent_resources_storage_provider_check` to allow `blob`.
- [ ] Update shape constraints so `blob` rows require `blob_container` and `blob_name`.
- [ ] Update Postgres insert/read mapping for `blob` storage.
- [ ] Update in-memory search to include `originalFileName` and `blobName` as searchable fields.
- [ ] Run `pnpm vitest run src/__tests__/agent-file-memory.test.ts` and verify pass.

### Task 2: Resource Object Store

**Files:**

- Create: `src/storage/resource-object-store.ts`
- Create: `src/storage/azure-blob-resource-store.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`
- Test: `src/__tests__/config.test.ts`
- Test: `src/__tests__/agent-file-memory.test.ts`

**Interfaces:**

- Consumes: `AgentResourceStorage` blob variant.
- Produces: `ResourceObjectStore`, `AzureBlobResourceObjectStore`.

- [ ] Add tests proving config accepts placeholder Azure Blob settings and rejects attachment memory when container config is missing.
- [ ] Add unit tests using a fake Azure Blob client to verify uploaded blob path contains profile, source hash, resource type, and a generated id.
- [ ] Run targeted tests and verify failures refer to missing store/config wiring.
- [ ] Add env vars:
  - `RESOURCE_FILE_MEMORY_ENABLED`
  - `AZURE_BLOB_ACCOUNT_URL`
  - `AZURE_BLOB_CONTAINER_NAME`
  - `AZURE_BLOB_UPLOAD_PREFIX`
  - `RESOURCE_FILE_MAX_BYTES`
  - `RESOURCE_FILE_SESSION_TTL_SECONDS`
- [ ] Implement `ResourceObjectStore` port exactly as defined above.
- [ ] Implement Azure Blob upload using managed identity/default Azure credential where available.
- [ ] Implement read links as short-lived SAS URLs if account permissions allow it; otherwise return a controlled failure message until a read-link strategy is configured.
- [ ] Wire a disabled no-op store when `RESOURCE_FILE_MEMORY_ENABLED=false`.
- [ ] Run targeted tests and verify pass.

### Task 3: LINE Attachment Session Intake

**Files:**

- Create: `src/clients/line-content.ts`
- Modify: `src/state/session-store.ts`
- Modify: `src/server.ts`
- Test: `src/__tests__/entrance.test.ts`

**Interfaces:**

- Consumes: LINE file/image/video message events and existing `SessionStore`.
- Produces: `PendingAttachmentSession` rows.

- [ ] Add entrance tests proving file/image/video messages create pending attachment sessions only after profile/access checks pass.
- [ ] Add tests proving unsupported sources or blocked users do not create pending sessions.
- [ ] Add tests proving the reply contains a save instruction but no file is downloaded yet.
- [ ] Run `pnpm vitest run src/__tests__/entrance.test.ts` and verify failures refer to missing pending attachment handling.
- [ ] Add `PendingAttachmentSession` to `ConversationSession`.
- [ ] Add `findPendingAttachment(lookup)` to `SessionStore`.
- [ ] In `server.ts`, handle LINE `message` events of type `file`, `image`, and `video` after access/engagement checks.
- [ ] Create requester-scoped pending session using LINE `message.id`.
- [ ] Reply with a concise save prompt and examples.
- [ ] Run entrance tests and verify pass.

### Task 4: Explicit Save Flow In Agent Runtime

**Files:**

- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/agent-file-memory.test.ts`

**Interfaces:**

- Consumes: `PendingAttachmentSession`, `LineContentClient`, `ResourceObjectStore`, `AgentMemoryStore`.
- Produces: saved `blob` resource memory.

- [ ] Add tests for successful save: pending attachment + `小哈幫我記住這個，名稱：青年主日，類型：投影片`.
- [ ] Add tests for missing title, missing type, unsupported file extension, expired session, and different requester.
- [ ] Add tests proving the LINE content is downloaded only after explicit save intent.
- [ ] Run targeted tests and verify failures refer to missing save flow.
- [ ] Add a deterministic parser for attachment save intent:
  - save words: `記住`, `保存`, `儲存`, `收起來`, `留下`
  - current attachment references: `這個`, `這份`, `剛剛`, `這張`
  - title markers: `名稱`, `標題`, `名字`, `叫做`
  - type words:
    - `投影片`, `簡報`, `ppt`, `powerpoint`, `slide` -> `ppt_slide`
    - `樂譜`, `歌譜`, `sheet music` -> `sheet_music`
    - `資料`, `文件`, `檔案` -> `document`
- [ ] Add extension/content-type allowlist:
  - `ppt_slide`: `.ppt`, `.pptx`, `.pdf`
  - `sheet_music`: `.pdf`, `.jpg`, `.jpeg`, `.png`
  - `document`: `.pdf`, `.doc`, `.docx`, `.xlsx`, `.txt`, `.jpg`, `.jpeg`, `.png`
- [ ] Download LINE content with `LineContentClient.getMessageContent(messageId)`.
- [ ] Enforce `RESOURCE_FILE_MAX_BYTES` before upload.
- [ ] Upload to `ResourceObjectStore`.
- [ ] Record `AgentResourceRecord` with `storage.provider="blob"`.
- [ ] Delete the pending attachment session after successful save.
- [ ] Run targeted tests and verify pass.

### Task 5: Function Recall For Saved Files

**Files:**

- Modify: `src/functions/find-ppt-slides.ts`
- Modify: `src/functions/find-pop-sheet-music.ts`
- Modify: `src/functions/modules.ts`
- Test: `src/__tests__/functions.test.ts`
- Test: `src/__tests__/sheet-music.test.ts`

**Interfaces:**

- Consumes: `blob` resource memories.
- Produces: search results and selection replies that can return short-lived blob read links.

- [ ] Add tests proving saved `blob` PPT resources appear in merged PPT selection with Graph and external-link candidates.
- [ ] Add tests proving saved `blob` sheet music resources appear in merged sheet music selection with Graph and external-link candidates.
- [ ] Add tests proving selecting a `blob` candidate calls `ResourceObjectStore.createReadLink` and does not call Graph `createSharingLink`.
- [ ] Run targeted tests and verify failures refer to missing blob candidate reply.
- [ ] Extend remembered-resource reply helpers to support `storage.provider === "blob"`.
- [ ] Use the same 24-hour expiration policy as Graph sharing links.
- [ ] Keep exact remembered title match behavior: exact memory match can return immediately; fuzzy/multiple matches create selection.
- [ ] Run targeted tests and verify pass.

### Task 6: Documentation And Operations

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture-context.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Test: docs/config verification by command.

**Interfaces:**

- Consumes: completed feature behavior.
- Produces: clear operator and future-agent guidance.

- [ ] Document user-facing behavior:
  - files are not saved unless user explicitly asks
  - saved resources can later appear in投影片 and歌譜 search
  - unsupported formats are denied
  - admins can inspect memory via existing memory commands
- [ ] Document Azure Blob env vars as placeholders only.
- [ ] Update architecture guide to say LINE attachment storage is now supported through the explicit save flow.
- [ ] Update AGENTS to mention that resource files use Blob metadata and must not save raw group chatter.
- [ ] Run `pnpm format:check`.
- [ ] Run `git diff --check`.

### Task 7: Full Verification And Commit

**Files:**

- All files touched by Tasks 1-6.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: one local feature commit ready for review/deploy decision.

- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm eval:router`.
- [ ] Run `pnpm eval:admin`.
- [ ] Run `pnpm build`.
- [ ] Run `git diff --check`.
- [ ] Commit locally with message `feat: add resource file memory intake`.
- [ ] Do not push unless the user explicitly asks to deploy.

## Rollout Notes

- First deploy should enable `RESOURCE_FILE_MEMORY_ENABLED=false` until Azure Blob permissions are confirmed.
- After deployment, enable in one profile first, preferably `helper`.
- Smoke test direct chat before group chat:
  - send file
  - save with title/type
  - search same title
  - delete memory with `/forget-memory <id>`
- Keep old external-link resource memory behavior unchanged.

## Follow-Up After v1

- Add optional OCR/text extraction for image/PDF resources.
- Add admin retention policy and cleanup command for old blob resources.
- Add RAG indexing only after file save/delete lifecycle is stable.
- Add OneDrive upload as an alternate object-store implementation if church operators prefer files to land in SharePoint.

## Self Review

- Spec coverage: The plan covers explicit file intake, storage, Postgres memory, function recall, session safety, docs, and verification.
- Placeholder scan: No task depends on an undefined value; config names, interfaces, supported types, and expected behavior are explicit.
- Type consistency: `blob` storage is defined once and consumed by memory stores, object store, runtime save flow, and function recall.
- Scope check: OCR, RAG, and permanent knowledge indexing are intentionally follow-ups so v1 remains a testable resource collection feature.
