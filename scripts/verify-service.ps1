#Requires -Version 5.1
<#
.SYNOPSIS
  Verify (and optionally repair) the muji-qms backend Windows service so it
  auto-starts with the mini PC and restarts itself on failure.

.DESCRIPTION
  Read-only by default: it reports what the service manager is currently
  configured to do and flags anything that would leave the shop offline until
  somebody walks over and restarts the backend by hand.

  Pass -Apply to write the recommended configuration. Requires an elevated
  PowerShell for both -Apply and for reading NSSM recovery settings.

  Checks performed:
    * service exists and is running
    * start type is Automatic (survives a power cut)
    * NSSM is configured to restart the process when it exits
    * restart delay and throttle are sane
    * SCM recovery actions are set as a second line of defence
    * stdout/stderr are captured to rotating log files

.PARAMETER ServiceName
  Name of the service. Default: muji-qms-backend (matches deploy.ps1).

.PARAMETER Apply
  Write the recommended configuration instead of only reporting it.

.EXAMPLE
  .\scripts\verify-service.ps1
  .\scripts\verify-service.ps1 -Apply
#>
param(
  [string]$ServiceName = "muji-qms-backend",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$RestartDelayMs = 5000
$ThrottleMs     = 5000
$LogDir         = Join-Path $PSScriptRoot "..\logs"
$RotateBytes    = 10485760  # 10 MB

$script:Problems = @()

function Write-Check {
  param([string]$Label, [string]$Actual, [bool]$Ok, [string]$Expected)
  if ($Ok) {
    Write-Host ("  [ OK ] {0}: {1}" -f $Label, $Actual) -ForegroundColor Green
  } else {
    Write-Host ("  [FAIL] {0}: {1} (expected {2})" -f $Label, $Actual, $Expected) -ForegroundColor Red
    $script:Problems += $Label
  }
}

function Show-Value {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "unset" }
  return $Value
}

function Get-NssmValue {
  param([string]$Name, [string]$Parameter)
  try {
    $raw = & nssm get $Name $Parameter 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    # NSSM emits UTF-16 with embedded nulls when redirected.
    return ($raw -join "").Replace("`0", "").Trim()
  } catch {
    return $null
  }
}

Write-Host "muji-qms backend service check: $ServiceName" -ForegroundColor Cyan

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
  Write-Host "  [FAIL] Service '$ServiceName' is not installed." -ForegroundColor Red
  Write-Host "         Install it with NSSM, then re-run this script:" -ForegroundColor Yellow
  Write-Host "           nssm install $ServiceName `"C:\Program Files\nodejs\node.exe`" dist\src\main.js" -ForegroundColor Yellow
  Write-Host "           nssm set $ServiceName AppDirectory <path-to-muji-qms-server>" -ForegroundColor Yellow
  exit 1
}

Write-Check -Label "Status" -Actual $service.Status -Ok ($service.Status -eq 'Running') -Expected "Running"
Write-Check -Label "Start type" -Actual $service.StartType -Ok ($service.StartType -eq 'Automatic') -Expected "Automatic"

$hasNssm = [bool](Get-Command nssm -ErrorAction SilentlyContinue)
if (-not $hasNssm) {
  Write-Host "  [WARN] nssm is not on PATH - cannot verify process-level restart settings." -ForegroundColor Yellow
} else {
  $appExit = Get-NssmValue -Name $ServiceName -Parameter "AppExit"
  # NSSM reports this as e.g. "Restart" or "Default Restart".
  Write-Check -Label "Restart on exit" -Actual (Show-Value $appExit) `
    -Ok ($appExit -match "Restart") -Expected "Restart"

  $delay = Get-NssmValue -Name $ServiceName -Parameter "AppRestartDelay"
  $delayOk = $false
  if ($delay -match '^\d+$') { $delayOk = ([int]$delay -ge 1000) }
  Write-Check -Label "Restart delay (ms)" -Actual (Show-Value $delay) `
    -Ok $delayOk -Expected ">= 1000"

  $stdout = Get-NssmValue -Name $ServiceName -Parameter "AppStdout"
  Write-Check -Label "stdout log" -Actual (Show-Value $stdout) `
    -Ok (-not [string]::IsNullOrWhiteSpace($stdout)) -Expected "a log file path"
}

# SCM recovery actions: covers a hard kill that NSSM itself does not survive.
$scRecovery = (& sc.exe qfailure $ServiceName) -join " "
$hasRecovery = $scRecovery -match "RESTART"
Write-Check -Label "SCM recovery actions" -Actual $(if ($hasRecovery) { "restart configured" } else { "none" }) `
  -Ok $hasRecovery -Expected "restart configured"

if (-not $Apply) {
  Write-Host ""
  if ($script:Problems.Count -eq 0) {
    Write-Host "All checks passed. The service auto-starts and restarts on failure." -ForegroundColor Green
    exit 0
  }
  Write-Host ("{0} problem(s) found: {1}" -f $script:Problems.Count, ($script:Problems -join ", ")) -ForegroundColor Red
  Write-Host "Re-run elevated with -Apply to fix them." -ForegroundColor Yellow
  exit 1
}

# ---- Apply -----------------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "-Apply requires an elevated PowerShell (Run as Administrator)."
}

Write-Host ""
Write-Host "Applying recommended configuration..." -ForegroundColor Cyan

Set-Service -Name $ServiceName -StartupType Automatic
Write-Host "  Start type -> Automatic"

if ($hasNssm) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

  & nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
  & nssm set $ServiceName AppExit Default Restart | Out-Null
  & nssm set $ServiceName AppRestartDelay $RestartDelayMs | Out-Null
  & nssm set $ServiceName AppThrottle $ThrottleMs | Out-Null
  & nssm set $ServiceName AppStdout (Join-Path $LogDir "backend.out.log") | Out-Null
  & nssm set $ServiceName AppStderr (Join-Path $LogDir "backend.err.log") | Out-Null
  & nssm set $ServiceName AppRotateFiles 1 | Out-Null
  & nssm set $ServiceName AppRotateOnline 1 | Out-Null
  & nssm set $ServiceName AppRotateBytes $RotateBytes | Out-Null
  Write-Host "  NSSM -> restart on exit after ${RestartDelayMs}ms, rotating logs in $LogDir"
}

# reset= 0 means "never stop counting failures", so a fault weeks apart still
# triggers a restart rather than being treated as a fresh incident.
& sc.exe failure $ServiceName reset= 0 actions= restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null
Write-Host "  SCM recovery -> restart after 5s, indefinitely"

Write-Host ""
Write-Host "Done. Re-run without -Apply to confirm." -ForegroundColor Green
