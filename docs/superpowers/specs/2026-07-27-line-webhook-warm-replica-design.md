# LINE Webhook Warm Replica Design

## Status

The user approved the recommended warm-replica direction on 2026-07-27. This
written specification is pending final review before implementation.

## Problem

The production bot currently declares `minReplicas: 0`. After an idle
scale-to-zero period, two real LINE webhook requests at 14:31 Taiwan time ended
at the public Gateway with HTTP 499 after about two seconds while ACA created a
new bot replica. A later delivery at 14:36 succeeded with HTTP 200 after the
replica was running.

The webhook entrance is latency-sensitive and must not depend on a cold
scale-from-zero path. Attachment scanning and ClamAV refresh are finite ACA Jobs
and are not part of this synchronous response path.

## Considered Approaches

1. Keep `minReplicas: 0` and accept LINE retries. This preserves the lowest idle
   cost but can silently delay or lose the first interaction after inactivity.
   It is rejected.
2. Keep scale-to-zero and add retry, buffering, or asynchronous acknowledgement
   infrastructure at the Gateway. This adds another delivery mechanism and
   substantially more operational complexity. It is rejected.
3. Keep one bot replica warm. This uses the existing architecture, removes the
   observed cold-start boundary, and is the selected approach.

## Design

- Change only the bot manifest in `aca.containerapp.yaml` from
  `minReplicas: 0` to `minReplicas: 1`.
- Keep `maxReplicas: 10`, bot resources at `0.5 CPU / 1 GiB`, probes, Dapr,
  ingress, and traffic behavior unchanged.
- Keep `hhc-searxng` at `minReplicas: 1`, `maxReplicas: 1`,
  `0.25 CPU / 0.5 GiB`.
- Keep the queue-triggered attachment scan job and weekly ClamAV refresh job as
  finite jobs; do not add replica settings to jobs.
- Update the production deployment-contract test so CI fails if the bot can
  return to scale-to-zero.
- Update the operations documentation to record that the webhook service is
  intentionally always warm and why.

## Verification

Before merge, run the repository's formatting, typecheck, lint, complete test,
build, architecture, deterministic agent, Kernel, and applicable manifest
contract gates.

After the deploy-triggering pull request merges:

- require a successful `Production Release`;
- verify the live bot reports `minReplicas: 1`;
- verify the latest and latest-ready revision match, is healthy, and receives
  100 percent traffic;
- verify at least one bot replica remains running;
- verify a signed provider-free webhook probe succeeds;
- confirm the release report records zero DeepSeek and zero embedding requests.

This fix does not claim LINE-platform delivery from the signed empty probe.
Naturally occurring LINE traffic remains the evidence for a real reply-token
round trip.

## Cost And Scope

The accepted trade-off is one continuously available bot replica using
`0.5 CPU / 1 GiB`. No SearXNG, ClamAV, embedding, DeepSeek, database, or product
behavior change is included.
