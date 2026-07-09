param(
  [ValidateSet("check", "summary", "repair-array-root", "bump-config-version")]
  [string] $Action = "check",
  [string] $ResourceGroup = "alive",
  [string] $ContainerAppName = "hhc-line-function-bot",
  [string] $SecretName = "bot-profiles-base64-json",
  [string] $ProfileConfigVersionName = "PROFILE_CONFIG_VERSION",
  [switch] $Apply,
  [switch] $BumpConfigVersion
)

$ErrorActionPreference = "Stop"

function Invoke-AzJson {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

  $output = & az @Arguments -o json
  if ($LASTEXITCODE -ne 0) {
    throw "az command failed: az $($Arguments -join ' ')"
  }
  return $output | ConvertFrom-Json
}

function Get-ProfileSecret {
  $secret = Invoke-AzJson -Arguments @(
    "containerapp", "secret", "show",
    "--resource-group", $ResourceGroup,
    "--name", $ContainerAppName,
    "--secret-name", $SecretName
  )

  $value = [string] $secret.value
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Secret '$SecretName' is empty or unavailable."
  }

  try {
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
  } catch {
    throw "Secret '$SecretName' is not valid base64: $($_.Exception.Message)"
  }

  try {
    $parsed = $decoded | ConvertFrom-Json
  } catch {
    throw "Decoded secret '$SecretName' is not valid JSON: $($_.Exception.Message)"
  }

  $trimmed = $decoded.TrimStart()
  $rootKind = if ($trimmed.StartsWith("[")) {
    "array"
  } elseif ($trimmed.StartsWith("{")) {
    "object"
  } else {
    "unknown"
  }

  [pscustomobject]@{
    Encoded = $value
    Decoded = $decoded
    Parsed = $parsed
    RootKind = $rootKind
  }
}

function Get-ProfilesArray {
  param([Parameter(Mandatory = $true)] $Secret)

  if ($Secret.RootKind -eq "array") {
    return @($Secret.Parsed)
  }

  return @($Secret.Parsed)
}

function Show-ProfileSummary {
  param([Parameter(Mandatory = $true)] $Secret)

  $profiles = Get-ProfilesArray $Secret
  $profiles | ForEach-Object {
    [pscustomobject]@{
      name = $_.name
      webhookPath = $_.webhookPath
      enabledFunctions = if ($_.enabledFunctions) { ($_.enabledFunctions -join ",") } else { "" }
      smallTalkMode = $_.smallTalk.mode
      smallTalkMaxChars = $_.smallTalk.maxChars
      personaPromptConfigured = [bool] $_.smallTalk.personaPrompt
      generalAgentEnabled = $_.generalAgent.enabled
      conversationWindowSeconds = $_.generalAgent.conversationWindowSeconds
      registrationEnabled = $_.registration.enabled
    }
  } | Format-Table -AutoSize
}

function Assert-ArrayRoot {
  param([Parameter(Mandatory = $true)] $Secret)

  if ($Secret.RootKind -ne "array") {
    throw "Decoded '$SecretName' root is '$($Secret.RootKind)', expected 'array'. Run Action repair-array-root with -Apply if this is a single profile object."
  }
}

function Set-ProfileSecretJson {
  param([Parameter(Mandatory = $true)][string] $Json)

  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json))
  & az containerapp secret set `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --secrets "$SecretName=$encoded" `
    --output none

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update secret '$SecretName'."
  }

  $verified = Get-ProfileSecret
  Assert-ArrayRoot $verified
}

function Update-ProfileConfigVersion {
  $version = "profiles-$(Get-Date -Format 'yyyyMMddHHmmss')"
  & az containerapp update `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --set-env-vars "$ProfileConfigVersionName=$version" `
    --query "{latestRevision:properties.latestRevisionName,image:properties.template.containers[0].image}" `
    -o json

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to bump $ProfileConfigVersionName."
  }
}

switch ($Action) {
  "check" {
    $secret = Get-ProfileSecret
    Assert-ArrayRoot $secret
    Write-Output "OK: '$SecretName' decodes to a JSON array."
    Show-ProfileSummary $secret
  }
  "summary" {
    $secret = Get-ProfileSecret
    Write-Output "Root kind: $($secret.RootKind)"
    Show-ProfileSummary $secret
  }
  "repair-array-root" {
    $secret = Get-ProfileSecret
    if ($secret.RootKind -eq "array") {
      Write-Output "OK: '$SecretName' is already a JSON array. No repair needed."
      Show-ProfileSummary $secret
      break
    }

    if ($secret.RootKind -ne "object") {
      throw "Cannot repair root kind '$($secret.RootKind)'. Expected a single JSON object."
    }

    $profiles = @($secret.Parsed)
    $json = ConvertTo-Json -InputObject $profiles -Depth 100 -Compress
    $check = $json.TrimStart()
    if (-not $check.StartsWith("[")) {
      throw "Internal error: repair JSON is not an array."
    }

    if (-not $Apply) {
      Write-Output "DRY RUN: '$SecretName' can be repaired by wrapping the single object in an array. Re-run with -Apply to write it."
      Show-ProfileSummary $secret
      break
    }

    Set-ProfileSecretJson $json
    Write-Output "OK: repaired '$SecretName' to JSON array root."
    if ($BumpConfigVersion) {
      Update-ProfileConfigVersion
    }
  }
  "bump-config-version" {
    $secret = Get-ProfileSecret
    Assert-ArrayRoot $secret
    Update-ProfileConfigVersion
  }
}
