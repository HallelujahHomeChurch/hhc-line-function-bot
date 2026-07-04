# B+ Router Quick Reply State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Azure OpenAI fallback and add conservative keyword fallback, LINE quick replies, postback-based selection state, PPT fuzzy search, and basic service schedule query parsing.

**Architecture:** Keep Ollama as the only LLM provider. Route technical Ollama failures to a deterministic keyword fallback; handle multi-result user choices through short-lived server-side sessions keyed by postback `requestId`. Function handlers own domain search quality, so `find_ppt_slides` handles fuzzy matching and selection, while `query_service_schedule` handles date/field parsing.

**Tech Stack:** TypeScript, Fastify, LINE Messaging API SDK, Microsoft Graph SDK, Notion SDK, Vitest, pnpm, Azure DevOps, ACR.

---

## File Structure

- `src/router.ts`: Remove Azure provider support and route Ollama technical failures to keyword fallback.
- `src/keyword-router.ts`: New deterministic router for conservative keyword matches.
- `src/messages.ts`: New centralized Traditional Chinese user-facing messages.
- `src/line-reply.ts`: New helpers for LINE quick reply payloads.
- `src/state/session-store.ts`: New in-memory TTL session store and session types.
- `src/functions/find-ppt-slides.ts`: Add fuzzy ranking, multi-result quick reply selection, and postback selection handler.
- `src/functions/query-service-schedule.ts`: Add query parsing for date/range/meeting/role and keep concise output.
- `src/functions/registry.ts`: Return function and postback registries.
- `src/server.ts`: Allow postback events, dispatch postback handlers, and send quick replies.
- `src/types.ts`: Remove Azure types and add quick reply/session/postback result types.
- `src/config.ts`, `src/index.ts`, `.env.example`, `README.md`, `aca.containerapp.yaml`, `package.json`: Remove Azure OpenAI configuration and document keyword fallback/state flow.
- `src/__tests__/*.test.ts`: Add/replace tests for router fallback, quick replies, state, fuzzy PPT search, and service schedule parsing.

## Tasks

### Task 1: Router and Azure OpenAI Removal

**Files:**

- Modify: `package.json`
- Delete: `src/clients/azure-openai.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/router.ts`
- Create: `src/keyword-router.ts`
- Test: `src/__tests__/router.test.ts`

- [ ] Write router tests proving Qwen success executes, Qwen explicit deny does not fallback, invalid JSON/timeouts use keyword fallback, disabled functions deny, and ambiguous keyword matches deny.
- [ ] Run `pnpm test src/__tests__/router.test.ts` and verify failures refer to missing keyword behavior/Azure provider shape.
- [ ] Implement `KeywordRouter` with rules: `find_ppt_slides` = `ppt`, `投影片`, `簡報`, `slides`; `query_service_schedule` = `服事表`, `服事`.
- [ ] Update `RouteResult.provider` to `ollama | keyword | router` and remove Azure OpenAI config/types/client.
- [ ] Run `pnpm test src/__tests__/router.test.ts` and verify pass.

### Task 2: LINE Quick Replies and Postback Sessions

**Files:**

- Modify: `src/types.ts`
- Create: `src/messages.ts`
- Create: `src/line-reply.ts`
- Create: `src/state/session-store.ts`
- Modify: `src/clients/line.ts`
- Modify: `src/server.ts`
- Test: `src/__tests__/entrance.test.ts`

- [ ] Write entrance tests proving deny replies include enabled-function quick replies, disabled functions are not suggested, postback events are allowed for allowlisted sources, and postbacks dispatch to handlers.
- [ ] Run `pnpm test src/__tests__/entrance.test.ts` and verify failures refer to missing quick reply/postback behavior.
- [ ] Extend `LineReplyClient.replyText(replyToken, text, options)` with optional quick reply items.
- [ ] Implement message-action quick replies for available functions and postback dispatch support.
- [ ] Implement `InMemorySessionStore` with TTL, source/requester binding, get/set/delete.
- [ ] Run `pnpm test src/__tests__/entrance.test.ts` and verify pass.

### Task 3: PPT Fuzzy Search and Selection Flow

**Files:**

- Modify: `src/functions/find-ppt-slides.ts`
- Modify: `src/functions/registry.ts`
- Test: `src/__tests__/functions.test.ts`

- [ ] Write tests proving `奇易恩點` can match `奇異恩典.pptx`, multiple close matches create a session and quick reply postbacks without creating links, and a selection postback creates exactly one 24-hour Graph link.
- [ ] Run `pnpm test src/__tests__/functions.test.ts` and verify failures refer to missing fuzzy/session behavior.
- [ ] Implement normalization, pinyin-like typo aliases for common Chinese same-sound cases, Dice coefficient scoring, extension priority, and top-candidate selection.
- [ ] Move link creation to single-result or postback-selection paths only.
- [ ] Run `pnpm test src/__tests__/functions.test.ts` and verify pass.

### Task 4: Service Schedule Query Parsing

**Files:**

- Modify: `src/functions/query-service-schedule.ts`
- Test: `src/__tests__/functions.test.ts`

- [ ] Write tests proving `本週服事` filters by current week, explicit `date` filters rows, and no result returns a concise message plus suggestions.
- [ ] Run `pnpm test src/__tests__/functions.test.ts` and verify failures refer to missing date/query parsing.
- [ ] Implement basic date parsing for today, tomorrow, this week, next week, `YYYY-MM-DD`, and `M/D`.
- [ ] Apply parsed date/meeting/role filters before formatting reply text.
- [ ] Run `pnpm test src/__tests__/functions.test.ts` and verify pass.

### Task 5: Documentation, Configuration, and Verification

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `aca.containerapp.yaml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Remove Azure OpenAI env vars, README references, ACA secrets, and `openai` dependency.
- [ ] Document ACR image, keyword fallback, quick reply/postback state, and in-memory TTL limitations.
- [ ] Run `pnpm install`.
- [ ] Run `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
- [ ] Commit and push the feature branch.

## Self Review

- Spec coverage: All requested B+ items have tasks: Azure removal, keyword fallback, quick replies, postback state, PPT fuzzy search, schedule parsing, docs.
- Placeholder scan: No placeholder task remains; each task states files, tests, implementation, and verification.
- Type consistency: Router provider type changes from `azure_openai` to `keyword`; function registry grows postback support; LINE reply client gains optional quick reply options.
