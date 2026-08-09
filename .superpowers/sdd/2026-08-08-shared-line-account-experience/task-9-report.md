# Task 9 Report: Private Boundary and Deployment Assurance

Date: 2026-08-09

Status: implementation complete; no push, PR, merge, deployment, provider-console mutation, production write smoke, or real-device smoke was performed.

## Result

- The deployed Account API was checked read-only and has no Container Apps ingress.
- Account private LINE routes remain exactly under `/priv/account/v1/line/*` and use the existing Dapr caller middleware.
- The deployed bot Dapr app identity and Account's accepted LINE bot caller configuration match the required workload identity.
- API Gateway has no private Account route and its runtime smoke requires a forged public caller header to receive `404`.
- The bot release now blocks before mutation when the manual LINE Provider checkpoint is absent or mismatched.
- After the target bot revision is ready, release assurance runs one bounded Account preflight through that revision's Dapr sidecar. Missing required Account RBAC records, an unexpected identity result, or an unexpected binding result fail the release and enter the existing rollback transaction.
- The safe authorization and own-profile matrix reuses existing Account service tests. No production identity or permission was changed.

## TDD Evidence

### RED

Account API:

1. `TestLinePermissionPreflightRouteReturnsOnlyConfiguredFunctions` expected a sanitized success response but received `404` because the route did not exist.
2. `TestConfiguredLineFunctionsRequiresCanonicalPermissionRecords` did not compile because the verification service method did not exist.
3. `scripts/test-release-policy.sh` failed because release smoke did not inspect deployed Account ingress and the caller app-id deployment contract was not asserted.

API Gateway:

1. `scripts/test-auth-routing.sh` failed because runtime smoke had no forged-caller request and did not mechanically prove the Account host's `/priv/` block could not reference its Account upstream.

LINE bot:

1. `account-admin-client.test.ts` failed because `verifyFunctionPermissions` did not exist.
2. `account-deployment-preflight.test.ts` failed because the bounded preflight module did not exist.
3. `profile-config-deployment-contract.test.ts` failed because the manual Provider checkpoint and Account preflight were absent from release configuration.
4. `release-assurance-script.test.ts` failed because Provider mismatch did not stop before writes, the target revision did not run the Account preflight, and preflight failure did not exercise rollback.

### GREEN

Account API focused tests, release-policy checks, full tests, race tests, and vet pass. API Gateway routing/method/release-policy tests, shell syntax, Go tests, and vet pass. Bot focused preflight/deployment/release tests pass; all tests except the pre-existing macOS-only kernel local-live runner pass. Type checking, lint, build, architecture validation, focused formatting, agent eval, and Kernel eval pass.

## Contracts and Files

### Account API — commit `2ccb2d1`

- `.github/workflows/ci.yml`: runs the existing release-policy script in PR CI.
- `internal/routes/routes.go`: adds `POST /priv/account/v1/line/permissions/verify` inside the existing Dapr caller group.
- `internal/handlers/line_handler.go`: strict JSON decoding and sanitized validation/service errors.
- `internal/services/line_binding_service.go`: bounded profile/function request validation and a response containing only `configured_functions`.
- `internal/services/rbac_service.go`: checks exact derived permission-record existence in requested function order; missing records remain missing and repository errors fail closed. No create or assignment path is called.
- `internal/routes/routes_test.go`, `internal/handlers/line_handler_test.go`, `internal/services/rbac_service_integration_test.go`: route/interface/integration coverage, including immediate absence after record removal.
- `scripts/smoke-account-release.sh`: read-only deployed ingress check; any ingress object blocks release.
- `scripts/test-release-policy.sh`: asserts no Bicep ingress, exact bot caller configuration, and deployed-ingress smoke coverage.
- `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`: private surface, ownership, challenge, proof limits, and rollback documentation.

Private request contract:

```json
{ "profile_name": "main", "function_names": ["update_own_profile"] }
```

Sanitized response contract:

```json
{ "configured_functions": ["update_own_profile"] }
```

The caller never sends permission strings and the endpoint never provisions or grants access.

### API Gateway — commit `cfebed8`

- `scripts/test-auth-routing.sh`: proves the Account virtual host's `/priv/` location returns `404` and contains no Account upstream reference; caller identity header stripping remains asserted.
- `scripts/runtime-smoke.sh`: sends a valid-shaped, disposable private-authorization request with a forged bot caller header through the public Account host and requires `404`.
- `README.md`: documents public private-route rejection and the forged-header proof boundary.

The runtime smoke keeps the request and response local to the gateway container and reports only the pass/fail outcome.

### LINE bot — implementation commit `4dcc764`

- `src/account/account-admin-client.ts`: adds the strict private permission-verification client; rejects extra, unknown, duplicated, reordered, or non-function response values.
- `src/assurance/account-deployment-preflight.ts`: combines required-function presence, disposable unbound identity lookup, and rejected unknown binding challenge into an allowlisted result.
- `src/tools/run-account-deployment-preflight.ts`: loads production profile requirements and emits one marker plus sanitized JSON; errors fail closed.
- `scripts/deploy-aca.sh`: requires and compares `LINE_PROVIDER_CONSOLE_VERIFIED_ID` before the known-good snapshot or any production write.
- `scripts/release-assurance.sh`: waits for the exact target revision, executes the preflight inside it, validates the result schema, records `account_preflight`, and uses existing rollback handling on failure.
- `.github/workflows/release.yml`: supplies the protected manual Provider checkpoint variable.
- `src/assurance/report.ts`: allowlists the new release check name without adding identity or account fields.
- `src/testing/create-test-app.ts`: supplies the existing in-memory test default for the extended client contract.
- `src/__tests__/account-admin-client.test.ts`, `src/__tests__/account-deployment-preflight.test.ts`, `src/__tests__/profile-config-deployment-contract.test.ts`, `src/__tests__/release-assurance-script.test.ts`: strict client, sanitized output, missing-record, pre-write Provider mismatch, target execution, and rollback regressions.
- `README.md`, `docs/architecture-context.md`, `docs/runbooks/production-operations.md`: shared help/login/identity/profile surface, challenge and authorization ownership, manual Provider checkpoint, automated proof limits, rollback, and real-device acceptance.

Sanitized release output contract:

```json
{
  "status": "passed",
  "functions": [{ "name": "update_own_profile", "outcome": "configured" }],
  "outcomes": { "identityLookup": "unbound", "binding": "rejected" }
}
```

No role names, permission strings, identity values, account fields, email fields, challenge values, provider URLs, or secrets can enter this result.

## Safe Smoke Matrix

The matrix is local/disposable and reuses existing bounded Account service tests:

| Case                                   | Executable evidence                                                                | Outcome                  |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| Direct grant                           | `TestRBACServiceAuthorizeLineFunctionsUsesEffectivePermissions`                    | allowed                  |
| Role-derived grant                     | `TestRBACServiceAuthorizeLineFunctionsUsesEffectivePermissions`                    | allowed                  |
| Wildcard grant                         | `TestRBACServiceAuthorizeLineFunctionsUsesEffectivePermissions`                    | allowed                  |
| Missing/unknown/mixed denial           | `TestRBACServiceAuthorizeLineFunctionsUsesEffectivePermissions`                    | denied or bounded subset |
| Immediate revocation                   | `TestRBACServiceAuthorizeLineFunctionsReadsEveryDecision`                          | denied on next decision  |
| Own-profile update                     | `TestLineBindingServiceUpdateOwnProfileUsesLinkedActiveUserAndCanonicalPermission` | updated                  |
| Own-profile wildcard and revocation    | `TestLineBindingServiceUpdateOwnProfileAllowsWildcardAndRechecksRevocation`        | update then denied       |
| Unlinked/inactive/unauthorized profile | `TestLineBindingServiceUpdateOwnProfileRejectsUnlinkedInactiveOrUnauthorizedUser`  | denied                   |

## Verification Commands and Results

### Account API

- `go test ./...` — pass.
- `go test -race ./... -count=1 -p=1` — pass.
- `go vet ./...` — pass.
- `./scripts/test-release-policy.sh` — pass.
- `./scripts/test-migration-policy-test.sh` — pass.
- `./scripts/test-migration-policy.sh` — pass.
- `./scripts/bootstrap-migration-role.test.sh` — pass.
- Read-only Azure check — `ACCOUNT_API_NO_INGRESS`.
- Read-only workload check — `DAPR_CALLER_CONTRACT_MATCH`.

The PostgreSQL-specific permission-record integration test compiles locally and is mandatory in CI, where `REQUIRE_POSTGRES_TESTS=true`; the local machine had no test DSN, so that single integration body was skipped locally.

### API Gateway

- `go test ./...` — pass.
- `go vet ./...` — pass.
- `./scripts/test-auth-method-matrix.sh` — pass (`AUTH_METHOD_MATRIX_OK`).
- `./scripts/test-auth-routing.sh` — pass.
- `./scripts/test-www-routing.sh` — pass.
- `./scripts/test-release-policy.sh` — pass.
- `sh -n scripts/runtime-smoke.sh docker-entrypoint-hhc.sh` — pass.

Local image build and `nginx -t` could not run because the local Docker API returned a daemon `500` during its ping. No gateway source or policy test failed.

### LINE bot

- Focused Account client, preflight, profile-deployment, and release-assurance Vitest suites — pass.
- `pnpm exec vitest run --exclude src/__tests__/kernel-local-live-runner.test.ts` — pass.
- `pnpm typecheck` — pass.
- `pnpm lint` — pass.
- `pnpm architecture:check` — pass (`408` TypeScript files checked).
- `bash -n scripts/deploy-aca.sh scripts/release-assurance.sh` — pass.
- `pnpm build` — pass.
- Focused Prettier check for every Task 9 file — pass.
- `pnpm eval:agent` — pass (`20/20` candidates and validated plans).
- `pnpm eval:kernel` — pass (`120` cases).

`pnpm test` retains the pre-existing macOS `/dev/shm` baseline failure in seven fake-runner cases in `kernel-local-live-runner.test.ts`: the Linux-only runner exits before creating the fixture call log. The complete suite excluding that unchanged file passes. `pnpm format:check` also retains the pre-existing formatting warnings in eleven Task 1–9 brief/report files under `.superpowers`; all Task 9 changed source/docs files pass focused formatting.

## Proof Limits and Required Manual Acceptance

- Repository config and the deployment comparison prove equality to the human-supplied Provider checkpoint; they do not prove LINE Console ownership. A human must verify all participating Messaging API and LINE Login channels under the same Provider before setting the protected checkpoint variable.
- The Account ingress and caller checks prove the current deployed ACA/Dapr configuration read-only. The gateway runtime probe becomes live evidence only when the gateway release runs; this task did not deploy it.
- The Account preflight uses only disposable invalid/unbound inputs and does not prove a real linked user's LINE delivery, reply-token behavior, or device UI.
- After reviewed deployment, designated disposable test accounts must exercise public help, login, linked/unlinked identity, own-profile preview/confirmation, denied access, and denial immediately after revocation on real devices.
- Automatic rollback remains the existing known-good revision copy plus dependent workload image restoration. No rollback was triggered in production during this task.

## Commits

- Account API: `2ccb2d1` (`feat: add LINE permission deployment preflight`)
- API Gateway: `cfebed8` (`test: prove private Account routes stay unreachable`)
- LINE bot implementation: `4dcc764` (`feat: gate releases on shared Account boundaries`)
- This report is committed separately on the same LINE bot branch so the implementation SHA remains stable evidence.
