# Official LINE Account Experience Design

**Status:** Approved in conversation on 2026-08-08

## Goal

Make the provider-free `main` LINE profile predictable without an LLM, and replace the current two-stage LINE Account Link flow with one explicit HHC Account confirmation that securely binds the signed LINE user ID to the authenticated HHC user.

## Problems Being Corrected

1. Unsupported text falls through to the helper-specific reassurance copy beginning with `不會啦`, which is unrelated to the official account.
2. `/help` works, but the natural-language equivalent `幫助` does not.
3. Account linking redirects through LINE Account Link after the user already authenticated to HHC Account, causing a redundant LINE authentication step.
4. Help always advertises account login, even after the LINE user ID is linked.
5. The exact phrase `登入 HHC 帳戶` works, but the natural command `登入` does not.
6. `/whoami` exposes LINE and access-policy diagnostics rather than safe HHC Account information, and `我是誰` is not recognized.
7. The account confirmation page exposes the internal profile name `main` as if it were a user-facing LINE profile.
8. Successful linking leaves the user in the browser without a reliable path back to the official LINE chat.

## Selected Approach

Use the LINE user ID from the signature-verified Messaging API webhook as the identity being linked. The bot creates a short-lived opaque intent bound to that user ID and sends the HHC Account URL in the direct chat. The browser exchanges the fragment token for the existing secure HttpOnly intent cookie. After HHC authentication, the user explicitly confirms the link once, and Account API atomically attaches the LINE federated identity to the authenticated HHC user.

The Account API keeps the existing one-time-token, expiry, ownership-conflict, active-user, unique-identity, transaction, and sanitized-audit boundaries. The user-facing flow no longer issues a LINE link token, redirects to `access.line.me/dialog/bot/accountLink`, or waits for an `accountLink` webhook event.

### Rejected Alternatives

- **Keep LINE Account Link and only change copy:** smallest code change, but preserves the redundant LINE step that caused the problem.
- **Bind immediately when the link opens:** fewer clicks, but a forwarded link could silently bind its LINE identity to an already signed-in browser account. It also removes the ability to inspect or switch the HHC account.
- **Turn the bot into a full OAuth client:** adds authorization-code, callback, client-secret, and token-lifecycle machinery without improving this one identity association.

## User Experience

### User Is Not Signed In to HHC Account

1. The user sends `登入` or another accepted login phrase in a one-to-one LINE chat.
2. The bot checks whether the LINE user ID is already linked. If not, it creates the opaque binding intent and replies with the HHC Account link.
3. Opening the link exchanges the fragment token for the secure intent cookie and takes the anonymous user directly to the normal HHC Account login page.
4. The login page explains: `登入 HHC 帳戶以連結哈利路亞家教會官方 LINE`.
5. The user may use any enabled HHC login method. No login method is forced by the bot flow.
6. Authentication returns to `/line/bind`, which displays the confirmation page described below.

### User Is Already Signed In to HHC Account

Opening the bot link goes directly to the confirmation page after the fragment-to-cookie exchange.

The page contains only:

- Title: `連結 HHC 帳戶`
- Description: `確認將哈利路亞家教會官方 LINE 連結至這個 HHC 帳戶。`
- HHC Account: the signed-in account email
- Actions: `確認連結`, `切換帳戶`, and `取消`

The page does not display `main`, the internal profile name, channel ID, LINE user ID, or a `LINE 個人檔案` row.

### Successful Link

The page displays:

> HHC 帳戶已連結  
> 你可以回到 LINE 使用週報及帳戶功能。

It immediately attempts to open the official account through the supported HTTPS LINE URL scheme `https://line.me/R/ti/p/{percent-encoded LINE ID}` and always leaves a visible `返回 LINE` link using the same URL. It never uses the deprecated `line://` scheme. Failure to launch the app does not undo or retry the completed binding.

### Existing Link

If the bot detects that the LINE user ID is already linked, `登入` does not create another intent. It replies that the HHC Account is already connected and offers `我是誰` and `下載週報` quick replies.

## Deterministic Keyword Groups

The provider-free profile recognizes normalized complete phrases. Normalization applies Unicode NFKC, trim, case folding for Latin text, and removal of terminal whitespace or punctuation. Matching is not a substring search, so negated or embedded phrases do not accidentally execute an action.

| Intent                | Accepted phrases                                                      |
| --------------------- | --------------------------------------------------------------------- |
| Help                  | `/help`, `幫助`, `說明`, `功能`, `可以做什麼`                         |
| Account login         | `登入`, `登入帳戶`, `登入 HHC 帳戶`, `連結帳戶`, `綁定帳戶`, `login`  |
| Account identity      | `/whoami`, `我是誰`, `我的帳戶`, `帳戶資訊`, `我的身分`               |
| Latest weekly paper   | Existing phrases including `下載週報`, `最新週報`, and `下載最新週報` |
| Specific weekly paper | Existing bounded issue-number phrases, including `下載第 1733 期週報` |

Examples that must not execute include `不要登入`, `不用下載週報`, and `取消下載週報`. `你是誰` remains bot self-introduction and is not an account-identity query.

The routing precedence is:

1. Signature, profile/source policy, webhook deduplication, and rate limit.
2. Local help, account-login, and account-identity phrases.
3. Existing weekly-paper controlled capability.
4. Provider-free unsupported fallback.

No route in this profile calls DeepSeek or an embedding provider.

## Replies and Capability Projection

### Unsupported Text

Unsupported provider-free input replies:

> 這個功能目前尚未支援。輸入「幫助」查看我可以協助的項目。

Recognized greetings such as `你好` keep their existing friendly greeting instead of using the unsupported fallback.

### Help

Help resolves the current LINE-to-HHC association before rendering:

- **Unlinked:** show weekly-paper download and HHC Account login.
- **Linked to an active account:** hide login; show weekly-paper download and account information.
- **Account API unavailable:** continue to show weekly-paper download, omit account mutation buttons, and say that account status is temporarily unavailable.

Natural `幫助` and `/help` render the same result.

### Who Am I

For `main`, `/whoami` and its natural-language aliases return only:

- HHC display name
- Masked email
- Sorted role names such as `user` or `admin`

They never return HHC user ID, LINE user ID, profile/channel identifiers, claims, or internal access-policy fields.

If unlinked, the response says that no HHC Account is connected and offers an account-login quick reply. If the identity exists but its HHC user is unavailable or inactive, the response says the account is unavailable and directs the user to support rather than offering a second binding.

The existing helper diagnostic `/whoami` remains unchanged unless a separate product decision is made later.

## Service Boundaries

### Account API

- Keep the opaque fragment token, secure HttpOnly intent-session cookie, expiry, CSRF, authenticated-user derivation, and Dapr-only bot boundary.
- Allow the internal binding-intent request to use the webhook-proven expected LINE user ID without a LINE link token.
- Add an authenticated and CSRF-protected direct-confirm operation. It must lock the binding and user, check expiry and terminal status, enforce expected ownership, enforce both LINE identity uniqueness constraints, insert the federated identity idempotently, and commit consent, completion, and audit records in one database transaction.
- Keep repeated confirmation idempotent for the same HHC user and LINE user ID; return conflict for either identity already owned elsewhere.
- Extend the Dapr-only LINE identity lookup to return `bound`, existing admin authorization, and an optional sanitized active-account summary containing display name, masked email, and sorted roles.
- Do not expose the raw account summary through public unauthenticated routes.

### Account Frontend

- Preserve fragment-before-render capture and fragment-to-cookie exchange.
- Redirect anonymous users to normal HHC login after a successful exchange, then return once to `/line/bind`.
- For authenticated users, show the minimal HHC confirmation page without the internal LINE profile row.
- Replace the LINE Account Link redirect with the direct-confirm request.
- On success, attempt the official HTTPS LINE return link and retain the visible fallback button.
- Treat the official-account return URL as public deployment configuration and validate that it is the canonical `https://line.me/R/ti/p/...` shape before navigation.

### LINE Bot

- Stop issuing a Messaging API link token for new login intents.
- Resolve linked account state only for help, login, whoami, and authority-sensitive operations; weekly-paper and unsupported turns remain independent of Account API availability.
- Reuse the existing action catalog and public command handling rather than creating a second router.
- Keep all new keyword handling provider-free and deterministic.
- Remove user-facing dependence on the `accountLink` event. A short compatibility window may acknowledge already-issued legacy events during rollout, but no new flow may create them.

## Error Handling

- Expired or consumed intent: show an expired-link state and instruct the user to send `登入` again in LINE.
- LINE identity linked to another HHC user, or HHC user linked to a different LINE identity: show a conflict state and do not mutate either identity.
- HHC user inactive or missing: refuse confirmation without changing the binding.
- Account API timeout during bot login/status lookup: return a short retry message; do not fall through to the generic unsupported reply.
- Confirmation timeout or ambiguous response: allow an idempotent retry using the same intent session.
- Automatic LINE return blocked: keep the success state and functional `返回 LINE` link.

## Deployment and Compatibility

Deploy in this order:

1. **Account API:** add direct confirmation and the sanitized identity response while retaining compatibility with current intent records.
2. **Account frontend:** switch the confirmation page from LINE Account Link preparation to direct confirmation and add the return-to-LINE experience.
3. **LINE bot:** switch intent creation to the webhook-proven UID path, add deterministic aliases and account-aware help/whoami, and stop creating LINE Account Link events.
4. Wait beyond the ten-minute legacy intent lifetime, verify no retrying legacy `accountLink` events, then remove any temporary compatibility code if it was required for zero-downtime rollout.

Each repository uses its protected-main PR and production workflow. A repository advances only after its CI and live smoke checks pass. Rollback must preserve the compatibility contract of the previously deployed component.

## Acceptance Criteria

### Bot Conversation

- `幫助` and `/help` produce the same provider-free help.
- `登入` starts the flow when unlinked and reports already linked when linked.
- `我是誰` and `/whoami` share the same safe HHC result.
- Help hides login after a successful link.
- Unknown input uses the new basic unsupported reply and points to `幫助`.
- Greetings remain friendly.
- Negated login or weekly-paper text never executes.
- Latest and specified weekly-paper downloads continue to work.
- Provider spies observe zero DeepSeek and embedding calls for all cases above.

### Browser Flow

- Anonymous link: login page, then one confirmation page, then success.
- Authenticated link: one confirmation page, then success.
- No page exposes `main` or a raw LINE/HHC identifier.
- Confirmation never redirects through LINE Account Link.
- Success attempts the official LINE HTTPS URL and keeps a working fallback link.
- Cancel, account switch, retry, StrictMode replay, back navigation, and terminal errors do not reuse an old fragment or auto-confirm another intent.

### Account Correctness

- The same binding confirmation is idempotent.
- Concurrent attempts for one LINE identity produce one owner and one conflict.
- Audit failure rolls back identity and terminal status.
- Expiry, inactive user, ownership conflict, malformed input, and Dapr caller spoofing fail closed.
- Sanitized identity lookup returns masked email and roles only to the authorized bot caller.

### Production Smoke Test

- Verify help/login/whoami before linking with a real official-account user.
- Complete HHC login and direct confirmation without a LINE Account Link screen.
- Verify automatic or button-assisted return to the official chat on iOS and Android when available.
- Verify post-link help, whoami roles, latest weekly paper, and a specified issue.
- Confirm provider telemetry remains zero for the `main` profile and inspect sanitized account-link outcome telemetry without user IDs, emails, tokens, or URLs.

## Non-Goals

- No LIFF application.
- No new LLM provider or fallback provider.
- No general intent framework, keyword DSL, or second router.
- No change to normal HHC login-provider policy.
- No automatic binding from OAuth email claims.
- No raw account identifiers in bot replies or telemetry.
- No redesign of helper access registration or helper `/whoami` diagnostics.
