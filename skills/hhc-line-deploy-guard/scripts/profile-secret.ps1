param(
  [ValidateSet("check", "summary", "check-production-safe", "migrate-inline-credentials", "repair-array-root", "bump-config-version")]
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
      channelSecret = Get-ProfileValueMode $_ "channelSecret" "channelSecretEnv"
      channelAccessToken = Get-ProfileValueMode $_ "channelAccessToken" "channelAccessTokenEnv"
      adminUserId = Get-ProfileValueMode $_ "adminUserId" "adminUserIdEnv"
      enabledFunctions = if ($_.enabledFunctions) { ($_.enabledFunctions -join ",") } else { "" }
      smallTalkMode = $_.smallTalk.mode
      smallTalkMaxChars = $_.smallTalk.maxChars
      promptingConfigured = [bool] $_.smallTalk.prompting
      generalAgentEnabled = $_.generalAgent.enabled
      conversationWindowSeconds = $_.generalAgent.conversationWindowSeconds
      registrationEnabled = $_.registration.enabled
    }
  } | Format-Table -AutoSize
}

function Test-HasProperty {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)][string] $Name
  )

  return $null -ne $Object.PSObject.Properties[$Name]
}

function Get-ProfileValueMode {
  param(
    [Parameter(Mandatory = $true)] $Profile,
    [Parameter(Mandatory = $true)][string] $DirectName,
    [Parameter(Mandatory = $true)][string] $EnvName
  )

  if (Test-HasProperty $Profile $EnvName) {
    return "env:$($Profile.$EnvName)"
  }
  if (Test-HasProperty $Profile $DirectName) {
    return "direct"
  }
  return "missing"
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

function Convert-ToEnvProfileName {
  param([Parameter(Mandatory = $true)][string] $Name)

  return ($Name.ToUpperInvariant() -replace "[^A-Z0-9]", "_")
}

function Convert-ToSecretProfileName {
  param([Parameter(Mandatory = $true)][string] $Name)

  return ($Name.ToLowerInvariant() -replace "[^a-z0-9]", "-")
}

function Set-ContainerSecretValue {
  param(
    [Parameter(Mandatory = $true)][string] $Name,
    [Parameter(Mandatory = $true)][string] $Value
  )

  & az containerapp secret set `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --secrets "$Name=$Value" `
    --output none

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set ACA secret '$Name'."
  }
}

function Set-ContainerEnvRefs {
  param([Parameter(Mandatory = $true)][string[]] $EnvRefs)

  if ($EnvRefs.Count -eq 0) {
    return
  }

  & az containerapp update `
    --resource-group $ResourceGroup `
    --name $ContainerAppName `
    --set-env-vars @EnvRefs `
    --output none

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update ACA environment variable references."
  }
}

function Set-ProfileEnvReference {
  param(
    [Parameter(Mandatory = $true)] $Profile,
    [Parameter(Mandatory = $true)][string] $DirectName,
    [Parameter(Mandatory = $true)][string] $EnvRefName,
    [Parameter(Mandatory = $true)][string] $EnvVarName,
    [Parameter(Mandatory = $true)][string] $SecretName,
    [System.Collections.Generic.List[string]] $EnvRefs,
    [System.Collections.Generic.List[string]] $Operations
  )

  if (-not (Test-HasProperty $Profile $DirectName)) {
    return
  }

  $value = [string] $Profile.$DirectName
  if ([string]::IsNullOrWhiteSpace($value)) {
    return
  }

  if ($Apply) {
    Set-ContainerSecretValue -Name $SecretName -Value $value
  }

  $EnvRefs.Add("$EnvVarName=secretref:$SecretName")
  if (Test-HasProperty $Profile $EnvRefName) {
    $Profile.$EnvRefName = $EnvVarName
  } else {
    $Profile | Add-Member -NotePropertyName $EnvRefName -NotePropertyValue $EnvVarName
  }
  $Profile.PSObject.Properties.Remove($DirectName)
  $Operations.Add("Profile '$($Profile.name)': moved '$DirectName' to env '$EnvVarName' backed by ACA secret '$SecretName'.")
}

function Convert-InlineCredentialsToEnvRefs {
  param([Parameter(Mandatory = $true)] $Secret)

  Assert-ArrayRoot $Secret
  $profiles = Get-ProfilesArray $Secret
  $envRefs = New-Object System.Collections.Generic.List[string]
  $operations = New-Object System.Collections.Generic.List[string]

  foreach ($profile in $profiles) {
    $envProfile = Convert-ToEnvProfileName $profile.name
    $secretProfile = Convert-ToSecretProfileName $profile.name
    Set-ProfileEnvReference `
      -Profile $profile `
      -DirectName "channelSecret" `
      -EnvRefName "channelSecretEnv" `
      -EnvVarName "LINE_$($envProfile)_CHANNEL_SECRET" `
      -SecretName "line-$($secretProfile)-channel-secret" `
      -EnvRefs $envRefs `
      -Operations $operations
    Set-ProfileEnvReference `
      -Profile $profile `
      -DirectName "channelAccessToken" `
      -EnvRefName "channelAccessTokenEnv" `
      -EnvVarName "LINE_$($envProfile)_CHANNEL_ACCESS_TOKEN" `
      -SecretName "line-$($secretProfile)-channel-access-token" `
      -EnvRefs $envRefs `
      -Operations $operations
    Set-ProfileEnvReference `
      -Profile $profile `
      -DirectName "adminUserId" `
      -EnvRefName "adminUserIdEnv" `
      -EnvVarName "LINE_$($envProfile)_ADMIN_USER_ID" `
      -SecretName "line-$($secretProfile)-admin-user-id" `
      -EnvRefs $envRefs `
      -Operations $operations
  }

  if ($operations.Count -eq 0) {
    Write-Output "OK: no inline profile credentials found."
    return
  }

  if (-not $Apply) {
    Write-Output "DRY RUN: inline credentials can be migrated. Re-run with -Apply to write ACA secrets, env refs, and profile JSON."
    $operations | ForEach-Object { Write-Output $_ }
    return
  }

  Set-ContainerEnvRefs -EnvRefs ([string[]] $envRefs.ToArray())
  $json = ConvertTo-Json -InputObject $profiles -Depth 100 -Compress
  $check = $json.TrimStart()
  if (-not $check.StartsWith("[")) {
    throw "Internal error: migrated JSON is not an array."
  }
  Set-ProfileSecretJson $json
  Write-Output "OK: migrated inline credentials to env references."
  $operations | ForEach-Object { Write-Output $_ }
}

function Get-ContainerEnvNames {
  $app = Invoke-AzJson -Arguments @(
    "containerapp", "show",
    "--resource-group", $ResourceGroup,
    "--name", $ContainerAppName
  )
  $envItems = @($app.properties.template.containers[0].env)
  return @($envItems | ForEach-Object { $_.name } | Where-Object { $_ })
}

function Assert-ProductionSafeProfiles {
  param([Parameter(Mandatory = $true)] $Secret)

  Assert-ArrayRoot $Secret
  $profiles = Get-ProfilesArray $Secret
  $containerEnvNames = @(Get-ContainerEnvNames)
  $errors = New-Object System.Collections.Generic.List[string]

  foreach ($profile in $profiles) {
    foreach ($name in @("channelSecret", "channelAccessToken", "adminUserId")) {
      if (Test-HasProperty $profile $name) {
        $errors.Add("Profile '$($profile.name)' contains inline '$name'; use '$($name)Env' for production.")
      }
    }

    foreach ($name in @("channelSecretEnv", "channelAccessTokenEnv")) {
      if (-not (Test-HasProperty $profile $name)) {
        $errors.Add("Profile '$($profile.name)' is missing required production env reference '$name'.")
        continue
      }
      $envRef = [string] $profile.$name
      if (-not $containerEnvNames.Contains($envRef)) {
        $errors.Add("Profile '$($profile.name)' references '$envRef', but the container environment does not define it.")
      }
    }

    if (Test-HasProperty $profile "adminUserIdEnv") {
      $adminEnvRef = [string] $profile.adminUserIdEnv
      if (-not $containerEnvNames.Contains($adminEnvRef)) {
        $errors.Add("Profile '$($profile.name)' references '$adminEnvRef', but the container environment does not define it.")
      }
    }
  }

  if ($errors.Count -gt 0) {
    throw ($errors -join "`n")
  }
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
  "check-production-safe" {
    $secret = Get-ProfileSecret
    Assert-ProductionSafeProfiles $secret
    Write-Output "OK: '$SecretName' is production-safe and uses environment references for LINE credentials."
    Show-ProfileSummary $secret
  }
  "migrate-inline-credentials" {
    $secret = Get-ProfileSecret
    Convert-InlineCredentialsToEnvRefs $secret
    if ($Apply -and $BumpConfigVersion) {
      Update-ProfileConfigVersion
    }
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
