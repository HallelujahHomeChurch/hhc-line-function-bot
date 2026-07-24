# R3.1 Task 4 Remediation Report

## Outcome

Completed the remaining Task 4 SearXNG deployment work after partial commit
`65b34cd`. SearXNG is now a separately deployed, internal-only ACA app. The
bot receives its HTTPS internal FQDN during deployment instead of an
office-network address.

## Implementation

- Added the production SearXNG settings template at
  `infra/searxng/settings.yml` and mounts its rendered ACA secret as
  read-only `/etc/searxng/settings.yml`.
- Kept SearXNG ingress internal, target port `8080`, one minimum replica, and
  the pinned image. No persistent cache mount is declared because this task
  does not provision ACA environment storage.
- Updated `scripts/deploy-aca.sh` to render the configuration with a generated
  secret key into a temporary manifest, create or update SearXNG before the bot
  revision, resolve `properties.configuration.ingress.fqdn`, and set
  `SEARXNG_BASE_URL` to its HTTPS internal FQDN.
- Replaced the bot manifest's static endpoint with a deployment-time
  placeholder and made the release workflow respond to the SearXNG manifest
  and settings changes.
- Removed SearXNG from the office Docker Compose service, local-service startup
  script, and operational runbook while preserving the ClamAV service for the
  later scan-job work.
- Updated README, AGENTS.md, and `.env.example` with the internal-only
  deployment contract.

## TDD Evidence

The tightened deployment-contract test was run before the remediation and
failed for the expected missing secret mount, missing FQDN deployment lifecycle,
and remaining local SearXNG service. A second focused RED run verified that an
HTTP FQDN would not satisfy the HTTPS ingress contract. The minimal deployment
changes made both assertions green.

## Verification

- Focused Task 4 suite: 3 files, 24 tests passed.
- Full Vitest suite: 104 files, 876 tests passed.
- Typecheck: passed.
- ESLint: passed.
- Build: passed.
- `bash -n scripts/deploy-aca.sh` and YAML parsing for the affected manifests:
  passed.
- `prettier --check .` still fails only for inherited files outside Task 4:
  SDD task briefs, `pnpm-lock.yaml`, OpenAI embedding test/client files, and
  `src/llm-diagnostics.ts`. All Task 4 formatter-supported files are clean;
  `.env.example` and PowerShell are unsupported by the configured Prettier
  parser.

## Scope Protection

The inherited Task 5 work was not edited or staged:

- `package.json`
- `pnpm-lock.yaml`
- `src/attachments/**`
- `src/__tests__/scan-queue.test.ts`

## Remaining Concerns

No live Azure deployment was run from this task. The release script now owns
the SearXNG lifecycle and must be exercised by the normal reviewed release
workflow before production use.

## Review Follow-up: Explicit SearXNG Update Target

The SearXNG update command now passes both `--resource-group "${RESOURCE_GROUP}"`
and `--name "${SEARXNG_CONTAINER_APP_NAME}"` alongside `--yaml`. The deployment
contract isolates the update branch before asserting both arguments, so the
create branch or nearby commands cannot satisfy it accidentally.

The focused RED run failed as expected when the update command omitted those
arguments:

```text
expected update command to contain --resource-group "${RESOURCE_GROUP}"
```

After restoring the explicit arguments, the focused contract suite passed:

```text
1 file, 5 tests passed
```

The final review-fix verification also passed:

- full Vitest suite: 104 files, 876 tests;
- TypeScript typecheck;
- ESLint;
- TypeScript build; and
- `bash -n scripts/deploy-aca.sh`.
