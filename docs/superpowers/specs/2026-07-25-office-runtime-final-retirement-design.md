# Office Runtime Final Retirement Design

**Date:** 2026-07-25

## Goal

Finish the R3.1 office-runtime retirement by right-sizing the Azure-hosted
replacement services, changing ClamAV signature refresh to a weekly schedule,
removing the retired `hermes-line-proxy` Container App when it has no live
dependencies, and deleting the superseded HHC runtime assets from the office
workstation.

The production LINE function agent must continue using only Azure-hosted
SearXNG, Azure Container Apps ClamAV jobs, Azure OpenAI embeddings, and the
remote DeepSeek provider. It must not regain an Office-network or Ollama
runtime dependency.

## Approved Scope

### Azure changes

- Set `hhc-searxng` to `0.25` CPU and `0.5Gi` memory.
- Keep SearXNG at one replica and keep its ingress internal-only.
- Change `hhc-line-bot-clamav-refresh` to run every Monday at 03:10
  Asia/Taipei. Azure Container Apps cron is UTC, so the expression is
  `10 19 * * 0`.
- Inspect all discoverable dependencies on `hermes-line-proxy`.
  - If none remain, delete exactly
    `alive/Microsoft.App/containerApps/hermes-line-proxy`.
  - If any dependency remains, do not delete it. Report the dependency and a
    recommended remediation to the user, then wait for a decision.

### Office workstation cleanup

Delete only these retired HHC assets:

- Docker containers `hhc-searxng` and `hhc-clamav`.
- Docker images `searxng/searxng:latest` and `clamav/clamav:stable`, provided
  no unrelated container uses those image IDs.
- Docker volumes `local-services_searxng-cache` and
  `local-services_clamav-db`, after resolving the exact volume names.
- Ollama models `bge-m3:latest` and `qwen3:4b-instruct`.
- Startup shortcuts `HHC Line Bot Local Services.lnk` and `Ollama.lnk`.

Preserve:

- Docker Desktop, including its Windows logon auto-start entry.
- The installed Ollama application.
- Every unrelated Docker container, image, volume, scheduled task, startup
  item, and model.

The repository already removed the old local Docker Compose and startup
scripts in R3.1. The remaining `HHC Line Bot Local Services.lnk` points at the
retired script path and must be removed from the workstation.

## Execution Order

1. Create a branch from the latest protected `main`.
2. Update the SearXNG and ClamAV ACA manifests, deployment-contract tests, and
   operational documentation.
3. Run the repository verification gates, open a pull request, and wait for
   required PR CI.
4. Merge and wait for the GitHub Actions production release.
5. Verify the deployed SearXNG resources, weekly ClamAV cron, bot provider
   configuration, Azure embedding, Dapr configuration, and public webhook
   response.
6. Inspect `hermes-line-proxy` dependencies. Delete it only if the dependency
   gate passes, then verify the resource is absent and the remaining apps are
   healthy.
7. Resolve and remove the exact workstation assets in the approved scope.
8. Re-query Docker, Ollama, Startup folders, and Azure to prove the final
   state.

Cloud replacement verification precedes workstation deletion so the local
runtime remains available until the production configuration is known-good.

## Dependency Gate For `hermes-line-proxy`

The inspection must cover:

- Repository and GitHub workflow references.
- Azure Container Apps environment variables and ingress configuration.
- API Gateway configuration and routes.
- Dapr component or app-id references.
- Azure resources whose configuration can be read and searched safely.

The absence of repository text alone is not sufficient. Any positive match
blocks deletion until the user reviews the dependency and recommendation.

## Safety And Recovery

- Resolve resource IDs and Docker object IDs before destructive commands.
- Never use broad recursive deletion, globs, or Docker-wide prune commands.
- Delete only the approved names.
- Do not print Azure keys, tokens, secret values, or private configuration.
- The manifest and schedule changes are recoverable through a reviewed release.
- Deleted Docker volumes and Ollama model blobs are not treated as recoverable;
  exact targets must therefore be verified immediately before deletion.
- If the SearXNG resource reduction causes readiness or restart failures,
  restore `0.5` CPU and `1Gi` through the same reviewed deployment path.

## Verification

Repository verification:

- Deployment-contract tests assert `0.25` CPU, `0.5Gi`, and
  `10 19 * * 0`.
- `pnpm format:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm eval:kernel` because this is a post-R3 deployment behavior change.

Production verification:

- Required PR CI and Production Release conclude successfully.
- `hhc-searxng` is `Running`, internal-only, and reports the requested
  resources.
- `hhc-line-bot-clamav-refresh` is provisioned with the weekly cron.
- The LINE function bot has no Ollama or Office-host endpoint and still points
  to the internal SearXNG and Azure OpenAI embedding deployment.
- The bot keeps internal ingress and the required Dapr app configuration.
- An unsigned request through the public API Gateway returns HTTP `400` with
  `{"ok":false,"error":"missing_line_signature"}`.
- `hermes-line-proxy` is absent only after the dependency gate passes.

Workstation verification:

- The two named Docker containers, images, and volumes are absent.
- The two named Ollama models are absent.
- The two named Startup shortcuts are absent.
- Docker Desktop auto-start and the Ollama installation remain present.
- No unrelated local asset was changed.
