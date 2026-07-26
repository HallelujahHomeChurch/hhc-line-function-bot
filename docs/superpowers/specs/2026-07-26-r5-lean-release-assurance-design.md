# R5.0 Lean Release Assurance Design

## Status

Approved for implementation as the focused design of the already approved
R5.0 milestone in
`2026-07-26-single-church-optimization-roadmap-design.md`.

R5.0 is the final delivery milestone. After its production acceptance, the
project enters Stable Maintenance. This design does not add R5.1, R5.2, SaaS,
tenant, branch identity, another database, another semantic provider, or an
office-runtime dependency.

## Outcome

Every production release records the current known-good immutable revision,
deploys the requested immutable image, proves the supported production
contract with provider-free checks, and writes one allowlisted report. If a
required gate fails after deployment starts, the release restores a new
revision copied from the recorded known-good revision and verifies the restored
image before it exits as failed.

Low-frequency checks cover the external dependencies that should not be called
on every deployment.

## Constraints

- Production remains one church, one shared Azure deployment, and the existing
  profile/source/requester authority model.
- Deploy-time assurance consumes zero DeepSeek requests and zero Azure
  embedding requests.
- No test sends a normal LINE message, consumes a reply token, or asks a human
  to participate.
- The signed webhook body is exactly `{"events":[]}`.
- Public Gateway access remains limited to canonical LINE webhook paths.
- Bot and SearXNG ingress remain internal.
- Release and periodic reports contain only enumerated resource names,
  revision/image identifiers, execution identifiers, bounded statuses,
  timestamps, counts, ages, and stable failure codes.
- Secret values, URLs containing credentials, raw response bodies, file names,
  user content, LINE identifiers, Graph/Notion identifiers, and provider
  payloads never enter reports.
- GitHub Actions remains the only CI/CD system.

## Selected Architecture

### 1. Release transaction

`scripts/deploy-aca.sh` becomes a release transaction:

1. Capture the current latest-ready revision and its immutable image before any
   deployment mutation.
2. Capture the current SearXNG revision and all five finite-job states, then
   reconcile secrets/storage and deploy SearXNG, the bot, and the jobs.
3. Verify the target bot revision, image, 100 percent latest traffic, internal
   ingress, target port, transport, and exact Dapr contract.
4. Run one finite release-probe ACA Job in the same managed environment.
5. Verify the catalog, ClamAV refresh, attachment scan, release probe, and
   periodic assurance job definitions plus the required recent successful job
   executions.
6. Write the successful release report.

An EXIT trap owns failure handling after any production write begins. It
copies the full recorded known-good revision with
`az containerapp revision copy --from-revision` while overriding the image with
the recorded OCI digest, copies the recorded SearXNG revision when SearXNG was
mutated, restores or removes every mutated job according to the five-job
snapshot, waits until the restored revisions are latest-ready with the recorded
digests, and then writes a failed report whose rollback status is either
`restored` or `failed`. Compatible secret and environment-storage
reconciliation remains at its authoritative value; `restored` is emitted only
when all release-owned traffic and finite workloads match the snapshot. It
never pushes or bypasses `main`.

Single revision mode remains enabled. Azure keeps traffic on the prior revision
when a new revision cannot become ready; the explicit copy-based restoration
covers failures in required gates that occur after the target revision became
ready.

### 2. Deploy-time release probe

Add a Manual ACA Job using the immutable bot image and a small Node entrypoint.
It has no ingress, one replica, no retry, a bounded timeout, 0.25 CPU, and
0.5 GiB memory. It runs in the same Container Apps environment and receives
only:

- the internal bot base URL;
- the internal SearXNG base URL;
- the public Gateway canonical helper webhook URL;
- the helper LINE channel secret by secret reference;
- the read-only ClamAV signature mount and manifest path.

The probe:

- GETs bot `/healthz` and requires the minimal liveness contract;
- GETs bot `/readyz` and requires HTTP 200 plus PostgreSQL and Redis readiness;
- GETs the SearXNG root without issuing a search;
- signs and POSTs `{"events":[]}` through the public Gateway and requires the
  bot success response;
- reads and validates the active ClamAV manifest and returns current or warning
  age without blocking solely because of age.

The entrypoint emits exactly one allowlisted JSON result and exits non-zero on
a required failure. It has no DeepSeek or embedding configuration.

### 3. Control-plane release checks

The deployment runner verifies:

- the bot target and latest-ready revision are identical;
- the immutable target image is active with 100 percent latest traffic;
- ingress is internal with target port 3000 and supported HTTP transport;
- Dapr is enabled with app id `hhc-line-function-bot`, port 3000, and protocol
  `http`;
- SearXNG is internal, healthy, 0.25 CPU / 0.5 GiB, and 100 percent on its
  latest-ready revision;
- catalog sync is scheduled every 15 minutes with the target bot image and has
  a recent successful execution;
- ClamAV refresh is weekly at `10 19 * * 0` UTC, has a successful bootstrap
  execution for this release, and retains its read/write signature mount;
- attachment scan remains event-driven, 2 CPU / 4 GiB, zero idle executions,
  and uses the read-only signature mount;
- the release probe and periodic assurance jobs use the intended immutable
  image, manual trigger, finite resources, and no ingress.

“Recent” is bounded and explicit: catalog must have a successful execution
whose start time is no older than 30 minutes at the time of the release gate.
The ClamAV refresh success is the execution started and awaited by the current
release.

### 4. Periodic assurance

Add one weekly GitHub Actions workflow and one Manual ACA Job based on the
immutable attachment-scan image. The workflow authenticates to Azure with the
existing OIDC boundary, starts the job, waits without retrying the job, checks
recent attachment-scan control-plane execution metadata, and uploads an
allowlisted report.

The in-environment job performs:

- one bounded Graph metadata read of the configured drive root;
- one bounded Notion query capped at one result;
- ClamAV clean-file acceptance and EICAR rejection against the active immutable
  signature directory;
- attachment queue approximate depth and oldest visible message age;
- one tiny write-delete smoke using a fixed `.hhc-diagnostics` folder under the
  already authorized `GRAPH_XIAOHA_OTHER_FOLDER_ITEM_ID`.

The diagnostics folder is created only when absent. The smoke item uses a
constant system name, contains no church/user content, is deleted in `finally`,
and an incomplete cleanup fails the job. The report records only whether the
folder was available and whether write/delete succeeded; it never records its
Graph item ID or URL.

The weekly schedule is Monday 20:30 UTC, after the Monday 19:10 UTC ClamAV
refresh window and away from normal Taipei church meeting hours. A manual
dispatch remains available.

### 5. Reports

The release report schema is versioned and fixed:

```text
version
kind: release
releaseId
commitSha
startedAt
completedAt
status: passed | failed
failureCode
target: { resource, revision, image, status }
knownGood: { revision, image }
checks: [{ name, status, observedAt, code }]
rollback: { status, revision, image }
providerRequests: { deepseek: 0, embedding: 0 }
```

The periodic report uses the same envelope shape with `kind: periodic`,
execution identifiers, bounded queue counts/ages, and named check statuses. A
small report builder rejects unknown fields and values before JSON is written.

Reports are uploaded as GitHub workflow artifacts even on failure. Console
output contains only the same allowlisted status data.

## Failure Semantics

- Failure before deployment mutation: write a failed report; no rollback is
  needed.
- Target never ready: Azure single revision mode retains old traffic; still
  run the copy-based restore and verify it.
- Deploy-time probe failure: restore the recorded revision and fail release.
- Job-definition or recent-execution failure: restore the recorded revision and
  fail release.
- Rollback verification failure: mark rollback `failed`, retain the original
  gate failure code, and fail loudly. Do not attempt an unbounded loop.
- Periodic failure never changes production traffic. It produces a failed
  periodic report for operator follow-up.
- ClamAV signature age at or above seven days is `warning`, not a release
  failure, as long as the manifest is otherwise valid.

## Verification

### Deterministic tests

- Unit-test release and periodic report allowlists, failure codes, secret-field
  rejection, and stable timestamps.
- Unit-test release probe success and every endpoint/manifest failure with
  injected fetch, clock, and file readers.
- Unit-test periodic Graph, Notion, queue, clean/EICAR, and write-delete
  lifecycles with injected adapters.
- Execute the rollback shell function with a fake Azure CLI. Deliberately fail
  a required gate, prove `revision copy --from-revision` uses the recorded
  revision, and prove success is reported only after the restored image is
  latest-ready.
- Extend deployment-contract tests for both new Job manifests, immutable image
  propagation, zero provider configuration, report artifact upload, periodic
  schedule, required gate ordering, and the copy-based rollback path.
- Run the existing complete repository, architecture, Kernel, and integration
  gates.

### Production acceptance

- Merge through protected `main` after PR CI.
- Require the Production Release workflow to upload a passed release report.
- Verify the live target revision/image, 100 percent traffic, internal ingress,
  Dapr contract, signed empty webhook, SearXNG resources, catalog execution,
  ClamAV refresh/manifest, and scan definition from current Azure state.
- Manually dispatch the periodic workflow once and require a passed report.
- Confirm Log Analytics contains no application migration/startup failure for
  the target revision.

The signed empty webhook proves Gateway-to-Dapr-to-bot routing and signature
handling only. It does not prove LINE platform delivery or reply-token
behavior. Those remain observable through sanitized natural production events;
R5.0 does not claim recruited human acceptance.

## Exit Criteria

R5.0 is complete only when:

- every deploy-time gate and the first periodic assurance run pass in
  production;
- the release artifact is present and secret-free;
- a deterministic deliberate failed-gate test proves the recorded revision is
  restored and verified;
- deploy-time reports state exactly zero DeepSeek and embedding requests;
- the roadmap and operations runbook mark R4.1 and R5.0 complete and state that
  the project is now in Stable Maintenance.
