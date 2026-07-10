# Profile Configuration Migration Design

## Goal

Make the deployed helper bot's non-secret profile configuration deterministic, versioned, and reviewable. The production app must not use `BOT_PROFILES_JSON` or `BOT_PROFILES_BASE64_JSON`; only credential values may come from ACA secrets.

## Current Failure

`bot-profiles-base64-json` is an ACA secret whose decoded root is a single object. The running revision has one surviving replica, but newly started replicas fail because the runtime requires an array root. The source of truth also drifted from the repository's prompt configuration because the secret could be edited independently of the image.

## Decision

Use `config/profiles.json` in the application image as the production source of truth. It is a JSON array containing only the active `helper` profile and no credential values. Its profile references credentials by environment variable name:

- `LINE_HELPER_CHANNEL_SECRET`
- `LINE_HELPER_CHANNEL_ACCESS_TOKEN`
- `LINE_HELPER_ADMIN_USER_ID`

The production container sets `PROFILE_CONFIG_PATH=/app/config/profiles.json`. The app rejects legacy `BOT_PROFILES_JSON` and `BOT_PROFILES_BASE64_JSON` values when `NODE_ENV=production`; local tests and development may continue to pass `BOT_PROFILES_JSON` explicitly.

## Profile and Prompt Rules

`config/profiles.json` contains all helper-specific behavior: enabled functions, access policy, provider policy, general-agent settings, and the complete small-talk prompt bundle.

For profiles with `smallTalk.mode="llm"`, the following properties are mandatory and may not fall back to hard-coded persona/safety text:

- `personaPrompt`
- `conversationRulesPrompt`
- `safetyRulesPrompt`
- `formatRulesPrompt`

The code may retain only non-persona operational instructions such as the selected small-talk category and output sanitization. Function-router JSON contracts remain in code because they are executable security boundaries, not editable bot personality.

The production file contains `helper` only. `main` remains an example/future profile until its own LINE credential references are configured.

## ACA Target State

Remove these legacy items after the replacement revision is ready:

- Environment variables: `BOT_PROFILES_BASE64_JSON`, `BOT_PROFILES_JSON`, `PROFILE_CONFIG_VERSION`
- Secret: `bot-profiles-base64-json`

Add the non-secret environment variable:

- `PROFILE_CONFIG_PATH=/app/config/profiles.json`

Retain ACA secret references for LINE credentials, Postgres, Redis, DeepSeek API key, Notion token, Graph client secret, and Ollama base URL. Retain non-secret service, LLM, Graph, Notion, rate-limit, and schedule settings.

The migration also makes currently implicit operational settings explicit: `READY_PATH`, context/output budgets, confirmation TTL, rate limits, error history size, and sheet-music folder/path settings. `OLLAMA_KEEP_ALIVE` remains unset because model warming is managed by the office machine rather than the bot process.

## Deployment Flow

1. CI validates `config/profiles.json` with synthetic credential values before building the image.
2. The image copies `config/` into `/app/config`.
3. Deploy updates the image, sets `PROFILE_CONFIG_PATH`, and removes legacy profile environment variables in the same ACA update.
4. CI waits for the target revision to be ready.
5. Only after readiness, CI removes the obsolete `bot-profiles-base64-json` secret.
6. Post-deploy checks confirm the running image, revision health, and absence of legacy profile configuration.

If CI fails before the ACA update, the existing app is unchanged. If the new revision fails, the obsolete secret is not removed.

## Explicit Runtime Values

The deployed manifest must explicitly set the values already intended by `.env.example`: `LLM_CONTEXT_WINDOW_TOKENS=272000`, `LLM_RUNTIME_CONTEXT_BUDGET_TOKENS=2000`, `LLM_CONTEXT_COMPRESSION_THRESHOLD_RATIO=0.75`, `LLM_GENERAL_MAX_OUTPUT_TOKENS=160`, `LLM_ROUTE_MAX_OUTPUT_TOKENS=256`, confirmation/rate-limit defaults, and sheet-music search settings. The sheet-music item ID remains optional; the configured path is `文件/流行歌譜 (捷徑)`.

Remote API small talk must not be artificially capped by the local-model 80-character setting. The profile setting applies to local fallback; API-provider behavior is explicitly represented in code and tests.

## Verification

Tests cover file loading, production rejection of legacy profile env values, array-root validation, absence of inline credentials, required LLM prompt layers, and Docker inclusion of the config file. CI runs `pnpm config:validate` in addition to the existing typecheck/lint/test/router/admin checks. Deployment verification checks the exact image and revision state, then validates the ACA env/secret inventory without exposing secret values.
