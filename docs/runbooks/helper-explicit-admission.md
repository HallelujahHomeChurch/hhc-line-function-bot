# Explicit group admission (phase A)

This source change is not production acceptance. No database migration or secret
change is required. B history and C provider switching are separate deliveries.

## Evidence

On base `4a3b748`, the synthetic diagnostic `diagnostic ambient chatter stays
silent with active=true` failed: `阿明，明天你幾點到？` produced
`synthetic unsolicited reply` through the real helper runtime and a fake model.
The no-window control passed. The replacement regression suite asserts zero
model requests, replies, jobs, quote indexing and window refresh for ambient
messages with and without a legacy active window. It also covers explicit
resumption, valid Bot quotes, quote approval rejection and the slow result button.
These are offline assertions, not measured live-model accuracy or token savings.

## Entry matrix

- Ordinary group text, natural-language system actions, draft edits, attachment
  title/purpose and numeric choices require a fresh invocation or valid Bot quote.
- Active windows, old checkpoints, drafts and attachment sessions confer no new
  speaking eligibility. Unknown/member quotes cannot invoke a model classifier.
- Exact slash commands retain their action/source policy. Quote text never
  confirms or cancels a write. Existing review postbacks retain their contract.
- Existing message-action group choices become two-minute, requester/source-bound,
  one-shot postbacks. They carry only an opaque menu ID and ordinal. The original
  handler still validates current session, permission and draft version. Without
  a session store the transport asks for a quote or explicit invocation instead.
- Non-text intake still requires the existing upload intent or media-sync policy.
- Result buttons recheck requester/source, quote generation and capability
  provenance. No result is pushed automatically by the persisted job store;
  in-process operations use the originally accepted request's reply token.

## Deployment and version handoff (separate authorization required)

1. Keep this PR unmerged until deployment is authorized. Record image digest,
   revision, Redis namespace and traffic before an approved release.
2. Drain old revisions and outstanding inline webhook requests before enabling
   new helper traffic. A source-only gate cannot stop a running old binary from
   completing an already accepted request. Do not blindly replay old pending jobs
   or webhook events. Preserve completed results for explicit requester retrieval.
3. Keep Redis and PG data intact. The v8 policy contract invalidates the old model
   checkpoint on reuse; persisted result retrieval remains separately authorized.
   Old approval evidence cannot grant new authority; a stale preview needs fresh
   validation/repreview. Do not bulk-delete jobs, drafts or application data.
4. Run provider-free gateway/revision checks, then use synthetic LINE group
   members to verify mention, conservative text invocation, Bot/member/unknown
   quote, buttons, free-text quote follow-up, bare numbers and same-person chatter.
5. Exercise old-window/draft/result state, redelivery, restart, two concurrent
   button clicks and expired/foreign buttons. Confirm ambient text produces no
   waiting reply, error notice, tool call or provider request. Repeat with a
   dependency failure. Real LINE delivery must be checked on devices.

## Rollback

Do not restore a revision that admits ambient text through windows or drafts.
Retain the admission gate in a reviewed forward correction. If safe helper
operation cannot be established, pause helper ingress under the gateway owner's
approved procedure while preserving main and durable results; do not infer a new
runtime feature flag or replay pending writes. This PR does not perform that
operational action.

## Measurement and remaining gates

Use synthetic fixed multi-turn tasks for correctness, completion rate, repeated
user input, all model/summary/retry/cache token counts, cost per successful task
and p50/p95 latency. Offline fake models do not measure provider tokens or cost.
No paid comparison, real-group ingestion or production migration is authorized.
Before B activation, separately approve shared-history disclosure (including future
members), notice/opt-out, per-group/global count and byte quotas, capacity baseline,
restore invalidation and quality/cost/latency thresholds. Nothing in A enables B.
