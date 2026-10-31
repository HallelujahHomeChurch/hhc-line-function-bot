# Group conversation handoff acceptance

This application-only correction retains the explicit-admission boundary. No migration, provider switch, secret change, media binding or history activation is required. PR #142 is a separate held provider rollout.

## Offline evidence

Run the standard repository checks plus `eval:agent`, `eval:retrieval-product`, `eval:admin` and `eval:kernel:integration`. The signed webhook journeys in `quoted-continuation.test.ts` cover the exact capability menu, scoped click, free-text quote continuation, reset and ambient silence. `entrance.test.ts` retains the 30/60-item bound-media burst cases and checks both the ordinary and early manual media opt-in paths.

Before correction, the new cases fail for prefix greeting, capability menu variant, addressed reset, unrelated attachment quota and manual video/audio message-action buttons. After correction they pass without changing bare-text silence expectations. Synthetic model calls measure routing, not provider quality, cost or delivery latency.

## Authorized LINE device acceptance

After an explicitly approved release, use a registered test group and a separate test requester. Paid inference and test media publication require their own authorization; do not upload real private group data as a fixture.

1. Say `Hi 小哈`; expect one deterministic identity response. Third-person `你問小哈看看` and `小哈今天又亂回` remain silent.
2. Say `小哈 你能夠做什麼`; expect the current capability menu with real buttons. Select a read capability as the original requester. Another requester and a second click must not execute it.
3. For a free-text question, quote the Bot's reply and answer briefly. Bare group text remains silent, even immediately after a Bot question. Repeat with explicit invocation and verify context is retained without restating the whole task.
4. During an active conversation say `阿明，明天你幾點到？`; expect no reply, model/tool call, new waiting job or window refresh.
5. Use `小哈，忘記這段對話` or `/reset`; verify requester context, quote lineage and active approvals are cleared. Another requester's conversation is preserved.
6. Review and cancel a synthetic draft using its original action buttons. Quoting it with `確認` never approves it. Verify stale approval after editing is rejected.
7. In an already bound media group, test the approved image/file fixture burst: media sync owns intake and chat quota is untouched. Without a manual upload intent the Bot remains silent. Test manually opted-in image/file/video/audio separately; opt-in buttons must work through scoped postbacks. Do not create a new binding as part of this check.
8. Exercise a slow read, result replay, duplicate webhook and expired button. Results remain requester/source scoped and require current authorization. A process restart does not imply an in-process model operation resumes automatically.

Freeform model prompts that omit question punctuation still depend on the existing conversation prompt to explain quoting; check natural variants during separately authorized provider acceptance. Structured missing-input replies and finite choices have deterministic presentation.

## Rollback

Keep the current production revision until device acceptance. Use a reviewed application rollback that retains phase-A explicit admission; never roll back to the retired generic active-window/quoted-continuation classifier. This change does not alter persisted schemas or destructive cleanup. Existing group postbacks retain their current two-minute lifetime and state checks. Do not merge or deploy the held OpenAI rollout implicitly.
