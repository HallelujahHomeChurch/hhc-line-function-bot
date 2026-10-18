# LINE Bot closeout and release

Authorized scope: fix remaining LINE Bot issues, integrate its existing Account,
Website, Operations, Audit, Gateway and Admin dependencies, run CI/CD, deploy and
verify. No unrelated feature or production-data mutation is included.

## Three independent agents

1. Conversation/context: found completed result persistence was incorrectly shown
   as successful work when result.ok=false. Project it as failed without removing
   the recoverable result. Regression test added.
2. Account/member/media: no confirmed authorization defect; found three stale
   conflicts and producer/consumer rollout gates. Preserve LINE Login openid/profile
   plus existing HHC email verification. Never infer successful membership from
   dependency failures.
3. Delivery: found the first receipt/publication migration could automatically
   downgrade to incompatible workers. Add a v2 contract fence: legacy or mixed
   known-good runtimes require compatible forward recovery, never blind rollback.

## Deployment sequence

- Refresh existing isolated task branches against current origin/main and resolve
  only overlap, preserving newer platform changes. Required final-head CI is mandatory.
- Integrated Bot #109 contains #99-#108. Gateway #173 integrates #171/#172; Admin
  #252 includes #251. Verify ancestry and ship each integrated PR once; mark focused
  review PRs superseded after the integrated release, avoiding partial deployments.
- Deploy additive Account API, Web API, Audit and Operations producers first.
- Deploy Website target, then Bot with media controls disabled. Verify new Bot and
  worker digests, active worker replicas/revisions and old finite executions.
- Deploy Gateway routes, then Account FE and Admin consumers after their producer
  and Bot parsing are live. Confirm old Account replicas have drained.
- Keep lifecycle controls disabled unless the compatible worker set is proven and
  the normal reviewed configuration release is ready. No ad hoc image deployment.

## Acceptance evidence

Record exact merged commits, GitHub CI/CD runs, deployed immutable digests/revisions,
health/readiness and public route smoke. Signed empty webhooks are provider-free
and cannot prove actual LINE client delivery, member login or 30/60-photo device
acceptance. Preserve worktrees if release/follow-up remains incomplete.
