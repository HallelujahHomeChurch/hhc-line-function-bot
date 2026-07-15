# GitHub PR Governance And Split CI/CD Design

## Goal

Make every change to `main` travel through a pull request while still allowing
an automated agent to complete the entire branch, PR, CI, and merge lifecycle
without a human approval. Move all validation to the pull request and keep the
post-merge production workflow limited to container build and release.

## Chosen Approach

Use a repository ruleset on the now-public GitHub repository, plus two separate
GitHub Actions workflows:

- PR-only CI validates every pull request targeting `main`.
- main-only release builds the container image and deploys it after merge.
- the ruleset requires a PR and the PR CI status, but requires zero approving
  reviews.
- no actor receives a bypass, so administrators and automated agents cannot
  push directly to `main`.

The PR author does not literally approve its own PR. GitHub will require zero
approvals, so the agent may enable auto-merge or merge the PR after the required
CI check succeeds.

Alternatives rejected:

- Requiring one human approval adds a manual gate that the requested autonomous
  issue worker must not need.
- Detecting direct pushes in a workflow records the violation after the fact
  and cannot enforce PR-only history.
- Keeping validation in the production workflow makes test failures look like
  failed deployments and repeats work already completed on the reviewed commit.

## Workflow Architecture

### Pull Request CI

Create `.github/workflows/ci.yml` with a stable workflow and job name suitable
for a required status check. It runs on every `pull_request` targeting `main`
without path filtering, ensuring docs-only PRs also receive the required check
instead of remaining permanently pending.

The job uses read-only repository permissions and performs:

1. frozen dependency installation;
2. formatting check;
3. TypeScript typecheck;
4. lint;
5. unit and integration tests;
6. production profile configuration validation;
7. deterministic controlled-agent evaluation;
8. TypeScript compilation.

TypeScript compilation remains a PR validation step because it cheaply prevents
a known application build failure. The release workflow's separate "build" is
the authoritative Docker/ACR image build.

PR CI uses per-PR concurrency and cancels an older run when a newer commit is
pushed to the same PR.

### Production Release

Create `.github/workflows/release.yml` triggered by app/build/deployment changes
merged into `main`, plus an explicit manual dispatch option. It does not install
Node dependencies and does not run formatting, typecheck, lint, tests, config
validation, controlled-agent eval, or `pnpm build`.

The release job:

1. checks out the exact merged commit;
2. authenticates to Azure using the existing branch-scoped OIDC federation;
3. ensures the Azure Container Apps CLI extension is available;
4. uses `az acr build` to build and publish immutable and `latest` image tags;
5. runs `scripts/deploy-aca.sh` to update the app and catalog-sync job and wait
   for a healthy revision.

Production releases retain non-cancelling concurrency so two merges cannot
interrupt an in-progress deployment. Documentation-only merges do not trigger a
release.

The combined `.github/workflows/hhc-line-function-bot.yml` is removed after its
responsibilities are split. The obsolete `azure-pipelines.yml` is also removed
because its Azure DevOps pipeline definition has already been deleted and it is
no longer a usable fallback.

## Main Branch Ruleset

Create one active repository ruleset targeting the default branch with no
bypass actors. It will:

- require changes to reach `main` through a pull request;
- require zero approving reviews;
- require the exact PR CI check and require the branch to be current before
  merge;
- block force pushes;
- block branch deletion;
- require linear history so the repository uses squash merges;
- apply to repository administrators and automated agents.

The repository will allow squash merge and auto-merge, disable merge commits and
rebase merge, and delete merged head branches automatically. An agent may open a
PR and request auto-merge immediately; GitHub performs the merge only after the
required check is green.

The ruleset is activated only after the first PR run exposes the final check
context. This avoids configuring a misspelled or nonexistent required status
that would permanently block `main`.

## Automated Issue Worker Contract

Future cron-driven issue work must:

1. create a dedicated `codex/*` branch from current `main`;
2. commit only the issue-scoped change;
3. push the branch and create a PR;
4. wait for or enable auto-merge against the required PR CI;
5. never use a direct push, force push, ruleset bypass, or GitHub token with a
   bypass exemption;
6. treat a failed CI check as an issue-work failure, not a production release
   failure;
7. monitor the release workflow only after GitHub merges the PR.

This design establishes the governance boundary needed by the future issue
table/cron worker but does not implement that worker in this change.

## Documentation And Agent Handoff

Update `AGENTS.md`, `README.md`, and `docs/architecture-context.md` so they agree
on these current facts:

- GitHub Actions is the sole CI/CD system.
- Azure DevOps no longer has a pipeline for this repository.
- `main` is PR-only with required CI and zero required human approvals.
- agents work on `codex/*` branches, create PRs, and may auto-merge after CI.
- PR CI owns validation; main release owns image build and ACA deployment.
- documentation-only merges do not deploy.
- the public repository must never contain real environment files, identifiers
  that are treated as secrets, tokens, credentials, private endpoints, or
  sensitive user/church data.

README remains the product and operator reference. `AGENTS.md` remains the
authoritative execution agreement for future agents. The architecture context
keeps the fast subsystem/deployment map aligned with both.

## Failure Handling And Rollback

- A PR CI failure blocks merge and produces no production deployment.
- A release failure leaves PR validation green but reports a distinct production
  release failure; the workflow must retain enough Azure output to diagnose the
  failed build or rollout without printing secrets.
- A failed new ACA revision must not receive healthy production traffic;
  `scripts/deploy-aca.sh` remains responsible for waiting for health.
- Workflow changes are rolled back through another PR. The ruleset remains
  enforced during rollback.
- Emergency changes still use a PR. This design intentionally provides no
  direct-push emergency bypass.

## Verification

Before merge:

- run the repository's complete local verification suite;
- validate workflow syntax and inspect workflow permissions;
- open a PR and confirm the new PR CI check appears and succeeds;
- configure the ruleset using that exact check context;
- verify an attempted direct push to `main` is rejected without changing it;
- verify the PR can merge with zero approvals once CI succeeds.

After merge:

- confirm only the release workflow runs for the merge commit;
- confirm it performs image build and deployment without repeating validation;
- confirm the Container App and catalog-sync job use the new immutable image;
- confirm the new ACA revision is healthy and receives production traffic;
- POST an unsigned request through the public API Gateway and verify the bot
  returns `400 {"ok":false,"error":"missing_line_signature"}`;
- confirm a docs-only PR merge does not trigger production release.

## Out Of Scope

- Implementing the issue database, private issue API, screenshot storage, or
  cron issue worker.
- Requiring human review, CODEOWNERS approval, or merge queue.
- Adding a second deployment system or restoring Azure DevOps.
- Changing application runtime behavior or Azure Container Apps secrets.
