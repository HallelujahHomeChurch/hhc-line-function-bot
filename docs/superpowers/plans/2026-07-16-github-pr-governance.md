# GitHub PR Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce PR-only changes to `main`, run complete validation on pull requests, run only image build and ACA release after merge, and synchronize maintainer/agent documentation.

**Architecture:** Split the combined GitHub Actions workflow into an always-running PR validation workflow and a path-filtered main release workflow. Publish the change through a PR, then create a no-bypass repository ruleset requiring that PR and its stable `PR CI` check with zero human approvals.

**Tech Stack:** GitHub Actions, GitHub repository rulesets, GitHub CLI, pnpm, TypeScript, Azure OIDC, Azure Container Registry, Azure Container Apps

## Global Constraints

- Repository: `HallelujahHomeChurch/hhc-line-function-bot`, public, default branch `main`.
- Every update to `main` must use a pull request; no administrator or agent bypass.
- Required approving review count is `0`; agents may auto-merge after required CI succeeds.
- PR CI owns all validation and TypeScript compilation.
- Production Release owns Docker/ACR image build and ACA deployment and does not repeat PR validation.
- Documentation-only merges must not deploy.
- Never commit secrets, real environment files, sensitive user data, or private operational data.

---

### Task 1: Split PR CI From Production Release

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Delete: `.github/workflows/hhc-line-function-bot.yml`
- Delete: `azure-pipelines.yml`
- Modify: `src/__tests__/profile-config-deployment-contract.test.ts`

**Interfaces:**

- Consumes: existing pnpm verification scripts, Azure repository variables, OIDC federation, `scripts/deploy-aca.sh`, Dockerfile, ACA manifests.
- Produces: stable required check context `PR CI`; production workflow `Production Release`.

- [ ] **Step 1: Create the PR CI workflow**

Create `.github/workflows/ci.yml` with `pull_request` targeting `main`, read-only contents permission, per-PR cancel-in-progress concurrency, and one job named `PR CI`. Run checkout, Node 24, pnpm 11.7.0, frozen install, `format:check`, `typecheck`, `lint`, `test`, `config:validate`, `eval:agent`, and `build` in that order.

- [ ] **Step 2: Create the production release workflow**

Create `.github/workflows/release.yml` with `push` to `main` limited to app/build/deploy paths and `workflow_dispatch`. Grant only `contents: read` and `id-token: write`. Preserve non-cancelling production concurrency, current ACR/image/ACA environment values, Azure OIDC login, `az acr build`, and `bash scripts/deploy-aca.sh`. Do not add any pnpm validation command.

- [ ] **Step 3: Remove obsolete delivery definitions**

Delete `.github/workflows/hhc-line-function-bot.yml` and `azure-pipelines.yml` so there is one CI system and no dead Azure DevOps fallback definition.

- [ ] **Step 4: Update and verify the deployment contract test**

Run the existing deployment contract test after deleting the old files and
confirm it fails because it still reads the combined workflow. Update it to
assert the separate PR CI and Production Release responsibilities, the absence
of the combined workflow and Azure YAML, and the catalog-sync job release path.
Run the focused test again and expect all four tests to pass.

- [ ] **Step 5: Validate workflow structure**

Run:

```bash
pnpm prettier --check .github/workflows/ci.yml .github/workflows/release.yml
git diff --check
rg -n "pnpm (format:check|typecheck|lint|test|config:validate|eval:agent|build)" .github/workflows
```

Expected: Prettier and diff checks pass; validation commands appear only in `ci.yml`; `release.yml` contains `az acr build` and `scripts/deploy-aca.sh`.

### Task 2: Synchronize Project And Agent Documentation

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture-context.md`

**Interfaces:**

- Consumes: workflow names and governance contract from Task 1.
- Produces: one consistent onboarding and operational model for maintainers and future agents.

- [ ] **Step 1: Update README operations documentation**

Replace the combined-workflow section with separate `PR CI` and `Production Release` behavior. Document PR-only `main`, zero required human approvals, agent auto-merge, docs-only release filtering, OIDC/image/deploy behavior, and removal of Azure DevOps.

- [ ] **Step 2: Update the agent working agreement**

Rewrite `AGENTS.md` deployment rules so agents must use `codex/*` branches and PRs, may enable auto-merge after CI, may never bypass the ruleset, and distinguish CI failure from post-merge release failure. Update paths to `ci.yml` and `release.yml`; remove all Azure DevOps fallback claims.

- [ ] **Step 3: Update the architecture fast map**

Update `docs/architecture-context.md` deployment safety to describe PR validation, main image build/release, GitHub-only delivery, and docs-only non-deployment.

- [ ] **Step 4: Verify documentation consistency**

Run:

```bash
rg -n "azure-pipelines|Azure DevOps|hhc-line-function-bot\.yml|manual-only fallback" README.md AGENTS.md docs/architecture-context.md
rg -n "PR CI|Production Release|zero|required.*approval|auto-merge|codex/\*" README.md AGENTS.md docs/architecture-context.md
pnpm format:check
git diff --check
```

Expected: no obsolete Azure pipeline/workflow claims; all three documents describe the new flow; formatting and diff checks pass.

### Task 3: Verify, Commit, Push, And Open The Governance PR

**Files:**

- Modify: `docs/superpowers/plans/2026-07-16-github-pr-governance.md` checkbox state only while tracking execution.

**Interfaces:**

- Consumes: all files from Tasks 1 and 2.
- Produces: pushed branch `codex/github-pr-governance` and a ready pull request to `main`.

- [ ] **Step 1: Run the full local verification suite**

Run:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm config:validate
pnpm eval:agent
pnpm build
```

Expected: every command exits `0`; test and eval summaries report no failures.

- [ ] **Step 2: Inspect and commit the exact scope**

Run `git status --short`, `git diff --stat`, `git diff --check`, and inspect the workflow/document diff. Stage only the two new workflows, two deleted workflow definitions, three synchronized documents, design spec, and this plan. Commit with:

```bash
git commit -m "ci: enforce PR validation before release"
```

- [ ] **Step 3: Push and create a ready PR**

Push `codex/github-pr-governance`, then create a non-draft PR targeting `main` titled `ci: enforce PR validation before release`. Its body must summarize the split workflows, PR-only governance, obsolete Azure DevOps removal, documentation alignment, and local checks.

- [ ] **Step 4: Verify the new PR check context**

Use `gh pr checks --watch` and the checks API. Expected: one required-candidate check named exactly `PR CI` succeeds, and no production release runs for the PR.

### Task 4: Configure Repository Merge Policy And Main Ruleset

**Files:**

- No repository files.

**Interfaces:**

- Consumes: successful `PR CI` check from Task 3.
- Produces: enforced main ruleset and repository auto-merge/squash settings.

- [ ] **Step 1: Configure merge behavior**

Use `gh repo edit` to enable auto-merge, squash merge, and automatic head-branch deletion while disabling merge commits and rebase merge.

- [ ] **Step 2: Create the active ruleset**

Create repository ruleset `main-pr-only` targeting `~DEFAULT_BRANCH`, with no bypass actors and these rule types:

- `deletion`
- `non_fast_forward`
- `required_linear_history`
- `pull_request` with allowed merge method `squash` and required approving review count `0`
- `required_status_checks` containing context `PR CI` with strict branch policy

- [ ] **Step 3: Verify enforcement without mutating main**

Read back the ruleset and branch rules through the GitHub API. Use `git push --dry-run origin HEAD:main` from the feature branch and confirm GitHub rejects the non-PR update. Do not perform a real direct push.

- [ ] **Step 4: Enable auto-merge**

Run `gh pr merge --auto --squash` for the governance PR. Expected: GitHub merges immediately if `PR CI` is already green or queues the merge until it becomes green, without requesting a review.

### Task 5: Verify Post-Merge Release And Production Health

**Files:**

- No repository files.

**Interfaces:**

- Consumes: merged governance PR and `Production Release` workflow.
- Produces: evidence that only build/release ran and production is healthy.

- [ ] **Step 1: Verify main history and workflow separation**

Confirm the PR merged by squash, `main` contains the merged commit, the PR check is green, and the merge created a `Production Release` run. Confirm there is no second `PR CI` push run for `main`.

- [ ] **Step 2: Monitor the production release**

Watch the release run to completion and inspect its job/step names. Expected: Azure login, extension setup, ACR image build, and ACA deploy only; no pnpm validation steps.

- [ ] **Step 3: Verify Azure deployment state**

Use Azure CLI to confirm the bot Container App revision is running with 100% traffic and both the bot and catalog-sync job reference the immutable image tag from the release run.

- [ ] **Step 4: Run the public gateway smoke check**

POST unsigned JSON to the production helper webhook through the public API Gateway. Expected:

```text
HTTP 400
{"ok":false,"error":"missing_line_signature"}
```

- [ ] **Step 5: Confirm the repository is clean and governed**

Verify local/remote branch state, active ruleset details, public visibility, and successful PR/release URLs. Do not test docs-only non-deployment by creating a throwaway production PR; the release path filter and workflow definition are the deterministic verification for that condition.
