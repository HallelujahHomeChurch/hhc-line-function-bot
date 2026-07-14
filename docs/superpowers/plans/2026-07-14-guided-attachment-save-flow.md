# Guided Attachment Save Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit opt-in, purpose, title, and confirmation wizard for LINE attachments while making bot-authored copy use first-person self-reference.

**Architecture:** Keep the existing requester-scoped `pending_attachment` session and binary publisher. Extend only its state machine and destination metadata; preserve old live session shapes until their ten-minute TTL expires. Treat first-person copy as a profile prompt and tested static-copy contract rather than a runtime text rewrite.

**Tech Stack:** TypeScript 5.9, Fastify 5, LINE quick replies, Redis/in-memory sessions, Vitest 4, pnpm.

## Global Constraints

- The four purpose choices are `投影片`, `流行歌譜`, `詩歌歌譜`, and `小哈資料庫`.
- Bot-authored conversational copy uses `我`; wake words, examples, `我是小哈`, `小哈資料庫`, and product registration wording keep `小哈`.
- No LINE binary download, scan, OneDrive upload, or catalog write occurs before final `保存`.
- Existing size, MIME, extension, duplicate, ClamAV, OneDrive, catalog, permission, and requester-scope rules remain unchanged.

---

### Task 1: Attachment session state contract

**Files:**

- Modify: `src/state/session-store.ts`
- Test: `src/__tests__/attachment-save.test.ts`

**Interfaces:**

- Produces: `PendingAttachmentSession.stage` with `awaiting_opt_in | awaiting_purpose | awaiting_title | awaiting_confirmation` and optional `destination` without a title.
- Preserves: legacy optional stage and `target` compatibility for old Redis sessions.

- [ ] Add failing tests that seed `awaiting_opt_in`, assert yes/no transitions, and assert no binary calls.
- [ ] Run `pnpm vitest run src/__tests__/attachment-save.test.ts` and confirm the new tests fail on the current two-stage handler.
- [ ] Extend the session type with `destination?: { sourceKey; itemKind; domain }` and the four stages while retaining optional `stage` and old `target`.
- [ ] Re-run the targeted test and keep failures limited to missing handler behavior.

### Task 2: Guided attachment wizard

**Files:**

- Modify: `src/functions/pending-attachment.ts`
- Modify: `src/functions/attachment-save.ts`
- Test: `src/__tests__/attachment-save.test.ts`
- Test: `src/__tests__/entrance.test.ts`

**Interfaces:**

- `pendingAttachmentPrompt()` returns `要我幫忙保存這個檔案嗎？` with exact `是` and `否` quick replies.
- Purpose selection maps to a destination; title input promotes it to the existing complete `target` preview.

- [ ] Add failing entrance tests for initial `awaiting_opt_in`, exact prompt copy, and yes/no buttons.
- [ ] Add failing handler tests for no/cancel, four purpose buttons, all destination mappings, typed `教會資料`, required title, preview, legacy session continuation, and requester isolation.
- [ ] Run targeted attachment and entrance tests and verify expected failures.
- [ ] Change new sessions to `awaiting_opt_in`; implement explicit opt-in parsing and re-prompt behavior.
- [ ] Implement four-purpose selection, writable-source validation, `destination` storage, and `awaiting_title` prompt.
- [ ] Implement trimmed user title collection, complete `target` creation, preview, and final confirmation without changing the publisher.
- [ ] Refresh the ten-minute expiry after each successful transition and clear on cancel or non-writable destination.
- [ ] Treat legacy missing/`awaiting_purpose` and old `awaiting_confirmation` sessions as their old stages.
- [ ] Run targeted tests until green.

### Task 3: First-person bot copy contract

**Files:**

- Modify: `config/profiles.json`
- Modify: affected runtime copy in `src/server.ts`, `src/functions/find-ppt-slides.ts`, `src/functions/find-pop-sheet-music.ts`, and `src/functions/definitions.ts`
- Test: `src/__tests__/intro.test.ts`, `src/__tests__/entrance.test.ts`, resource-memory tests, and a focused copy-contract test if needed.

**Interfaces:**

- Production `conversationRulesPrompt` explicitly requires first-person `我` self-reference.
- Static conversational replies contain no third-person self-reference patterns.

- [ ] Add failing assertions for known third-person replies and the production prompt rule.
- [ ] Run the focused tests and confirm failures.
- [ ] Replace bot-authored third-person copy with first-person or neutral copy while preserving protected product/name contexts.
- [ ] Add the first-person instruction to the helper profile prompt.
- [ ] Re-run focused tests until green.

### Task 4: Documentation, full verification, and deployment

**Files:**

- Modify: `docs/superpowers/specs/2026-07-14-guided-attachment-save-flow-design.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] Update docs with the four-stage wizard, exact quick replies, legacy-session compatibility, and first-person copy rule.
- [ ] Run `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm eval:agent`; require zero failures.
- [ ] Review `git diff`, run `git diff --check`, and verify no unrelated or secret files are included.
- [ ] Commit the implementation on `main` and push `origin/main` as the user-approved deployment action.
- [ ] Monitor the matching Azure DevOps run to success; verify the new ACA revision is Healthy, receives 100% traffic, and uses the pushed image.
