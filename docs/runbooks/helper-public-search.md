# Helper explicit public search (P3)

The user authorized production release and chose manual LINE testing instead of further
paid pre-release acceptance. Offline contracts and release probes still run. The adapter's
actual account/proxy compatibility and answer quality remain manual observation items;
an unsupported response returns unavailable, never a fabricated search answer.

## Product boundary

`小哈，公開搜尋：<new public question>` is an explicit outbound action. The server extracts
only the single-line question after that prefix, at most 2,000 UTF-8 bytes. The tool takes
no query argument, so a model cannot replace it with a query inferred from private context.
Do not include private information in a question intended for public search. Sources and
the answer are displayed directly by the server. No local operations, arbitrary HTTP/SQL,
MCP, login, publishing, binary download, SearXNG, or retired sheet-music research is enabled.

Only helper enables `query_public_web`; main remains provider-free. The Responses adapter
uses the existing OpenAI API key and client-owned proxy. The main agent remains on Chat
Completions. Search failures do not invoke DeepSeek or retry the hosted tool.

## Lifecycle and authority

- The read gateway enforces one isolated read per turn and excludes same-turn writes.
- The adapter receives a fresh public question, fixed instructions and only hosted web
  search. It receives no agent messages, private notes, quotes or internal tools.
- Raw answers/citations are not projected to the agent. `contextPolicy: status_only`
  substitutes fixed status text in checkpoint/quote projections and suppresses group
  history ingestion. The source marker is preserved in combined replies and jobs.
- A result is stored in the existing requester/profile/source-scoped job store for ten
  minutes, with an immutable completed result and quote-generation token. The user can
  explicitly select its displayed ID in a later `保存搜尋結果 <ID>` message.
- The existing `save_memory` handler loads the server original, checks current scope,
  capability, generation and expiry, then creates a complete normal confirmation preview.
  Confirmation rechecks current Account authorization and the source's validity. Nothing
  is saved by a search or model response. Saved notes retain the existing thirty-day TTL.
- External drafts can be re-previewed/cancelled; their raw text is not available to draft
  reading tools. To rewrite before saving, the user supplies a new body explicitly.
- Reset, withdrawal/generation change, expiry, missing provenance and another requester
  fail closed. No recovery from a conversation summary. Provider failures never turn into
  a fake successful search, even if the main agent has a configured fallback.

## Quotas, cost and observability

Fixed bounds: one hosted tool call, 800 output tokens including reasoning, low search
context, eight-second request timeout, zero retries, `store: false`, Standard tier.
Search uses the shared four-model-call turn budget in addition to its own daily reservation.
Redis atomically reserves a profile count, requester count and opaque event dedup key:
twenty per helper profile / three per requester per UTC day. Unknown completion and
failures are never refunded. Repeated webhook/tool attempts cannot reserve the same event.
Missing Redis or quote storage disables the handler; Redis errors deny reservation.

As checked on 2026-11-02, [Luna Standard pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
is US$0.10 input / US$0.50 output per million short-context tokens; [web search pricing](https://developers.openai.com/api/docs/pricing)
is US$0.01 per search call plus search-content input tokens. The [Responses tool cap](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
limits built-in calls; [web search context](https://developers.openai.com/api/docs/guides/tools-web-search)
is limited to 128k. Low context is not an exact token count. For this fixed one-call,
non-reasoning adapter, US$0.25 per attempt is a deliberately conservative planning bound,
including ample headroom over 128k search tokens, the small input and capped output.
Twenty daily reservations imply at most US$5/day (US$155 for a 31-day month) under these
documented rates and bounds. This is not an account billing cap or a bound on other agent,
summary, embedding, or unrelated service costs. Recheck rates and disable the capability
if provider tool/billing semantics change; do not enable unlimited research.

`helper.public_search` logs completed input/output tokens and hosted-call count, or
`unavailable` with `usageUnknown: true`. It never logs questions, bodies, sources or IDs.
Main-agent traces count the adapter request but do not duplicate its token usage; use the
search event's tokens when aggregating model + search costs. For failures, retain a full
conservative reservation until the provider's account usage clarifies actual billing.
Compare OpenAI project usage with the counts, including failed requests; do not interpret
zero missing metrics as free execution. No new billing database or automatic monitor exists.

Daily hard limits require the existing durable Redis deployment and recovery discipline.
During Redis-loss recovery, disable `query_public_web` until AOF/backup quota state and
dedup state are restored, or keep search closed until the next UTC day. Missing cache is
not evidence that no paid request ran. Follow `redis-loss-recovery.md`; never reset quotas
as a retry workaround.

## Manual checks and rollback

After release, manually try an explicit public query, inspect clickable citations, save
the result through a separate preview/confirmation, reset and try the old ID, and try an
ordinary conversation without searching. Group use must still explicitly address the bot.
Do not send sensitive queries for testing. No synthetic paid requests were made for P3
after the user's stop request. No claim of live search quality/latency acceptance is made.

Disable only `query_public_web` in the helper profile through the normal PR/release path
to stop new search and source-result saving; ordinary conversation and existing notes
continue. No schema migration or infrastructure change is needed. Retained search jobs
expire automatically; do not replay unknown provider results or reset Redis counters.
