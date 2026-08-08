# Task 8 report: provider-free main profile and Weekly Paper download

## Status

- Implementation is complete on `codex/main-profile-prerequisites`.
- Implementation commit: `ed9a34b` (`feat: add provider-free main weekly paper`).
- Verification correction: the disposable integration gate is blocked by the local Docker daemon; it did not pass.
- No push, pull request, merge, deployment, production credential read, or live LINE, Azure, provider, HHC web API, Dapr, Account, Graph, catalog, or Asset call was performed.

## Implemented contract

- `allowedProviders: []` is the sole provider-free authority. Empty and partial provider policies are accepted only for an empty provider set; non-empty profiles retain DeepSeek-only validation.
- The existing profile-aware provider wrapper and agent planner fail locally with `providers_disabled` before provider resolution or invocation. Deterministic validation remains authoritative and can execute one explicit read candidate.
- `download_weekly_paper` is a stateless, user/direct read capability with no resource, memory, refinement, operation, or task-frame payload. Central normalization supports `第1733期週報`, `1733期週報`, and `週報第1733期`; numeric-only input does not produce a weekly candidate. Explicit invalid or out-of-int32 issue numbers remain present for schema rejection and cannot degrade to latest.
- The handler uses the fixed Dapr invocation routes for latest or by-number, `locale=zh-Hant`, injected `fetchImpl`, and a three-second abort deadline. It maps only 404 to `not_found`; all other dependency, envelope, metadata, issue mismatch, and URL failures are `unavailable`.
- The public URL boundary accepts root-relative `/assets/<32 lowercase hex>` or the exact-origin absolute form produced by hhc-web-api, `https://www.alive.org.tw/assets/<32 lowercase hex>`, with no fragment, userinfo, escape, extra segment, wrong origin/port/protocol, or extra query fields. Query is absent or one nonblank `filename`; the resolved URI must keep the exact `https://www.alive.org.tw` origin and fit LINE's 1000-character URI limit.
- The resolved URL appears only in the SDK-native LINE URI quick reply. Reply text, result envelope, traces, task state, memory, and resource metadata contain no URL.
- Production `main` is canonical `/api/line/webhook/main`, public direct, group/room blocked, registration disabled, text-only, template-small-talk, general-agent disabled, provider-free, and enables only `download_weekly_paper`.
- Profile identity copy is explicit. Direct help/introduction projects effective capabilities plus public `account_login`; main shows Weekly Paper and login only. Helper keeps its current identity and command help; group help never presents direct-only login.
- Common entrance order is structural source/message policy, dedupe, rate limit, lazy Account authorization for provider-capable turns, effective access, then optional display-name lookup. Provider-free admin-looking and admin slash surfaces are rejected locally. Managed helper groups retain early non-wake admission rejection before dedupe, rate, Account, or identity.
- The bot container alone receives both `LINE_MAIN_*` secret references. Attachment, catalog, ClamAV, release-probe, and periodic-assurance jobs receive neither main secret. Attachment worker profile filtering still selects only profiles with `save_resource`.

## TDD RED -> GREEN evidence

1. Provider/config RED: three failures showed empty provider sets were rejected, the wrapper did not return `providers_disabled`, and planner called its provider. GREEN added the local empty-provider policy and verified underlying JSON/text calls remain zero.
2. Weekly structure RED: missing function definition/module/schema and missing central issue extraction produced two failures. GREEN registered the single capability module and bounded optional argument contract.
3. Weekly handler RED: all 19 initial handler cases failed. GREEN covered exact latest/by-number routes, timeout, 404/5xx, invalid JSON/envelope/locale/metadata, issue mismatch, canonical URL attacks, response-only URI placement, int32 response bounds, and LINE URI length.
4. Controlled routing RED: explicit weekly was only a weak hint and returned planner unavailable. GREEN added declarative intent evidence; explicit provider-free reads execute, while typo, ambiguity, cross-function, write, numeric-only, disabled, and out-of-range cases do not.
5. Presentation RED: main inherited helper identity and helper-only commands, and `你是誰` produced no profile-aware response. GREEN added the identity line and source-aware account-login projection while preserving helper/group regressions.
6. Entrance RED: 12 signed provider-free cases called Account before structural/rate gates. GREEN covers latest, specified, 404, help, account login, unknown, blocked group, admin-looking, `/route-test`, typo, cross-function, write, and numeric-only with a real planner wired to provider spies; JSON, text, and embedding-path spies remain zero.
7. Helper entrance regression RED: registered non-wake group chatter reached dedupe/rate. GREEN added provider-capable group pre-admission and retained group postback/command behavior.
8. Deployment RED: two failures proved bot main secret refs and placeholders were absent. GREEN added exactly two bot-only refs plus source placeholders and job-exclusion checks.
9. Branch-wide RED: the new read lacked a response field and fixed Kernel case lists expected seven cases. GREEN added a safe issue-number projection and the versioned provider-free Kernel case/count.

## Fix round 1

- RED: the exact hhc-web-api production shape `https://www.alive.org.tw/assets/<32hex>?filename=...` returned `unavailable`, proving the root-relative-only precheck rejected the cross-repo contract.
- GREEN: URL parsing now accepts either the canonical root-relative form or the exact-origin absolute form, then applies the same final URL origin/path/query checks. Focused handler tests cover the accepted absolute form and reject scheme-relative, wrong origin, port, protocol, userinfo, hash, encoded path, legacy path, and invalid query forms.
- Canonicality follow-up RED: absolute plain and encoded dot-segment paths normalized by `URL` to `/assets/<id>` and were incorrectly accepted. GREEN derives the raw path/query from the accepted input shape, requires the raw pathname itself to match the asset path contract, and requires the parsed pathname to equal it before accepting the URI.
- Verification evidence was corrected in the same round: controller reproduction shows the disposable integration gate is Docker-blocked, not passed.

## Changed files

- Capability/provider/runtime: `src/capabilities/download-weekly-paper.ts`, `src/function-arguments.ts`, `src/functions/argument-normalization.ts`, `src/functions/{definitions,modules,registry}.ts`, `src/application/contracts/{function-execution,function-module}.ts`, `src/agent/{planner,plan-validator}.ts`, `src/llm/{provider-policy,provider-runtime}.ts`, `src/bootstrap/create-production-runtime.ts`, `src/types.ts`.
- Presentation/entrance: `src/application/capabilities/{effective-capability-projection,capability-presenters}.ts`, `src/application/turn/runtime.ts`, `src/intro.ts`, `src/transport/line/{public-access-commands,webhook-routes}.ts`.
- Production/deployment/docs: `config/profiles.json`, `.env.example`, `aca.containerapp.yaml`, `scripts/deploy-aca.sh`, `README.md`, `docs/architecture-context.md`.
- Evals: `src/tools/eval-agent-planner.ts`, `src/evals/kernel/cases/product-experience.ts`.
- Tests: focused provider, config, candidate/planner/validator, capability, handler, LINE serialization, presentation, entrance, Kernel, worker isolation, profile validation, and deployment contract files under `src/__tests__`.

## Verification

Passed:

- Focused Vitest: 20 files, 535 tests.
- Exact full Vitest exclusion: all tests passed when excluding only `src/__tests__/kernel-local-live-runner.test.ts`.
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm architecture:check` (399 TypeScript files)
- `pnpm eval:agent` (candidates 20/20; validated 20/20)
- `pnpm eval:kernel` (115 cases; all metrics passed)

Blocked:

- `pnpm eval:kernel:integration`: controller fresh reproduction exited `2` with `kernel_integration_compose_start_failed`, `kernel_integration_compose_cleanup_failed`, and `ELIFECYCLE`. This is a Docker daemon/Compose availability blocker, not a passing gate. Docker was not restarted and the command was not retried after the controller reproduction.

Full `pnpm test` has seven environment-only failures in `kernel-local-live-runner.test.ts`: this macOS host has no `/dev/shm`, so its Linux memory-storage prerequisite fails before fake Docker logging. The file was not modified.

## Self-review and concerns

- No second router, provider switch, admin flag, ports/interface/factory, Dapr framework, URI-policy DSL, cache, proxy, PDF download, scan, catalog, selection state, or persistence path was added.
- No response URL can enter a persisted or diagnostic field; the URI exists only in transport quick replies.
- Provider-free main cannot reach Account administrator authorization or provider-backed admin routing; `account_login` remains the intentional public direct Account operation.
- Deployment requires the pre-existing ACA secrets `line-main-channel-secret` and `line-main-channel-access-token`; no secret values were read or written here.
- The real Redis/PostgreSQL disposable integration gate remains required once the Docker daemon can start and clean its owned Compose project.
- Production webhook provisioning, LINE Console configuration, real-device delivery, and live Dapr/HHC web API acceptance remain external rollout obligations.
