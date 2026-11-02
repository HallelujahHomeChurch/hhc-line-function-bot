# Helper provider failover (default off)

Production profiles are unchanged. This feature is not deployed or live-accepted.
Only helper may explicitly opt into an OpenAI primary / DeepSeek fallback pair:

```json
{
  "allowedProviders": ["openai", "deepseek"],
  "agent": {
    "provider": "openai",
    "model": "gpt-6-luna",
    "summaryModel": "gpt-6-luna",
    "reasoningEffort": "none",
    "fallback": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "summaryModel": "deepseek-v4-flash"
    },
    "personaFile": "agents/helper/PERSONA.md",
    "memoryPolicyFile": "agents/helper/MEMORY.md"
  }
}
```

This is a partial profile example, not a replacement for the full production
profile. Both API keys must be supplied through local/ACA secrets. Redis is
required when fallback is configured, and production retains its PostgreSQL
requirement. Main, non-agent lanes, group admission, history collection and all
server-side tool/review authority remain unchanged. Never use Codex subscription
credentials or any desktop agent's configuration for this feature.

## Continuation contract

The same helper SDK agent retries only a failed model generation. It keeps the
already completed tool results and scoped conversation, never invokes the whole
runtime again, and never resets model/tool budgets. Primary and fallback disable
SDK retries in this mode and cap each provider attempt at eight seconds; each HTTP attempt consumes the existing four-request
budget, including summary calls. Cancellation and budget exhaustion do not cause
fallback. No new semantic classifier, router or background model probe is added.

The current SDK clones a plain ChatOpenAI when binding tools; the narrow adapter
preserves the failover wrapper when binding configuration. Generation is buffered
with streaming disabled, so partial output/tool calls cannot execute or become
checkpoint messages. DeepSeek receives text roles and structured tool-call/result
pairs only, without OpenAI private metadata/reasoning. Unsupported message formats
fail closed. Both primary and summary calls share the selected provider.

The server persists a DeepSeek pin before the fallback request, even if it fails.
The pin applies conservatively to the entire requester checkpoint: follow-ups,
clarifications and drafts stay on DeepSeek until `/reset`, policy change, or the
existing idle expiry (15 minutes groups, 30 minutes direct). We do not guess task
completion from generated text. This intentionally delays failback compared with
switching every new message. A fresh/unpinned context can use recovered OpenAI.
Ordinary historical evidence invalidation and group/requester isolation still
apply. Review tokens and completed side effects remain server-owned.

## Failure and recovery

Connection/timeout, HTTP 408/429/5xx errors may trigger one switch. HTTP 401/403
and explicit quota exhaustion also switch but open a longer circuit. Invalid
arguments, unavailable tools, policy denial, content refusal, malformed messages,
cancellation and local programming/storage failures are not rerouted.

The shared Redis circuit opens for 60 seconds after transient errors and one hour
after authorization/permission or explicit quota errors. After the cooldown, only
one real unpinned request obtains a 30-second recovery lease; successful inference
closes it. A crashed probe loses its lease and another request may probe later.
Stale probe owners cannot close a newer circuit. No paid keepalive is scheduled.
The recovering marker expires after 24 hours. If Redis is unavailable, fail closed
rather than perform uncoordinated provider requests. A lost Redis store is not
proof of provider recovery and still requires the repository's recovery procedure.

Traces include a finite switching reason (pinned/circuit_open/transient/permanent),
per-provider and response/summary-role HTTP attempts (map each role to the
reviewed profile model), returned input/output/cache usage and
missing-usage request counts, plus aggregate totals. Failed requests may still be
billed; absent usage is unknown, not free. Reconcile actual invoices with dated
provider pricing before claiming savings. SDK logical-call estimates are not a
substitute for provider usage and may undercount an interrupted primary's input.
No model-quality, live latency or cost winner has been measured.

## Migration, release and rollback

Helper state setup adds one backward-compatible column (no new table):

```sql
ALTER TABLE agent_sdk_threads
  ADD COLUMN IF NOT EXISTS fallback_pinned boolean NOT NULL DEFAULT false;
```

The idempotent setup follows existing helper-state migration ownership. Test on a
restored staging schema before production; do not run this against production as
part of code/CI validation. No existing row is deleted by migration. Enabling or
changing the fallback pair rotates the checkpoint policy key; old short-lived
context cannot be interpreted under a different contract. Durable results and
approval checks remain separate. Rollback disables fallback through a reviewed
profile release; retain the added column and durable result records, never replay
uncertain work or revert strict group admission.

Release order: optional private CONNECT transport and secured Windows/bastion
service; offline-verified fallback code; separately reviewed profile activation.
Proxy configuration alone does not enable fallback. Validate actual-origin API
eligibility and metadata independently of paid inference. Real LINE/provider and
Windows boot-before-login checks require their own authorization and evidence.
Do not merge deploy-triggering PRs or enable auto-merge at the CI-only stop gate.

## Offline evidence

`helper-provider-failover.test.ts` uses actual SDK adapters with synthetic fetches:
completed-tool continuation, shared budget, summaries, scoped pin reset/isolation,
both-provider failure, denied non-availability errors and private metadata removal.
The real-dependency integration evaluator checks PostgreSQL pin persistence across
new runtime instances/failures and Redis multi-client probe ownership/reconnect.
Existing review, history, quote, deferred-result and admission suites remain the
regression boundary. None of these are production LINE acceptance.
