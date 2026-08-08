# Shared LINE Account Experience Implementation Plan

> Implement repository by repository with TDD and a review checkpoint after each production contract. Do not merge a deploy-triggering PR without explicit production approval.

**Goal:** Give `main` and `helper` reusable, profile-controlled help, HHC Account login, safe whoami, and predictable fallback behavior without LINE Login or LINE Account Link.

**Architecture:** Reuse the existing Account API intent, authenticated consent, nonce, Finalize transaction, and signed LINE webhook identity. The browser prepares a one-time challenge and opens the official account chat with a prefilled confirmation message; only the initiating signed LINE UID can finish the link. Functions remain globally registered and profile policy remains authoritative.

**No new:** database table, direct-completion repository path, router, keyword DSL, LIFF app, OAuth client, provider, dependency, or profile-specific implementation.

## Global Security and Compatibility Rules

- Never complete a binding in the browser alone.
- Never log or persist raw fragment bearers, confirmation nonces/messages, LINE UIDs, HHC user IDs, URLs, or emails in bot telemetry/traces/errors.
- Account roles exposed to LINE are limited to `user` and `admin`.
- Keep legacy Account Link metadata and event finalization through a separately approved rollback window; new flows never issue a LINE link token.
- All account-link-enabled LINE channels must belong to one LINE Developers Provider. Block deployment if this cannot be verified.
- Account API private routes require a proven non-public Dapr boundary; a caller-supplied header is not sufficient on public ingress.
- Exact aliases use the existing normalizer and negation guard.
- Main local paths make zero DeepSeek and embedding calls.

---

## Task 1: Account API — Add Safe Challenge Preparation

**Repository:** `account/account-api`

**Primary files:**

- `internal/services/line_binding_service.go`
- `internal/services/line_binding_native_service_test.go`
- `internal/repository/line_binding_repo.go`
- `internal/repository/line_binding_repo_integration_test.go`
- `internal/handlers/line_handler.go`
- `internal/handlers/line_handler_test.go`
- `internal/routes/routes.go`
- `internal/routes/routes_test.go`
- existing Redis transfer/session tests

**Reuse:** existing CreateIntent, Exchange, Inspect, Consent, AwaitLINE, Finalize, token transfer, repository transaction, and migration `000010`.

### Contract

```go
type LineBindingSummary struct {
    LineAccountName string    `json:"line_account_name"`
    ViewNonce       string    `json:"view_nonce"`
    ExpiresAt       time.Time `json:"expires_at"`
}

type PrepareLineBindingRequest struct {
    ViewNonce string `json:"view_nonce"`
}

type PrepareLineBindingResult struct {
    ReturnURL string `json:"return_url"`
}
```

Internal create accepts trusted expected LINE UID, profile/channel context, bounded public display name, and canonical `@...` LINE ID. It does not require a Messaging API link token for new intents. The provider identifier is used only by bot startup/deployment validation; the binding transaction does not need another stored copy.

### Steps

- [ ] Add RED service tests for a new intent without `line_link_token`, presentation validation, expiry, and backward decoding of old metadata.
- [ ] Add RED multi-tab tests: exchange creates a per-view random nonce; Prepare with the wrong view nonce changes no consent/status/audit; source/session transfer failures remain retry-safe.
- [ ] Add RED Prepare tests requiring authenticated user + CSRF + intent cookie + strict `{view_nonce}` body. Reject client user IDs, profile names, LINE IDs, or return URLs.
- [ ] Construct the exact `https://line.me/R/oaMessage/...` URL server-side from stored trusted metadata and a 32-byte random nonce encoded as unpadded 43-character base64url. The prefilled message is exactly `HHC_ACCOUNT_LINK_V1:<nonce>`. Validate exact HTTPS host/path, canonical percent encoding, bounded length, no userinfo/port/fragment/extra query.
- [ ] Define Prepare replay semantics: after the first successful transition to `awaiting_line`, the same HHC user + intent session + view nonce returns the same stored challenge/URL until expiry. Parallel calls converge on that value; response loss never mints a replacement nonce or invalidates the first challenge.
- [ ] Reuse Consent/AwaitLINE and the existing Finalize transaction. Narrowly fix terminal replay ordering: for `completed`, compare the current signed UID with `ExpectedLineUserID` before returning idempotent success. Same-UID replay succeeds; different-UID replay returns conflict/non-success without changing terminal state or adding audit. Add both integration regressions. Add no repository method or migration.
- [ ] Extend identity/authorization response to `{bound, allowed, account?}` with display name, masked email, and sorted roles filtered to `user|admin`; omit HHC `user_id` from the bot response.
- [ ] Keep legacy Prepare behavior only for legacy records carrying a link token. New records return only the `oaMessage` URL.
- [ ] Verify cookie clearing on terminal outcomes and retention on retryable failures.
- [ ] Run `go test -race ./... -count=1 -p=1`, `go vet ./...`, and existing migration/bootstrap policy scripts.
- [ ] Commit one focused Account API change and open a PR; do not merge until Task 2 compatibility is ready and deployment is approved.

**Acceptance:** forwarded browser links cannot finalize; tab A cannot prepare tab B; existing Finalize remains idempotent and atomic; legacy records still work during rollback.

---

## Task 2: Account Frontend — Replace Account Link With Return-to-LINE Challenge

**Repository:** `account/account-fe`

**Primary files:**

- `src/lib/api.ts`, `src/lib/api.test.ts`
- `src/lib/line-link-intent.ts`
- `src/lib/mock-account-api.ts`
- `src/pages/LineBindingPage.tsx`, `src/pages/LineBindingPage.test.tsx`
- `src/App.tsx`, `src/App.test.tsx`
- locale messages/tests

### Steps

- [ ] Add RED tests for anonymous exchange -> normal HHC login -> return once to `/line/bind`, and authenticated exchange -> confirmation directly.
- [ ] Capture `view_nonce` in component-local state/ref only; submit it to Prepare; never store it in session/local storage or a URL.
- [ ] Remove user-facing `main`/`helper`, `LINE 個人檔案`, channel/profile IDs, and raw identifiers. Show only friendly official-account copy and the current HHC email.
- [ ] Keep explicit `確認連結`; returning from authentication only restores the confirmation page and never auto-prepares the binding.
- [ ] Replace Account Link navigation with the Prepare result. On success show `HHC 帳戶已確認，請返回 LINE，送出預填訊息以完成連結。`, attempt one navigation, and retain `返回 LINE 完成連結`.
- [ ] Validate returned URL again: HTTPS, exact `line.me`, exact canonical `/R/oaMessage/{encoded @id}/` path, one encoded confirmation query, no userinfo/port/fragment/traversal/redirect.
- [ ] Change `切換帳戶` to current-session `logout()`, not `logoutAll()`.
- [ ] Preserve fragment-before-render, StrictMode fencing, one-shot auth marker, cancel/back/retry/late-response behavior, and terminal cleanup.
- [ ] Accept legacy response fields during rollback without displaying internal names; old intent records may still follow the old Account Link path until the compatibility window closes.
- [ ] Run `pnpm test:run`, `pnpm lint`, and `pnpm build`.
- [ ] Commit one focused Account FE change and open a PR.

**Acceptance:** no second LINE login screen; user must tap Send in LINE; two tabs cannot cross-complete; abandoned intents cannot auto-prepare a later intent.

---

## Task 3: Bot — Add Profile Account Presentation and Safe Client Contracts

**Repository:** `hhc-line-function-bot`

**Primary files:**

- `src/types.ts`, `src/config.ts`, `config/profiles.json`
- `src/account/account-admin-client.ts`
- production composition and focused config/client/deployment tests

### Runtime config

```ts
type RawAccountLinkPresentation = {
  displayName: string;
  lineIdEnv: string;
  providerIdEnv: string;
};

type AccountLinkPresentation = {
  displayName: string;
  lineId: string;
  providerId: string;
};
```

Production profile JSON uses environment references for deployment identifiers rather than committed real IDs; normalization produces the runtime shape.

### Steps

- [ ] Add RED config tests for absent accountLink, complete valid accountLink, partial/invalid config, canonical `@` LINE ID, and equal provider IDs across every enabled profile.
- [ ] Add `accountLink` to both production profiles without putting credentials or real provider IDs in the repository. Keep bot ACA as the only holder of channel secret/access token.
- [ ] Resolve `lineIdEnv` and `providerIdEnv` only in the bot runtime config path. Attachment, catalog-sync, ClamAV, and assurance/background loaders must not require or receive those values.
- [ ] Remove Messaging API link-token issuance from new `createBinding`; send expected signed UID plus trusted presentation to Account API.
- [ ] Parse the sanitized identity response strictly. Reject raw/unmasked email, unknown roles, unexpected identifiers, malformed envelopes, redirects, and noncanonical responses.
- [ ] Preserve existing timeout/429/5xx retry classification and permanent 4xx fail-closed behavior.
- [ ] Add deployment tests proving account-link environment values reach only the bot container and are absent from background jobs, logs, and release artifacts.
- [ ] Run focused tests, `pnpm typecheck`, and `pnpm architecture:check`.

**Acceptance:** one shared client works for both profiles; no function/profile branch; provider ownership mismatch blocks startup/deployment.

---

## Task 4: Bot — Shared Help, Login, Whoami, and Signed Confirmation

**Repository:** `hhc-line-function-bot`

**Primary files:**

- existing action catalog/policy and public-command entrance
- `src/transport/line/webhook-routes.ts`
- `src/transport/line/public-access-commands.ts`
- `src/application/capabilities/capability-presenters.ts`
- `src/intro.ts`
- existing account client/LINE reply adapters
- `src/__tests__/entrance.test.ts`
- `src/__tests__/agent-turn-runtime.test.ts`
- Kernel/eval cases owned by affected modules

### Exact phrases

- Help: `/help`, `幫助`, `說明`, `功能`, `可以做什麼`
- Login: `登入`, `登入帳戶`, `登入 HHC 帳戶`, `連結帳戶`, `綁定帳戶`, `login`
- Whoami: `/whoami`, `我是誰`, `我的帳戶`, `帳戶資訊`, `我的身分`

### Steps

- [ ] Add RED alias tests using shared normalization, exact matching, punctuation/case normalization, and shared clause-negation protection. `你是誰` remains persona; embedded/negated phrases decline.
- [ ] Add a narrow byte-exact confirmation-message parser before ordinary dedupe/dependency work. It accepts only `HHC_ACCOUNT_LINK_V1:` plus exactly 43 unpadded base64url characters and sends nonce + signed source UID + profile/channel/event context to existing Finalize; do not apply NFKC or the natural-language normalizer.
- [ ] Add one local `looksLikeAccountLinkChallenge` guard for trimmed, case-insensitive ASCII `HHC`, `ACCOUNT`, `LINK` separated by spaces, `_`, or `-`. Malformed, unsupported-version, overlong, edited, group/room, missing-user, or accountLink-disabled messages terminate locally with no provider, conversation-window, task-state, account-identity, or raw-telemetry path.
- [ ] Apply the existing bounded per-profile/source rate limiter to every reserved-family message before Account API. Do not apply ordinary webhook dedupe to this path. Prove one first delivery plus same-event transient redelivery reaches Finalize twice, while random valid-shaped floods are throttled.
- [ ] Ensure raw confirmation text/nonce is excluded by construction from traces, product events, recent errors, conversation windows, task state, and logs. Telemetry records only bounded outcome codes.
- [ ] Preserve legacy `accountLink` webhook finalization during rollback. New flow never creates one. Test new and legacy events independently, including the same webhook event receiving transient 503 then redelivering into Finalize again, terminal acknowledgement, reply failure, and mixed batches.
- [ ] Login: public direct-only when accountLink exists. Already-linked active users get no new intent; inactive/bound users get support guidance; unavailable lookup gets retry guidance.
- [ ] Whoami: direct-only and safe. Return only display name, masked email, and public `user|admin` roles. Unbound offers Login; inactive never offers a second binding.
- [ ] Help: resolve effective functions and one reusable account state. Do not hard-code weekly paper. Linked active hides Login; inactive/unavailable states follow the design. Group help omits account state/actions.
- [ ] Preserve managed helper access: unmanaged users see no protected function names and receive only registration/public guidance.
- [ ] Ensure at most one identity lookup per local event and no account lookup for weekly/unknown paths that do not need it.
- [ ] Add both-profile matrices for linked/unlinked/inactive/API-failure, direct/group, managed/unmanaged, enabled/disabled functions, and provider spies.
- [ ] Run focused entrance/presenter/action tests, `pnpm eval:agent`, and `pnpm eval:kernel`.

**Acceptance:** every shared surface is implementation-reused and policy-controlled; `main` remains provider-free; helper access and provider behavior do not regress.

---

## Task 5: Bot — Correct Provider-Free Fallback

**Repository:** `hhc-line-function-bot`

**Primary files:**

- `src/messages.ts`
- `src/small-talk.ts`
- existing turn runtime/router boundary
- `src/__tests__/agent-turn-runtime.test.ts`
- relevant small-talk/provider-spy/Kernel tests

### Steps

- [ ] Keep global `messages.unsupported` unchanged so helper and validator-deny semantics do not regress.
- [ ] Add exact provider-free unknown copy: `輸入「幫助」查看我可以協助的項目。`.
- [ ] Make the shared small-talk classifier distinguish every current explicit deterministic category—greeting, thanks, persona, wellbeing, encouragement, and light joke—from no explicit match. Unknown provider-free text must not default to reassurance.
- [ ] Route only provider-free no-match input to the new copy. Keep all current explicit category behavior.
- [ ] Add main zero-provider tests for arbitrary unknown, typo, admin-looking, cross-function, and negated text; add helper regressions proving its existing controlled path remains unchanged.
- [ ] Run focused tests, `pnpm eval:agent`, and `pnpm eval:kernel`.

**Acceptance:** the screenshot's `不會啦` response is impossible for unknown main input, without globally changing denies or helper behavior.

---

## Task 6: Prove the Private Boundary and Update Assurance

**Repositories:** `account/account-api`, `account/api-gateway`, deployment configuration, `hhc-line-function-bot`

### Steps

- [ ] Add executable deployment tests proving Account API has no public external ingress and the gateway has no `/priv/account/.../line` route.
- [ ] Add a public-path negative probe with forged `Dapr-Caller-App-Id`; it must never reach the private handler. Keep gateway stripping of caller identity headers covered.
- [ ] Verify the bot workload's Dapr app ID is the only accepted caller. If the Account API can be reached directly from public ingress, stop and add cryptographic workload authentication before deployment.
- [ ] Add sanitized release/smoke checks for identity lookup and binding outcomes without UIDs, emails, nonces, URLs, or account data.
- [ ] Add config/deployment assertion that all participating production channels use the same LINE Provider; require a manual Console evidence checkpoint because repository config alone cannot prove provider ownership.
- [ ] Update README/architecture/runbook with the shared surface, challenge flow, proof limits, rollback compatibility, and real-device acceptance steps.
- [ ] Run each repository's existing release-policy, routing, safe-logging, and deployment-contract suites.

**Acceptance:** forged public caller headers cannot authorize private operations; assurance proves only the boundaries it actually exercises.

---

## Task 7: Ordered PR Rollout and Real LINE Acceptance

No merge/deploy is implicit. Request explicit approval before each deploy-triggering merge.

### Order

1. Deploy Account API additive compatibility.
2. Verify old FE and old bot remain functional.
3. Deploy Account FE dual compatibility.
4. Verify old bot intent and new FE behavior.
5. Deploy LINE bot new challenge flow and shared surfaces.
6. Run real-device acceptance on both profiles.

### Required live checks

- [ ] Confirm `main` and `helper` are channels under the same LINE Developers Provider.
- [ ] Before linking: `/help`, all aliases, `登入`, `/whoami`, unknown input, greetings, and negations on both profiles.
- [ ] Anonymous and already-authenticated browser flows; page never displays `main`/`helper`.
- [ ] Return-to-LINE button opens the correct official account; user sends the prefilled challenge; completion reply arrives.
- [ ] Forward the browser link to another signed-in browser and prove it cannot finalize without the initiating LINE UID.
- [ ] After linking: help hides Login; whoami shows masked account + public roles; enabled functions only.
- [ ] Latest/specified weekly paper works only where enabled.
- [ ] Provider telemetry stays zero for all `main` cases; logs/telemetry contain no binding material.
- [ ] Legacy Account Link event redelivery remains safe during rollback.

### Rollback and cleanup

- Roll back each service only to a revision compatible with the still-deployed neighbors.
- Keep legacy metadata and finalization until the separately approved rollback window ends.
- Do not include legacy deletion in these PRs. A later cleanup requires fresh usage evidence, its own PR, and production approval.

## Final Verification Matrix

| Boundary       | Minimum proof                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Account API    | full race tests, vet, migration/bootstrap policies, disposable Redis/Postgres integration      |
| Account FE     | full tests, lint, build, two-tab and StrictMode regressions                                    |
| Bot            | format, typecheck, lint, full tests, build, architecture, agent eval, Kernel                   |
| Gateway/deploy | route/method/safe-header tests, no public private route, release policy                        |
| Production     | real LINE `main` + `helper`, both auth states, iOS/Android when available, sanitized telemetry |

`pnpm eval:kernel:integration` is not required for the bot changes because they add no bot Redis/PostgreSQL lifecycle. Run it only if implementation changes that assumption.
