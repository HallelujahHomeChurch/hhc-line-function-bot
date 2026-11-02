# Helper provider configuration and comparison

The shipped helper profile selects DeepSeek `deepseek-v4-flash` for both responses
and summaries. The OpenAI adapter and secret reference remain available for a
reviewed switch after production-origin availability is verified. It retains one
`createAgent` runtime. `main` retains `allowedProviders: []` and no model/embedding calls.

The [official Luna contract](https://developers.openai.com/api/docs/models/gpt-6-luna)
requires `reasoning_effort: none` for Chat Completions function calls. The pinned
SDK does not recognize Luna in its model-name detection, so the existing OpenAI
adapter sends `reasoning_effort` and the 800-token `max_completion_tokens` explicitly
without the incompatible legacy `max_tokens` field. This applies to response and
summary calls. Configuration rejects Luna without the explicit non-reasoning mode.

Keep `LLM_PROVIDER=deepseek` for existing non-agent lanes; helper selection is
profile-owned. DeepSeek remains allowed for these lanes and reviewed rollback.
Automatic provider fallback is default-off; only the explicitly configured helper
pair described in [fallback operations](helper-provider-failover.md) is supported. A denied allowlist or missing OpenAI
model fails configuration validation. `OPENAI_API_KEY` comes only from local
environment or an ACA secret; never put it in profiles or PostgreSQL. Explicit
`agent.model` and `agent.summaryModel` override the legacy `DEEPSEEK_MODEL`
fallback. Provider, model, summary model and reasoning mode participate in the
checkpoint policy key before another turn.

## Production switch

1. Before changing the production profile, verify a non-inference model-metadata
   request from the actual production origin. A local HTTP 200 does not prove
   production access. The 2026-10-31 rollout returned HTTP 403
   `unsupported_country_region_territory` from production, so the profile was
   restored to DeepSeek. Resolve supported deployment-region access before retrying;
   a dedicated, explicitly configured proxy is now supported, but requires its own
   deployment approval and supported-region eligibility check. Automatic fallback
   is not enabled by proxy configuration. Metadata success still does not prove
   inference permissions, credit availability, or answer quality.
2. Stage the operator-provided key as the bot's ACA `openai-api-key` secret without
   printing it. Keep existing secrets intact. The release manifest references it
   through `OPENAI_API_KEY`; deployment validates its presence and preserves it
   during retired-secret cleanup. Worker and assurance jobs receive no OpenAI key.
3. Merge the reviewed profile/runtime/deployment change only after required offline
   CI succeeds. The authorized production release runs the usual immutable-image,
   dependency and signed-empty-webhook checks without invoking either model.
4. Verify the deployed profile uses Luna/none for responses and summaries, the
   environment uses a secret reference, main stays provider-free, and group history
   stays disabled. A real LINE/provider turn and paid comparison require their own
   acceptance; empty webhook checks do not prove provider availability or quality.
5. Roll back via the normal known-good digest release, or a reviewed explicit
   DeepSeek profile/model change. Retain the A admission gate, existing data and
   secrets; disable fallback on rollback and never replay uncertain jobs.

`pnpm test src/__tests__/helper-provider-comparison.test.ts` exercises the same
strict tool journey through both actual SDK adapters using synthetic HTTP replies.
It verifies bounded output, tool execution and policy identity. This is transport
and behavior compatibility evidence, not a live quality, latency or cost result.
Normal CI and evaluators are offline even if API keys exist.

After separate paid-test authorization, run the same existing bounded live corpus
once per provider with the same selected cases and request cap:

```sh
pnpm eval:sdk-agent --live --provider=deepseek --model=deepseek-v4-flash --max-requests=40
pnpm eval:sdk-agent --live --provider=openai --model=REVIEWED_MODEL --max-requests=40
```

Do not run those commands during an ordinary verification task. They send only
checked-in synthetic journeys, never real group conversations. Each uses the same
tools, fixtures, assertions, normal/research call caps, 800-token response cap,
zero live-run retries and overall 500,000-token safety bound. The summary model in
the comparison fixture is the selected response model for both providers. Compare
success per task, all returned input/output/cache usage, total requests, repeated
user input, and latency; divide total task cost by successful tasks using dated,
reviewed provider prices. Report missing usage rather than treating it as free.
Keep failure/retry/summary costs in the numerator. No winner has been measured.

Runtime traces count each actual HTTP attempt (including retries) separately from
logical model calls, and retain confirmed returned input/output/cache counts separately
from approximate input/output estimates. They do not retain prompts, payloads,
keys or group text. Returned usage is not a complete billing reconciliation when
a provider fails before returning usage; reconcile missing requests separately.
Caching is counted input, not free stored memory. See the official
[Chat Completions usage contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Deployment and real LINE delivery need separate approval and acceptance. Rollback
selects the reviewed prior provider/models and rotates checkpoint identity; it
never enables a fallback router. Do not roll back phase A's admission gate.

## Dedicated OpenAI CONNECT transport (default off)

`OPENAI_PROXY_URL` optionally selects an HTTP(S) private relay origin for helper's
OpenAI response and summary clients. Credentials, paths, queries and fragments in
the URL are rejected. It never sets global proxy variables or a global dispatcher.
DeepSeek, LINE, Graph, Asset, embedding and provider-free main are unaffected.
The client permits only `https://api.openai.com:443`, rejects redirects and retains
normal TLS certificate validation. Proxy failure fails closed, without direct
OpenAI retry outside the configured path. Connections are bounded and destroyed
on runtime shutdown. No keys or decrypted content belong on the relay.

Before enabling, deploy the separately reviewed private bastion relay and Windows
service; restrict ACA-to-relay and bastion-to-Windows access and CONNECT targets.
Do not expose an unauthenticated relay publicly. Windows must use its own directory,
service identity and port, with Tailscale unattended and automatic service recovery;
never change Codex/other agent settings, system proxy, exit-node or default routing.
Validate denied sources/targets, TLS, proxy failure, and Windows boot before login
separately. Configuration inspection is not reboot acceptance. Deployment, reboot,
paid inference and real LINE tests are not part of offline CI.

Rollback: leave helper explicitly on DeepSeek or unset the optional proxy only
when direct OpenAI access is approved. Remove only dedicated relay/service rules.
No database migration or production profile change is required by this feature.
