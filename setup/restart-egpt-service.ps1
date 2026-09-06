# restart-egpt-service.ps1 - canonical clean restart for an egpt NSSM node
# service. Run ELEVATED (the service tree lives in session 0) - it self-elevates
# if you forget.
#
# WHY NOT plain Restart-Service: NSSM's graceful stop can hang while the
# bridge holds its WebSocket (handoff 2026-06-07), and a taskkill of the
# app tree alone has been observed to leave NSSM wedged appless-but-
# "Running" (it logged 'service is stopping' kills, then never restarted
# the app). This script stops bounded, kills whatever's left, starts
# fresh, and reports.
#
# ONE MACHINE, SEVERAL NODES: a node is one profile, selected by EGPT_HOME in the
# service environment. Every node runs the IDENTICAL command line - node
# <checkout>\bin\egpt\egpt-daemon.mjs, same Application, same AppDirectory - so
# NOTHING on the command line tells two nodes apart, and a command-line match
# hits every node on the box. -ServiceName picks the one to restart; the sweep
# scope and the transcript path are both derived from it.
#
#   .\setup\restart-egpt-service.ps1                            # egpt-daemon  (~/.egpt)
#   .\setup\restart-egpt-service.ps1 -ServiceName egpt2-daemon  # egpt2-daemon (~/.egpt2)
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
param(
  [string] $ServiceName = 'egpt-daemon'
)
$ErrorActionPreference = 'Continue'

# Self-elevate, same shape as setup/rename-beeper-s0-service.ps1. Done BEFORE the
# transcript so the unelevated parent does not truncate the elevated child's log.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $a += "-$($kv.Key)" } }
    else { $a += @("-$($kv.Key)", "`"$($kv.Value)`"") }
  }
  Write-Host "elevating..."
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
  Write-Host "no such service: $ServiceName"
  exit 1
}

# Every pid in the tree rooted at $root, $root included. Parent links are read
# from a single Win32_Process snapshot, so a dead intermediate parent still
# reports its (dead) pid and its orphans still chain back to the root.
function Get-TreePids([int] $root) {
  if ($root -le 0) { return @() }
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $acc = @($root)
  $frontier = @($root)
  while ($frontier.Count -gt 0) {
    $kids = @($all | Where-Object { $frontier -contains [int]$_.ParentProcessId } |
                     ForEach-Object { [int]$_.ProcessId } |
                     Where-Object { $acc -notcontains $_ })
    $acc += $kids
    $frontier = $kids
  }
  return $acc
}

# Transcript goes under THIS node's profile: elevated windows close with their
# output, and restarting egpt2 must not write into egpt's logs. NSSM keeps the
# service environment in ...\<name>\Parameters\AppEnvironmentExtra (REG_MULTI_SZ
# of NAME=VALUE). AppDirectory is NOT a usable fallback - it is the shared
# checkout, identical for every node - so fall back to the historical ~/.egpt.
$egptHome = $null
try {
  $par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters" -ErrorAction Stop
  foreach ($e in @($par.AppEnvironmentExtra)) {
    if ($e -match '^\s*EGPT_HOME\s*=\s*(.+?)\s*$') { $egptHome = $Matches[1] }
  }
} catch {}
if (-not $egptHome) { $egptHome = Join-Path $env:USERPROFILE '.egpt' }
$logDir = Join-Path $egptHome 'logs'
try {
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  Start-Transcript -Path (Join-Path $logDir 'restart-elevated.log') -Force | Out-Null
} catch {}
Write-Host "target: service=$ServiceName EGPT_HOME=$egptHome"

# SCOPE THE SWEEP BY PROCESS TREE, captured now, while the service is still up
# and the parent links still exist. The old sweep matched node.exe command lines
# against 'egpt(-daemon)?.mjs', which is the SAME string for every node on this
# machine, so restarting one node killed the others and took their accounts off
# the air. The tree is exact and needs no unsafe machinery; the alternative
# (reading EGPT_HOME out of each node's environment block) has no WMI property
# behind it and would need NtQueryInformationProcess/ReadProcessMemory P/Invoke
# against PEB offsets. If there is no tree to capture we sweep NOTHING.
$wrapperPid = 0
$wsvc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if ($wsvc) { $wrapperPid = [int]$wsvc.ProcessId }
$treePids = Get-TreePids $wrapperPid

Write-Host "stopping $ServiceName..."
sc.exe stop $ServiceName | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 10) {
  if ((Get-Service $ServiceName).Status -eq 'Stopped') { break }
  Start-Sleep -Milliseconds 500
}
if ((Get-Service $ServiceName).Status -ne 'Stopped') {
  Write-Host "stop hung after 10s - killing wrapper + node tree"
  # BY PID, never by image name: the wrapper image is not unique per node (this
  # box runs one node under nssm.exe and another under a renamed copy of it,
  # egpt-service.exe), so the old /IM egpt-service.exe could kill a DIFFERENT
  # node's wrapper than the one being restarted.
  if ($wrapperPid -gt 0) { taskkill /F /T /PID $wrapperPid 2>$null | Out-Null }
  else { Write-Host "  no wrapper pid known - not killing by image name" }
  Start-Sleep -Seconds 2
}

# Orphaned node children survive a wrapper kill - sweep the survivors of THIS
# service's tree so a stale bridge cannot hold the WA session against the fresh
# one. Also take a live node whose parent is in the tree: it was spawned between
# the snapshot and the kill, so it belongs to this node too.
$swept = 'tree'
if ($treePids.Count -gt 0) {
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
    if (($treePids -contains [int]$p.ProcessId) -or ($treePids -contains [int]$p.ParentProcessId)) {
      Write-Host ("killing orphan node pid {0}" -f $p.ProcessId)
      taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null
    }
  }
} else {
  # No wrapper pid: the service was already stopped when this started, so there
  # is no tree and no node.exe can be attributed to this node. Do NOT guess -
  # the only other discriminator available here is the command line, which every
  # node shares, and a wrong kill takes another account off the air.
  $swept = 'SKIPPED'
  $susp = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $_.CommandLine -match 'egpt(-daemon)?\.mjs' })
  $suspPids = ($susp | ForEach-Object { $_.ProcessId }) -join ','
  Write-Host ""
  Write-Host "*** ORPHANS NOT SWEPT ***" -ForegroundColor Yellow
  Write-Host "*** $ServiceName had no running process when this script started, so its" -ForegroundColor Yellow
  Write-Host "*** tree could not be captured and nothing can be attributed to it safely." -ForegroundColor Yellow
  Write-Host "*** Suspicious node pids (ANY egpt node, possibly another account - check" -ForegroundColor Yellow
  Write-Host "*** before killing any of them): $suspPids" -ForegroundColor Yellow
  Write-Host ""
}

Start-Sleep -Seconds 2
Write-Host "starting $ServiceName..."
sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
$newPid = 0
$nsvc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if ($nsvc) { $newPid = [int]$nsvc.ProcessId }
# Count only node.exe in the tree: the tree also holds the wrapper and any
# conhost/shell it spawned, and calling those "node-procs" misreads as a spine
# that came up fatter than it did.
$treeNow = Get-TreePids $newPid
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
           Where-Object { $treeNow -contains [int]$_.ProcessId } |
           ForEach-Object { [int]$_.ProcessId })
Write-Host ("{0}: service={1} node-procs={2} pids={3} sweep={4}" -f $ServiceName, $svc.Status, $nodes.Count, ($nodes -join ','), $swept)
try { Stop-Transcript | Out-Null } catch {}
