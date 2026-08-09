# Shared LINE Profile Account Experience Design

**Status:** Revised with Account-RBAC function authorization on 2026-08-09; pending user review

## Goal

Make `main` and `helper` share the same help, HHC Account linking, account identity, and reusable function implementations while profile configuration remains the function ceiling and HHC Account RBAC remains the sole person-level authorization authority. Replace the redundant LINE Login / LINE Account Link step without weakening proof that the person completing the flow controls the initiating LINE user ID. Add the first linked-account write function for updating the caller's own name.

## Decisions

- User functions remain registered once. `enabledFunctions` is the profile ceiling; `permissionRequiredFunctions`, source policy, HHC Account authorization, and effective-capability projection control availability per requester.
- Help, account login, and account identity remain shared system surfaces, not user functions.
- A profile enables account surfaces through optional `accountLink` presentation config. Both current profiles enable it.
- No code branches on literal profile names.
- New linking does not issue a LINE Login token or Messaging API Account Link token.
- The browser records authenticated HHC consent; a signature-verified message from the same LINE user finishes the binding.
- Existing Account API binding transaction, nonce verification, uniqueness constraints, idempotency, and audit remain the authority. No new table or direct-completion repository path is added.
- LINE Bot never authorizes from role names. Account API resolves direct and role-derived permissions through the existing RBAC model and returns only bounded decisions requested by the bot.
- Existing bot-local user/group function grants and role-capability bindings stop expanding effective functions. Their tables remain untouched for rollback; no data migration or backfill is performed.

## Why Browser-Only Completion Is Rejected

A binding URL is a bearer link. If it is forwarded, a signed-in recipient could otherwise attach the sender's LINE user ID to the recipient's HHC Account. Browser consent proves control of the HHC Account, but not control of the LINE user ID stored in the link.

The minimum safe replacement is one return to LINE: after HHC consent, the browser opens the official account chat with a short-lived confirmation message prefilled. The user sends it, and the bot finalizes using the source UID from the signature-verified webhook. This removes the second LINE login screen while retaining proof of both identities.

## Profile Contract

```ts
type AccountLinkPresentation = {
  displayName: string;
  lineId: string;
  providerId: string;
};
```

- `displayName` is user-facing, for example `哈利路亞家教會官方 LINE` or `小哈`.
- `lineId` is the Basic/Premium LINE ID beginning with `@`, used to construct the canonical `oaMessage` URL.
- `providerId` is a deployment invariant, not user-facing copy. All account-link-enabled profiles must belong to the same LINE Developers Provider because Account API currently stores one global `provider = line` subject namespace.
- Config validation requires all enabled profiles to declare the same nonempty `providerId`. Deployment is blocked until the actual LINE Developers Console ownership is verified. If the profiles do not share one Provider, this design stops and a provider-namespaced identity migration is required.

Each profile also declares:

```ts
type ProfileFunctionPolicy = {
  enabledFunctions: FunctionName[];
  permissionRequiredFunctions: FunctionName[];
};
```

`permissionRequiredFunctions` must be a subset of `enabledFunctions`. A function absent from `enabledFunctions` cannot be added by a user, group, role, or Account permission. A missing or unavailable Account permission denies only the permission-required function; it never falls back to an old bot grant.

## Authorization Model

For a permission-required function, Account API derives the canonical permission code rather than trusting a client-supplied permission string:

```text
line:<profileName>:function:<functionName>:execute
```

Execution authority is:

```text
profile enables function
AND source policy allows the event
AND linked HHC Account is active
AND Account RBAC grants the canonical permission
```

- Existing Account roles remain human-manageable permission bundles.
- Direct permissions remain available for exceptions.
- The `admin` role's wildcard continues to satisfy requested permissions.
- Bot code never maps `admin`, `helper_operator`, or another role name to functions.
- Permission definitions and role assignments are RBAC data managed through the existing Account administration surface. Adding a new LINE function does not require Account API code: the bot derives the permission name, and deployment fails closed until that permission exists and is assigned.
- Account API accepts only a bounded list of canonical profile/function pairs, never `*` or arbitrary Account permissions, and returns allowed function names rather than raw permission codes.
- Permission decisions are not cached initially. Help and one turn batch the required checks into at most one Account API request so revocation takes effect immediately.
- Public functions do not require account lookup. Active tasks and confirmations recheck permission before every side effect.

## Secure User Flow

### Start

1. In a one-to-one chat, the user sends `登入` or another exact login alias.
2. The bot resolves the signed webhook UID's HHC binding state.
3. If already linked to an active HHC account, it reports that state and offers `我是誰`; it creates no intent.
4. If unlinked, the bot creates a short-lived intent containing the expected LINE UID, profile/channel binding, public account presentation, and expiry. It sends the HHC Account URL.

### HHC Authentication and Consent

1. Account FE exchanges the fragment bearer for the existing Secure, HttpOnly intent-session cookie before rendering.
2. Anonymous users go directly to the normal HHC login page and may use any enabled HHC login method.
3. Authentication returns once to `/line/bind`.
4. Already authenticated users go directly to the same confirmation page.
5. The page displays only:
   - `連結 HHC 帳戶`
   - `確認將哈利路亞家教會官方 LINE 連結至這個 HHC 帳戶。`
   - the signed-in HHC account email
   - `確認連結`, `切換帳戶`, and `取消`
6. It never displays `main`, `helper`, a profile/channel ID, a LINE UID, or a `LINE 個人檔案` row.
7. `切換帳戶` signs out only the current account session, not all sessions.

### Multi-Tab Safety

- Exchange returns a random, non-secret `view_nonce` associated with that page's intent session.
- Account FE keeps it only in the page instance and submits it with Prepare.
- Account API compares it with the current intent-session metadata before recording consent.
- A tab whose cookie was replaced by a second intent fails closed instead of preparing the wrong binding.
- The raw fragment bearer and confirmation nonce never enter browser storage, URLs, logs, telemetry, or error text beyond their required short-lived transport boundary.

### Return to LINE and Finalize

1. Authenticated, CSRF-protected Prepare records HHC consent, creates the existing one-time confirmation nonce, and moves the transaction to `awaiting_line`.
2. Prepare returns a canonical HTTPS URL constructed server-side:

   ```text
   https://line.me/R/oaMessage/{percent-encoded LINE ID}/?{percent-encoded confirmation message}
   ```

3. The page says:

   > HHC 帳戶已確認
   >
   > 請返回 LINE，送出預填訊息以完成連結。

4. It attempts to open the URL and always retains a visible `返回 LINE 完成連結` button.
5. The user taps Send in LINE. The message has the exact ASCII wire format `HHC_ACCOUNT_LINK_V1:<nonce>`, where `nonce` is the unpadded 43-character base64url encoding of 32 random bytes. It is parsed byte-for-byte without Unicode normalization and is not treated as ordinary text.
6. Before ordinary Account API, access, provider, or routing dependencies, the bot validates the confirmation message shape, direct source, enabled account surface, and challenge rate limit, then calls existing Account API Finalize with the signed event source UID, nonce, profile/channel context, and webhook event ID.
7. Account API verifies that the signed UID equals the expected UID before returning success, including a replay of an already completed transaction. It commits the LINE identity, terminal state, and audit atomically, then the bot replies `已完成 HHC 帳戶登入／連結。`
8. Transient finalization returns non-2xx so LINE can redeliver. Terminal, conflict, expired, or duplicate outcomes are acknowledged without retry storms.

The prefilled-message URL cannot silently send a message; the user must tap Send. This is intentional identity proof, not another login.

Any trimmed ASCII text that looks like the reserved family—case-insensitive `HHC`, `ACCOUNT`, and `LINK` separated by spaces, `_`, or `-`—is consumed locally even when its version, token, length, source, or shape is invalid. It never reaches DeepSeek, conversation windows, task state, ordinary deduplication, or raw telemetry. Only the byte-exact V1 format is valid. Valid challenges require a one-to-one user source with a signed `userId` and an account-link-enabled profile.

Reserved-family messages use the existing bounded per-profile/source rate limiter before any Account API call, but they do not enter ordinary webhook deduplication. A normal first delivery and one same-event transient redelivery must fit the configured limit; abusive valid-shaped/random challenges are throttled. A transient Finalize failure returns non-2xx so the same webhook event can retry, and Account API Finalize supplies the idempotency boundary.

## Deterministic Keyword Groups

Matching uses shared normalization: Unicode NFKC, trim, Latin case folding, and terminal punctuation removal. Only complete normalized phrases match; there is no substring search. Negated clauses do not execute.

| Intent                | Accepted phrases                                                     |
| --------------------- | -------------------------------------------------------------------- |
| Help                  | `/help`, `幫助`, `說明`, `功能`, `可以做什麼`                        |
| Account login         | `登入`, `登入帳戶`, `登入 HHC 帳戶`, `連結帳戶`, `綁定帳戶`, `login` |
| Account identity      | `/whoami`, `我是誰`, `我的帳戶`, `帳戶資訊`, `我的身分`              |
| Latest weekly paper   | Existing phrases including `下載週報`, `最新週報`, `下載最新週報`    |
| Specific weekly paper | Existing bounded issue-number phrases such as `下載第 1733 期週報`   |

`不要登入`, `不用下載週報`, `取消下載週報`, and embedded matches do not execute. `你是誰` remains bot self-introduction.

## Entrance and Access Ordering

1. Signature and canonical profile/source structural policy.
2. Reserved linking-confirmation family or legacy `accountLink` event, when present, before ordinary webhook deduplication so transient failure can be redelivered. Reserved text validates direct source/profile and applies the bounded source rate limit before Finalize; the legacy event retains its existing signature-verified Finalize semantics.
3. Ordinary webhook deduplication and rate limit for all other events.
4. Shared local help/login/whoami after the applicable profile and source policy.
5. Existing controlled user-function routing.
6. Profile-appropriate fallback.

Additional rules:

- Login is public direct-chat behavior only when the profile declares `accountLink`.
- Whoami is safe direct-chat behavior only.
- Help resolves effective access. An unmanaged `helper` user sees no protected function names; it shows only available public guidance such as registration and account login.
- The bot performs at most one account-identity lookup for a handled local event and reuses the result for help/login/whoami presentation.
- Permission-required candidates are removed before planner/validator authority. The validator rechecks the same bounded decision before collection, preview, confirmation, and execution.
- Group help never exposes account state or account actions.
- The `main` paths above make zero DeepSeek and embedding calls.

## Replies

### Provider-Free Unknown Input

Keep the existing global unsupported/deny message unchanged for provider-enabled profiles and validator failures. Add a provider-free unknown reply:

> 輸入「幫助」查看我可以協助的項目。

The small-talk classifier must distinguish every existing deterministic category—greeting, thanks, persona, wellbeing, encouragement, and light joke—from unknown text. Unknown text must not default to reassurance for a provider-free profile. Existing provider-enabled `helper` fallback behavior remains unchanged.

### Help

Help is built only from the requester's effective functions and account state; it never hard-codes weekly paper for a profile.

- **Unbound:** show permitted functions and account login.
- **Bound and active:** hide login, show account information.
- **Bound but inactive/unavailable:** hide login and show support guidance.
- **Account lookup unavailable:** show permitted functions, omit binding mutation actions, and show a temporary status note.

Natural `幫助` and `/help` return the same projection.

### Whoami

When linked and active, both profiles return only:

- HHC display name
- masked email
- sorted public roles limited to `user` and `admin`
- human-readable names of currently enabled functions that Account RBAC allows

They do not return raw permission codes, HHC user ID, LINE UID, profile/channel identifiers, arbitrary custom roles, claims, or access-policy internals. Unbound users get a login action. Bound inactive users get support guidance, not a second link action.

## Update Own Profile

`update_own_profile` is a globally registered write function. Production enables it initially only on `main` and lists it in `permissionRequiredFunctions`; `helper` can enable the same module later without another implementation.

Version 1 changes only `first_name` and `last_name`, reusing the existing Account profile service. Email, password, OAuth identities, roles, permissions, active status, and avatar are out of scope.

The flow is direct-chat only:

1. Exact intent such as `/profile`, `修改個人資料`, `修改姓名`, or `更新姓名` selects the function without an LLM.
2. The controlled turn collects missing first/last-name fields and shows a preview.
3. Explicit confirmation is required. Provider-free routing may collect or preview a unique explicit write candidate, but can never directly execute it.
4. At confirmation, the bot rechecks the canonical Account permission and calls a Dapr-only Account API operation with the signed LINE UID, profile/channel context, and bounded names.
5. Account API resolves the linked active HHC user server-side, checks the same canonical permission, and updates that user only. It never accepts a target HHC user ID from LINE Bot. Repeating the same normalized names is a no-op; no new idempotency or audit table is added.

## Service Changes

### Account API

- Reuse existing CreateIntent, Exchange, Inspect, Consent/AwaitLINE, and Finalize service/repository flow. Narrowly harden existing Finalize terminal replay: a `completed` result is idempotent success only when the current signed UID still equals the transaction's expected UID; a different UID receives conflict/non-success without changing terminal state or audit.
- Do not add a browser direct-completion repository method or schema migration.
- New intent metadata adds public presentation and `view_nonce`; legacy `line_link_token` and `profile_name` remain optional for rollback compatibility.
- Prepare accepts authenticated HHC user context, CSRF, cookie session, and exact `view_nonce`; it does not accept a client user ID or return URL.
- New Prepare returns a canonical `oaMessage` URL and never returns an Account Link URL.
- Keep legacy Prepare/Account Link event handling for previously issued intents during the rollback window, but new intent creation never issues a link token.
- Extend the existing Dapr-only identity operation to return `bound`, `allowed`, and optional sanitized active account `{display_name, masked_email, roles}`. Stop returning HHC `user_id` to the bot.
- Keep roles limited to public `user` and `admin` values.
- Replace the administrator-only decision with one bounded authorization operation accepting `{line_user_id, profile_name, function_names}` and returning sanitized account state plus allowed function names. Validate canonical names, cap the list, reject duplicates and arbitrary permission codes, and use existing RBAC direct/role/wildcard evaluation.
- Add a Dapr-only update-own-profile operation. Resolve the user through the LINE identity, require active state and `line:<profile>:function:update_own_profile:execute`, and update only first/last name through the existing profile service. Repeating the same normalized values is a no-op; do not add or repurpose an audit/idempotency table.

### Account Frontend

- Preserve fragment-before-render capture, secure cookie exchange, one-shot auth return marker, operation fencing, and retry semantics.
- Replace the Account Link redirect with the Prepare result and the `返回 LINE 完成連結` state.
- Validate the returned URL again before navigation: HTTPS, exact `line.me`, exact `/R/oaMessage/.../` shape, canonical encoding, no userinfo, port, fragment, or unexpected query structure.
- Do not maintain a profile-name presentation map.
- Change `切換帳戶` from global logout to current-session logout.

### LINE Bot

- Add optional `accountLink` presentation to profile config and validate the shared Provider invariant.
- Add `permissionRequiredFunctions` as a validated subset of `enabledFunctions`; production explicitly declares it for both profiles.
- Reuse the existing account action/client and legacy `accountLink` finalization boundary.
- Add an exact local confirmation-challenge path that calls the same Finalize operation using signed event identity.
- Never write the confirmation message or nonce to route traces, product events, recent errors, or ordinary conversation state.
- Build help from effective capability projection plus the single resolved account state.
- Add aliases through the existing shared public-action boundary; do not create a keyword DSL or second router.
- Add an explicit provider-free unknown classification instead of replacing the global unsupported message.
- Remove bot-local function grants and role-capability bindings from effective-function calculation. Keep managed user/group registration as source authorization. Hide/reject obsolete function-grant administration commands, while leaving storage intact for rollback.
- Add the shared `update_own_profile` function module and enable it only through profile configuration.

## Internal Boundary and Deployment Security

The application currently trusts Dapr caller identity at its private route. Before production:

- prove Account API has no direct public ingress;
- prove API Gateway exposes no `/priv` Account API route;
- prove a forged `Dapr-Caller-App-Id` arriving through public ingress is rejected;
- verify the permitted Dapr app identity exactly matches the bot workload;
- block deployment if these checks do not hold. If public direct ingress cannot be removed, add cryptographic service authentication before shipping; a caller-supplied header alone is insufficient.

No secret or opaque binding value may appear in deployment output, logs, telemetry, or assurance reports.

## Compatibility and Rollout

Deploy through separate protected-main PRs, each requiring explicit production approval:

1. Account API: additive metadata, view correlation, bounded RBAC authorization, own-profile update, sanitized identity, new Prepare response, and legacy compatibility.
2. Account FE: consume both legacy and new summaries; new challenge-return UX; current-session account switch.
3. LINE bot: new intents without link tokens, shared commands, permission authority, own-profile update, confirmation challenge, and provider-free fallback.

Keep legacy fields and Account Link event finalization through a separately approved rollback window, not merely the intent TTL. Remove dead legacy issuance/consumption in a later cleanup only after all three services have remained stable and the known-good rollback revision no longer needs it.

There is no grant migration. Existing bot-local grant/role rows remain inert for rollback and are not copied into Account RBAC. Required production permissions and role assignments are created explicitly through existing RBAC administration before the bot release. Missing permission data blocks that function rather than broadening access.

## Acceptance Criteria

### Deterministic Bot Matrix

For both profiles, cover linked, unlinked, inactive, and Account API unavailable states where applicable:

- `/help` and every help alias produce the same effective, source-safe projection.
- `登入` and every login alias work only in direct chat and never create a second intent when already linked.
- `/whoami` and every identity alias return only safe HHC fields.
- Help hides login after linking and does not advertise disabled functions.
- Unmanaged helper users do not learn protected capabilities.
- Unknown provider-free input replies exactly `輸入「幫助」查看我可以協助的項目。`.
- Greetings and `你是誰` retain their explicit conversational behavior.
- Negated/cross-function phrases do not execute.
- Main provider spies remain zero; helper regressions retain existing provider behavior.
- One local event performs at most one Account API identity lookup.
- Permission-required functions are absent before authorization, present only for allowed linked users, and rechecked on continuation/confirmation.
- Bot-local user/group grants cannot enable a function that profile config or Account RBAC denies.
- `/profile` and natural aliases collect, preview, confirm, and update only the caller's first/last name on `main`; the same module remains disabled on `helper` until configured.

### Browser and Binding Correctness

- Anonymous: normal HHC login -> confirmation -> return-to-LINE prompt.
- Authenticated: confirmation -> return-to-LINE prompt.
- No page exposes internal profile names or raw identifiers.
- The user never sees LINE Login or LINE Account Link.
- A forwarded browser link cannot complete without a message from the initiating signed LINE UID.
- Two tabs cannot prepare the other tab's intent.
- Cancel, switch account, retry, StrictMode, back navigation, and terminal errors do not reuse old bearer state.
- Finalize remains idempotent; concurrent ownership produces one owner and one conflict; audit failure rolls back all mutations.
- Account authorization rejects missing/inactive/unlinked users, malformed profile/function names, arbitrary permission codes, and Account API failure; a canonical permission record that does not exist is simply denied.
- Own-profile update cannot select another user, cannot modify protected fields, rechecks permission at write time, and is idempotent for redelivery.

### Production Acceptance

- Verify the two channels are under the same LINE Developers Provider before merge/deploy.
- Verify Dapr/private-ingress assertions before any production mutation.
- Test help, login, return-to-LINE send, completion, post-link help, whoami roles, and enabled functions on real `main` and `helper` accounts.
- Assign and revoke a permission through existing Account RBAC, then prove help and execution change immediately without a Bot or Account deployment.
- On `main`, update first/last name through preview and confirmation; verify `/whoami` reflects the change. Verify `helper` denies the function while disabled.
- Verify iOS and Android app opening when available; browser fallback remains usable.
- Confirm no LINE Login/Account Link page appears.
- Confirm `main` provider telemetry remains zero and all account telemetry is sanitized.

## Non-Goals

- No LIFF app, OAuth client, second router, keyword DSL, or new dependency.
- No profile-specific function implementations.
- No new database table or identity migration while the shared LINE Provider invariant holds.
- No automatic binding from OAuth/email claims.
- No exposure of raw account identifiers, arbitrary roles, challenges, or URLs in telemetry.
- No legacy cleanup in the initial rollout.
