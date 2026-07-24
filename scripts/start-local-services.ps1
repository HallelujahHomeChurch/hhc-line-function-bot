param(
  [int]$DockerWaitSeconds = 180
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeDir = Join-Path $repoRoot "infra\local-services"
$dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"

if (-not (docker info 2>$null)) {
  if (-not (Test-Path -LiteralPath $dockerDesktop)) {
    throw "Docker Desktop executable not found: $dockerDesktop"
  }
  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
}

$deadline = (Get-Date).AddSeconds($DockerWaitSeconds)
while ((Get-Date) -lt $deadline) {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}
if ($LASTEXITCODE -ne 0) {
  throw "Docker Engine did not become ready within $DockerWaitSeconds seconds"
}

docker compose --project-directory $composeDir up -d --remove-orphans
if ($LASTEXITCODE -ne 0) {
  throw "docker compose up failed"
}
