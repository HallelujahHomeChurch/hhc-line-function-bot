# Architecture Context

Use this document to locate the current request path and the boundary that owns a change. The runtime is a modular monolith with one profile dispatcher, one helper agent, and one deterministic main runtime.

## Request Flow

```text
LINE webhook
  -> src/transport/line/webhook-routes.ts
     signature/profile/access/engagement/idempotency
     commands, postbacks, attachment and selection exceptions
  -> src/runtime/profile-runtime.ts
     -> helper: src/helper-agent/runtime.ts
     -> main:   src/runtime/main-runtime.ts
```

`src/bootstrap/create-production-runtime.ts` is the sole production composition root. It creates adapters, stores, profile runtimes, cleanup timers, and shutdown hooks. Production code must not import the in-memory builders under `src/testing`.

Cross-capability execution and routing contracts remain under `src/application/contracts/`; product behavior and definitions remain under `src/capabilities/`.

Ingress never selects a semantic function. It validates the event and completes narrowly owned deterministic work before dispatch. Each configured profile maps to exactly one runtime; there is no runtime switch, shadow agent, or fallback semantic route.

## Profile Runtimes

`src/runtime/main-runtime.ts` owns public Weekly Paper download and Account-bound own-profile updates. It uses direct parsing and the shared action executor. `main` has an empty provider allowlist and must produce zero model and embedding requests.

`src/helper-agent/runtime.ts` owns addressed helper text and reviewed-action resume. For each turn it:

1. derives the requester-scoped thread;
2. resolves the current effective capability set;
3. enters the thread lock and observes expiry/policy changes;
4. creates authority-specific tools through the policy gateway;
5. invokes the one agent composition;
6. selects the latest-invoked authoritative domain result or bounded model reply;
7. records allowlisted metrics only.

A malformed group/direct event without `source.userId` does not receive a helper thread. One group member cannot see or resume another member's context, review, selection, consent, or durable result.

## Helper Agent And Context

`src/helper-agent/agent.ts` is the sole LangChain `createAgent` composition. DeepSeek is the only remote chat provider. It uses official context editing, summarization, HITL, model-call, and tool-call middleware plus exact duplicate-tool-call rejection.

`src/helper-agent/state.ts` owns HMAC-derived thread identity, checkpoint access, same-thread serialization, idle metadata, explicit reset, cleanup, and consented sheet-music mode.

| Boundary     |                    Normal | Consented sheet-music research |
| ------------ | ------------------------: | -----------------------------: |
| Model calls  |                         4 |                              6 |
| Tool calls   |                         4 |                              6 |
| Model output |                800 tokens |                     800 tokens |
| Tool result  | 2,000 chars or 10 records |      2,000 chars or 10 records |

Direct threads expire after 30 minutes idle; group/room threads after 15 minutes. Cleanup runs every five minutes. `/reset` and `忘記這段對話` delete only the current requester thread. A persona, memory-policy, safety-policy, or tool-contract change changes the policy key and clears the old checkpoint before another model call.

Context reduction is ordered:

1. tools bound results before checkpointing;
2. at about 8K input tokens, old tool outputs clear while the two newest remain;
3. at about 16K, the same DeepSeek provider creates a bounded summary while six recent messages remain;
4. summaries use at most about 512 output tokens and cannot grant authority or claim current data;
5. at 24K after reduction, the turn stops and asks the requester to narrow or reset.

Model retries and summaries count against the same run budget. A checkpoint failure returns a support response without calling the provider. A provider failure records only sanitized error metadata and returns an opaque support ID.

## Capability And Authority Boundaries

`src/capabilities/catalog.ts` is the canonical capability catalog. It owns metadata, semantic descriptions, strict argument schemas, and handler factories. `src/capabilities/names.ts` owns `CapabilityName`.

`src/helper-agent/read-tools.ts` exposes separate tools instead of a combined search tool:

| Tool                    | Authority                                    |
| ----------------------- | -------------------------------------------- |
| `get_official_schedule` | Formal `query_schedule` data                 |
| `find_presentation`     | Authorized presentation catalog/provider     |
| `find_sheet_music`      | Authorized sheet-music catalog/provider      |
| `find_resource`         | Authorized general resource catalog/provider |
| `search_knowledge`      | Current promoted knowledge snapshot          |
| `search_saved_notes`    | Notes visible to this requester/source       |
| `query_wikipedia`       | Fixed Wikipedia client                       |

`src/helper-agent/policy-gateway.ts` is the shared execution boundary. It counts the tool call, validates the strict schema, checks the LINE source, rechecks protected Account authorization, invokes the handler with trusted context, and projects bounded typed evidence. A missing authorizer fails closed for protected capabilities; profile-global unrestricted reads remain local.

Tool results keep `official`, `knowledge`, `saved_note`, and `public` authority separate. A saved note can supplement a schedule answer but cannot masquerade as the official schedule. Unavailable never becomes not-found.

Defaults belong to domain code. An omitted schedule period means the latest valid canonical schedule at server time. Catalog and knowledge reads use the latest atomically promoted revision. The model must not invent a date or version. Genuine ambiguity returns a focused clarification; the answer continues in the same requester checkpoint and calls the current authorized tool again.

Model evidence excludes internal source/document/item IDs, URLs, prompts, provider payloads, temporary sharing links, and authoritative LINE actions. The transport retains the full domain result for Quick Replies, downloads, previews, and terminal write status.

## Human Review And Actions

`src/helper-agent/write-tools.ts` exposes proposal tools only. The model never receives confirmation fields and cannot commit a write.

```text
complete proposal arguments
  -> LangGraph HITL interrupt
  -> server-rendered LINE preview
  -> approve, reject, or natural revision
  -> atomic requester/source review consume
  -> live authorization and revision checks
  -> src/runtime/action-executor.ts
  -> durable terminal result
  -> LINE reply
```

`src/helper-agent/review.ts` stores only an opaque nonce, scope, interrupt/tool identity, argument hash, policy key, expiry, and durable result pointer. It stores no arguments in postback data or review state. Reviews expire after five minutes and execute once. A natural revision rejects and consumes the original proposal, fails its pending result, and creates a new preview identity when the agent proposes revised arguments.

`src/runtime/action-executor.ts` owns schema validation, live authorization, policy/domain revision checks, idempotency, handler commit, and result persistence. A committed result is durable before LINE reply; if reply delivery or checkpoint persistence fails, the same requester/source can retrieve it without re-execution. `main` reuses this executor from its deterministic profile-update preview.

## Attachments And Public Research

`src/transport/line/attachment-intake.ts` is the sole executable attachment intake. Direct users must opt in; groups require a requester-scoped two-minute one-shot activation. Purpose, title, preview, and confirmation remain deterministic. Confirmation enqueues only an opaque work ID through the durable outbox.

The finite attachment worker uses its dedicated managed identity to download accepted LINE or external content, validates size/MIME/hash, and publishes only durable `clean` assets. Asset API is the sole owner of malware scanning and signature freshness. The bot process never downloads or scans the binary. Publishing claims and queue acknowledgement keep their existing idempotent fail-closed rules.

SearXNG is only a sheet-music fallback after a proven internal miss and atomic requester consent. In research mode the helper receives `search_sheet_music_web` and `read_sheet_music_page` and no unrelated write tools. Search results become invocation-local `web-N` references. The reader accepts only those refs, revalidates public HTTPS DNS/redirects, caps content, strips active markup, and marks page text untrusted. Page instructions cannot change tools, permission, or approval. Only a detected direct PDF/JPEG/PNG candidate can enter the existing import review and Asset-scanned attachment path.

## Persistence And Observability

Redis owns restart-safe sessions, one-shot postbacks, research consent, webhook idempotency, rate limits, recent errors, and long-running/review result jobs. Without Redis these guarantees are process-local.

PostgreSQL owns access/audit, catalog/schedule/knowledge/explicit-memory data, the official LangGraph checkpoint, and the existing `agent_sdk_threads` TTL metadata. Same-thread helper execution uses a dedicated advisory-lock pool so checkpoint queries do not consume the lock connection.

Operational traces allow only opaque request/thread correlation, source type, provider name, counts, bounded selected tool names, context-edit/summary flags, result class, latency, review lifecycle, and denial reason. Never record raw user text, group history, prompts, messages, page content, people, filenames, URLs, tool arguments, provider payloads, links, or secrets.

## Debug Map

- LINE request stops before dispatch: `src/transport/line/webhook-routes.ts`, `src/engagement.ts`, and `src/__tests__/entrance.test.ts`.
- Wrong profile runtime: `src/runtime/profile-runtime.ts` and `src/__tests__/profile-runtime.test.ts`.
- Wrong helper tool or source authority: `src/helper-agent/read-tools.ts`, `policy-gateway.ts`, and their focused tests.
- Follow-up, expiry, reset, or cross-requester leak: `src/helper-agent/state.ts` and `src/__tests__/helper-agent-state.test.ts`.
- Context editing, summary, or hard stop: `src/helper-agent/agent.ts` and `src/__tests__/helper-agent.test.ts`.
- Review, replay, revision, or durable result: `src/helper-agent/review.ts`, `src/runtime/action-executor.ts`, and helper review/runtime tests.
- Main Weekly Paper or profile update: `src/runtime/main-runtime.ts` and main runtime/direct-function tests.
- Attachment intake: `src/transport/line/attachment-intake.ts`; worker failures: `src/tools/run-attachment-worker.ts` and attachment worker tests.
- Public page validation: `src/clients/public-page.ts` and `src/__tests__/public-page.test.ts`.
- Need sanitized turn evidence: admin direct-chat `/last-agent-turns`, `/last-errors`, `/last-routes`, and `/diag`.

## Verification

Use the smallest focused test first, then the repository gates:

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm architecture:check
pnpm build
pnpm eval:agent
pnpm eval:sdk-agent
pnpm eval:kernel
pnpm eval:retrieval-product
pnpm eval:kernel:integration
```

`pnpm eval:agent`, `pnpm eval:sdk-agent`, and `pnpm eval:kernel` invoke one deterministic provider-free evaluator containing the 17 final runtime boundary IDs. Diagnose failures by boundary ID.

Run `pnpm eval:sdk-agent --live` manually only with an intentionally available `DEEPSEEK_API_KEY`. It runs nine bounded, deidentified synthetic cases and prints only `caseId`, `passed`, model/tool call counts, input/output/cache token counts, and latency. It never prints prompts, arguments, names, URLs, provider payloads, or secrets. CI never runs live provider checks.

Production release and real LINE delivery are separate gates. Offline evals and signed empty webhook probes do not establish real 1:1/group message-to-reply behavior.

## Release Evidence Boundary

R5.0 describes the prior controlled-agent release. The helper SDK redesign requires a new PR, release, and production acceptance before it can inherit those claims. No SaaS or local-model follow-up is implied.
