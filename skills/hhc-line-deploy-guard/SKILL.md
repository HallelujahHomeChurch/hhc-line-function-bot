---
name: hhc-line-deploy-guard
description: Guard and diagnose hhc-line-function-bot Azure DevOps to Azure Container Apps deployments, especially BOT_PROFILES_BASE64_JSON profile secret shape problems. Use when pushing main, checking pipeline deploy status, updating ACA profile secrets, repairing a bad bot-profiles-base64-json secret, or investigating revisions that fail to become ready.
---

# HHC LINE Deploy Guard

## Purpose

Use this skill for this repo's deployment path only: Azure DevOps pipeline -> ACR image -> Azure Container Apps revision.

The fragile production setting is `bot-profiles-base64-json`. Its decoded JSON root must always be an array, even when there is only one profile:

```json
[{ "name": "helper" }]
```

Never write a single profile object as the root:

```json
{ "name": "helper" }
```

That exact mistake caused ACA revisions to crash with:

```text
BOT_PROFILES_JSON or BOT_PROFILES_BASE64_JSON must be a JSON array
```

## Rules

- Do not hand-roll PowerShell JSON/base64 update commands for `bot-profiles-base64-json`.
- Use `scripts/profile-secret.ps1` before and after changing this secret.
- Use `ConvertTo-Json -InputObject $profiles -Depth 100 -Compress` when a manual JSON conversion is unavoidable.
- Do not pipe a single-element profile array into `ConvertTo-Json`; PowerShell may serialize a single object root.
- Do not print LINE tokens, Graph secrets, Notion tokens, database URLs, Redis URLs, or provider API keys.
- Treat `git push origin main` as a production deployment action when trigger paths are changed.

## Secret Workflow

Read-only check:

```powershell
powershell -ExecutionPolicy Bypass -File skills\hhc-line-deploy-guard\scripts\profile-secret.ps1 -Action check
```

Show a non-sensitive profile summary:

```powershell
powershell -ExecutionPolicy Bypass -File skills\hhc-line-deploy-guard\scripts\profile-secret.ps1 -Action summary
```

Repair a bad single-object root by wrapping it in an array:

```powershell
powershell -ExecutionPolicy Bypass -File skills\hhc-line-deploy-guard\scripts\profile-secret.ps1 -Action repair-array-root -Apply -BumpConfigVersion
```

Bump the profile config revision after a separate secret change:

```powershell
powershell -ExecutionPolicy Bypass -File skills\hhc-line-deploy-guard\scripts\profile-secret.ps1 -Action bump-config-version
```

## Deploy Diagnosis

Use this order when a pipeline run fails or hangs:

1. Check the Azure DevOps run status and timeline.
2. Check the ACA image, `latestRevision`, and `latestReadyRevision`.
3. If latest is not ready, inspect logs for that exact revision.
4. If logs mention profile JSON or config startup failure, run the secret check script.
5. Only after the revision logs are clean, investigate app code or the pipeline wait loop.

Useful commands:

```powershell
az pipelines runs show --organization https://dev.azure.com/HalleluyaHomeChurch --project OPS --id <runId> --query "{id:id,status:status,result:result,sourceVersion:sourceVersion,finishTime:finishTime}" -o json

$timeline = az devops invoke --organization https://dev.azure.com/HalleluyaHomeChurch --area build --resource timeline --route-parameters project=OPS buildId=<runId> -o json | ConvertFrom-Json
$timeline.records | Where-Object { $_.type -in @('Stage','Job','Task') } | Select-Object name,type,state,result,startTime,finishTime | Format-Table -AutoSize

az containerapp show --resource-group alive --name hhc-line-function-bot --query "{latestRevision:properties.latestRevisionName,latestReadyRevision:properties.latestReadyRevisionName,runningStatus:properties.runningStatus,image:properties.template.containers[0].image}" -o json

az containerapp revision list --resource-group alive --name hhc-line-function-bot --query "[].{name:name,active:properties.active,traffic:properties.trafficWeight,health:properties.healthState,running:properties.runningState,image:properties.template.containers[0].image}" -o table

az containerapp logs show --resource-group alive --name hhc-line-function-bot --revision <revisionName> --tail 120
```

## Expected Constants

- Azure DevOps organization: `https://dev.azure.com/HalleluyaHomeChurch`
- Azure DevOps project: `OPS`
- Pipeline: `hhc-line-function-bot ci`
- Resource group: `alive`
- Container app: `hhc-line-function-bot`
- Profile secret: `bot-profiles-base64-json`
- Image pattern: `alive.azurecr.io/alive/hhc-line-function-bot:main-<BuildId>`
