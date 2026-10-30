# Helper provider configuration and comparison

The helper retains one `createAgent` runtime. DeepSeek remains the production
selection. This delivery does not change secrets, invoke models, merge or deploy.
`main` retains `allowedProviders: []` and no model/embedding calls.

For a separately approved OpenAI trial, retain the helper prompt paths and add
`openai` to its `allowedProviders`. Set `agent.provider` to `openai`, `agent.model`
to an explicitly chosen tool-capable OpenAI model and `agent.summaryModel` to the
chosen summary model. Both models use the same provider and shared request budget.
Keep `LLM_PROVIDER=deepseek` for existing non-agent lanes; helper selection is
profile-owned. There is no automatic provider fallback. A denied allowlist or
missing OpenAI model fails configuration validation. `OPENAI_API_KEY` comes only
from local environment or an ACA secret; never put it in profiles or PostgreSQL.
The checked-in production selection stays DeepSeek. Explicit `agent.model` and
`agent.summaryModel` override the legacy helper `DEEPSEEK_MODEL` fallback; compare
the current runtime model with the reviewed profile before approving a release. Changing provider/model/
summary model changes the checkpoint policy key before another turn.

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
