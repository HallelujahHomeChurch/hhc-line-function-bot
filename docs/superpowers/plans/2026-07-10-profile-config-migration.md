# Profile Configuration Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move helper profile behavior and prompts from an ACA secret into a validated, versioned config file while retaining only real credentials in ACA secrets.

**Architecture:** Production loads `/app/config/profiles.json`, which contains a JSON array of non-secret profiles. `config.ts` validates the file and resolves only named credential references from environment variables. The Azure DevOps pipeline validates the file, deploys the new image with legacy profile env removed, waits for a healthy revision, and then deletes the obsolete ACA secret.

**Tech Stack:** TypeScript, Node.js 24, Zod, Fastify, pnpm, Docker multi-stage build, Azure CLI, Azure DevOps Pipeline.

## Global Constraints

- Do not commit tokens, IDs treated as secrets, connection strings, or profile credentials.
- Production must not use `BOT_PROFILES_JSON` or `BOT_PROFILES_BASE64_JSON`.
- `config/profiles.json` must always have a JSON array root and must contain only `helper` until `main` credentials are provisioned.
- LLM small-talk profiles require all four prompt layers from config; no helper persona/safety fallback is allowed in code.
- Function-router JSON safety rules remain code-owned.
- Push only after all verification succeeds; pushing `main` deploys production.

---

### Task 1: Add the checked-in helper profile config and validate it

**Files:**
- Create: `config/profiles.json`
- Create: `src/tools/check-profile-config.ts`
- Modify: `src/config.ts`
- Modify: `src/__tests__/config.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `PROFILE_CONFIG_PATH` file loading for `loadConfigFromEnv(env)`.
- Produces `pnpm config:validate`, which exits zero only when the checked-in profile file passes the production-safe structural rules.

- [ ] **Step 1: Write failing configuration tests**

```ts
it('loads the checked-in profile file when PROFILE_CONFIG_PATH is set', () => {
  const config = loadConfigFromEnv({
    PROFILE_CONFIG_PATH: fixturePath,
    LINE_HELPER_CHANNEL_SECRET: 'secret',
    LINE_HELPER_CHANNEL_ACCESS_TOKEN: 'token',
    LINE_HELPER_ADMIN_USER_ID: 'admin',
    DATABASE_URL: 'postgres://test',
    REDIS_URL: 'redis://test'
  });
  expect(config.profiles.map((profile) => profile.name)).toEqual(['helper']);
});

it('rejects legacy profile environment variables in production', () => {
  expect(() => loadConfigFromEnv({ NODE_ENV: 'production', BOT_PROFILES_JSON: '[]' }))
    .toThrow('Production profile config must use PROFILE_CONFIG_PATH');
});
```

- [ ] **Step 2: Run the targeted config test and confirm failure**

Run: `pnpm test src/__tests__/config.test.ts`

Expected: the new tests fail because file loading and production rejection do not exist.

- [ ] **Step 3: Implement file-first production loading**

```ts
function readProfilesJson(env: NodeJS.ProcessEnv): string {
  if (env.NODE_ENV === 'production' && (env.BOT_PROFILES_JSON?.trim() || env.BOT_PROFILES_BASE64_JSON?.trim())) {
    throw new Error('Production profile config must use PROFILE_CONFIG_PATH');
  }
  if (env.PROFILE_CONFIG_PATH?.trim()) {
    return readFileSync(env.PROFILE_CONFIG_PATH, 'utf8');
  }
  // Preserve JSON env input only for tests and local development.
}
```

Create `config/profiles.json` as an array containing `helper` and its existing secret env references, enabled functions, provider policy, 60-second window, and all four agreed prompt layers.

- [ ] **Step 4: Add `pnpm config:validate`**

The tool reads `config/profiles.json`, creates synthetic values for each `*Env` reference, invokes the production parser, and prints only profile names, paths, function names, and provider names. It must reject direct `channelSecret`, `channelAccessToken`, `adminUserId`, legacy allowlists, or an incomplete LLM prompting bundle.

- [ ] **Step 5: Run targeted checks**

Run:

```powershell
pnpm test src/__tests__/config.test.ts
pnpm config:validate
```

Expected: both commands pass and the validation summary lists only `helper`.

- [ ] **Step 6: Commit**

```powershell
git add config src/config.ts src/tools/check-profile-config.ts src/__tests__/config.test.ts package.json
git commit -m "feat: load production profiles from config file"
```

### Task 2: Make profile prompting config-owned

**Files:**
- Modify: `src/config.ts`
- Modify: `src/small-talk.ts`
- Modify: `src/__tests__/config.test.ts`
- Modify: `src/__tests__/small-talk.test.ts`

**Interfaces:**
- Consumes the complete `smallTalk.prompting` object from Task 1.
- Produces an LLM small-talk prompt that contains no helper persona/safety fallback from code.

- [ ] **Step 1: Write failing tests**

```ts
it('rejects an LLM small-talk profile missing safetyRulesPrompt', () => {
  expect(() => loadConfigFromEnv(withProfile({
    smallTalk: { mode: 'llm', maxChars: 80, prompting: { personaPrompt: 'p', conversationRulesPrompt: 'c', formatRulesPrompt: 'f' } }
  }))).toThrow('LLM smallTalk prompting must include safetyRulesPrompt');
});

it('does not add a code-owned persona fallback when profile prompting is complete', async () => {
  // Assert the provider receives only configured persona/rules/safety/format text.
});
```

- [ ] **Step 2: Run the targeted test and confirm failure**

Run: `pnpm test src/__tests__/config.test.ts src/__tests__/small-talk.test.ts`

Expected: missing prompt values are currently accepted and fallback text is present.

- [ ] **Step 3: Require the four config prompts and remove helper-specific defaults**

Use Zod refinement after profile parsing to require all prompt keys for `mode: 'llm'`. Remove `defaultPersonaPrompt`, `defaultConversationRulesPrompt`, `defaultSafetyRulesPrompt`, `defaultFormatRulesPrompt`, and the static `你是 LINE bot 小哈` identity line from `small-talk.ts`. Preserve only protocol/category instructions and safe template fallback behavior for provider outages.

- [ ] **Step 4: Correct API-provider output limits**

Keep the configured 80-character cap for local Ollama fallback. For remote API generators, omit the `最多 N 個字` instruction and do not reject an otherwise safe reply solely for exceeding the local limit. Add tests for DeepSeek-style remote capabilities and Ollama fallback behavior.

- [ ] **Step 5: Run targeted checks**

Run:

```powershell
pnpm test src/__tests__/config.test.ts src/__tests__/small-talk.test.ts
pnpm typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```powershell
git add src/config.ts src/small-talk.ts src/__tests__/config.test.ts src/__tests__/small-talk.test.ts
git commit -m "refactor: make small talk prompts config owned"
```

### Task 3: Align container packaging, manifest, and CI deployment

**Files:**
- Modify: `Dockerfile`
- Modify: `aca.containerapp.yaml`
- Modify: `azure-pipelines.yml`
- Modify: `.env.example`
- Modify: `skills/hhc-line-deploy-guard/SKILL.md`
- Modify: `skills/hhc-line-deploy-guard/scripts/profile-secret.ps1`

**Interfaces:**
- Docker runtime exposes `/app/config/profiles.json`.
- ACA receives `PROFILE_CONFIG_PATH=/app/config/profiles.json` and no legacy profile JSON env.
- CI runs `pnpm config:validate` and clears obsolete profile config after the revision is healthy.

- [ ] **Step 1: Add packaging and manifest assertions**

Add a test or CI shell assertion that `config/profiles.json` exists in the runtime image build context. Update `aca.containerapp.yaml` to remove `bot-profiles-base64-json`, add `PROFILE_CONFIG_PATH`, and include all intended non-secret runtime settings. Make `GRAPH_SHEET_MUSIC_FOLDER_ITEM_ID` optional and set `GRAPH_SHEET_MUSIC_FOLDER_PATH=文件/流行歌譜 (捷徑)`.

- [ ] **Step 2: Run the assertion and confirm initial failure**

Run: `pnpm build`

Expected before Dockerfile change: the runtime image would not contain `config/`.

- [ ] **Step 3: Update Docker and pipeline**

Copy `config/` into the distroless runtime stage. Add `pnpm config:validate` to Validate. Remove the pipeline block that reads `bot-profiles-base64-json`. In the deploy command, set `PROFILE_CONFIG_PATH=/app/config/profiles.json` and conditionally remove `BOT_PROFILES_BASE64_JSON`, `BOT_PROFILES_JSON`, and `PROFILE_CONFIG_VERSION`. After readiness, conditionally remove the obsolete ACA secret.

- [ ] **Step 4: Convert deploy guard into a legacy-inventory guard**

Replace secret-edit actions with read-only checks that fail when legacy profile env/secret is present after migration. The guard must never decode or rewrite profile secrets after this migration.

- [ ] **Step 5: Update `.env.example`**

Remove the giant `BOT_PROFILES_JSON` line. Add `PROFILE_CONFIG_PATH=./config/profiles.json` for local use, retain only placeholder credential variables, and mark external operational values as explicit production configuration.

- [ ] **Step 6: Run pre-deploy verification**

Run:

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm config:validate
pnpm eval:router
pnpm eval:admin
pnpm build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 7: Commit**

```powershell
git add Dockerfile aca.containerapp.yaml azure-pipelines.yml .env.example skills
git commit -m "chore: migrate production profile config out of ACA secrets"
```

### Task 4: Deploy and prove the ACA end state

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture-context.md`
- Modify: `docs/runbooks/production-operations.md`

**Interfaces:**
- Documents one production source of truth: `config/profiles.json` plus ACA credential secrets.

- [ ] **Step 1: Update documentation**

Document the config-file source, secret inventory, no-profile-secret rule, and post-deploy verification commands. State that `main` is not deployed until its separate credential references exist.

- [ ] **Step 2: Commit documentation**

```powershell
git add README.md AGENTS.md docs
git commit -m "docs: document profile configuration source of truth"
```

- [ ] **Step 3: Push the validated branch**

Run: `git push origin main`

Expected: Azure DevOps validates the profile file, builds a new ACR image, deploys a healthy revision, and removes the legacy profile env/secret only after readiness.

- [ ] **Step 4: Verify production state**

Run the deploy guard, `az containerapp show`, revision list, secret list, and the admin direct-chat `/diag`. Confirm the active revision is healthy, two replicas can start, `PROFILE_CONFIG_PATH` is present, and legacy profile env/secret are absent.

## Plan Self-Review

- Spec coverage: Tasks 1-4 cover source-of-truth migration, prompt ownership, missing runtime values, CI cleanup, documentation, deployment, and post-deploy evidence.
- Placeholder scan: no implementation decisions are deferred; real credential values remain deliberately outside the repository.
- Type consistency: `PROFILE_CONFIG_PATH`, `config/profiles.json`, `pnpm config:validate`, and the four `smallTalk.prompting` fields are used consistently across all tasks.
