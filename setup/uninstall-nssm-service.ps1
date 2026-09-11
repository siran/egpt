# uninstall-nssm-service.ps1 - remove one egpt v2 node's NSSM service.
#
# Removes only the named service (default 'egpt-daemon'). Never kills stray
# node.exe and never touches other nodes - independent profiles are independent.
# No egpt code, config, or auth state is touched; service logs are preserved.
#
# Self-elevates (approve the UAC prompt); output is echoed back to the calling shell:
#   powershell -ExecutionPolicy Bypass -File .\setup\uninstall-nssm-service.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\uninstall-nssm-service.ps1 -ServiceName egpt2-daemon

# NO DEFAULT (2026-09-11). It used to default to 'egpt-daemon' -- the PRIMARY node's
# service. A caller who passed a wrong or unrecognised switch (e.g. -EgptHome, which this
# script does not take) therefore removed the primary daemon instead of failing. A
# destructive script must name its target explicitly.
# -LogPath is passed to the ELEVATED CHILD explicitly. It must not be defaulted on both sides:
# an elevated process gets a DIFFERENT %TEMP% than an MSYS shell (C:\msys64	mp here), so parent
# and child each computed their own path, the child wrote one file and the parent read another,
# and the parent reported 'left no log' on a run that had actually succeeded.
param(
  [Parameter(Mandatory = $true)][string]$ServiceName,
  [string]$LogPath = (Join-Path $env:TEMP 'egpt-uninstall-service.log')
)

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated -----------------------------------------------------------------------
# SELF-ELEVATES rather than refusing (operator 2026-09-11), matching install-nssm-service.ps1.
# Refusing made this a two-step dance from an ordinary shell, and the retype is where the
# mistakes happen: an MSYS/git-bash prompt eats backslashes out of a Windows path.
#
# AND IT TRANSCRIBES. The elevated child gets its OWN console, which CLOSES the instant the
# script ends -- on 2026-09-11 an install died on a locked file and the operator saw nothing at
# all, because the window carrying the error was already gone. So the child logs to a file and
# the parent prints it. -Wait is required or the parent returns before the child has run.
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated - relaunching as administrator (approve the UAC prompt)..." -ForegroundColor Yellow
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSCommandPath + '"'))
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $a += "-$($kv.Key)" } }
    else { $a += @("-$($kv.Key)", ('"' + $kv.Value + '"')) }
  }
  if (-not $PSBoundParameters.ContainsKey('LogPath')) { $a += @('-LogPath', ('"' + $LogPath + '"')) }
  try { Start-Process powershell -Verb RunAs -ArgumentList $a -Wait }
  catch { Write-Host "Elevation was refused or cancelled." -ForegroundColor Red; exit 1 }
  if (Test-Path -LiteralPath $LogPath) { Write-Host ''; Get-Content -LiteralPath $LogPath }
  else { Write-Host "The elevated run left no log at $LogPath - it may have failed before starting." -ForegroundColor Red; exit 1 }
  exit 0
}
try { Start-Transcript -LiteralPath $LogPath -Force | Out-Null } catch { }

# --- 2. stop + remove the service if present ---
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -eq 'Running') {
    Write-Host "Stopping $ServiceName..." -ForegroundColor Yellow
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if ($nssm) {
    Write-Host "Removing $ServiceName via NSSM..." -ForegroundColor Yellow
    & $nssm remove $ServiceName confirm | Out-Null
  } else {
    Write-Host "NSSM not on PATH - falling back to sc.exe delete..." -ForegroundColor Yellow
    sc.exe delete $ServiceName | Out-Null
  }
  Write-Host "Removed $ServiceName." -ForegroundColor Green
} else {
  Write-Host "No $ServiceName service present." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Done. The node's spine stopped with the service; its profile (config/conversations/state) is untouched." -ForegroundColor Green
Write-Host "Verify:  Get-Service $ServiceName -ErrorAction SilentlyContinue   # should be empty"

try { Stop-Transcript | Out-Null } catch { }
