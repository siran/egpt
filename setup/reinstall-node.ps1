# reinstall-node.ps1 — clean reinstall of an eGPT node (e.g. DOLLY).
#
# Moves the existing checkout + ~/.egpt ASIDE (never deletes), re-clones, installs,
# scaffolds a minimal config, and registers the daemon service. Read it before running.
#
# Run ON the node, in an ELEVATED PowerShell (the service steps need admin).
# Transcription is currently handled by REVE, so this brings the node back as a plain
# spine — no transcriptor/whisper config. Add the worker later with setup\install-worker.cmd.
#
# Nothing here is destructive: the old node lives at <path>.old-<stamp> until you delete it.

param(
  [string]$Repo  = 'git@github.com:siran/egpt.git',
  [string]$Src   = "$HOME\src\egpt",
  [string]$Egpt  = "$HOME\.egpt",
  [string]$Stamp = (Get-Date -Format 'yyyyMMdd-HHmmss'),
  [switch]$RestoreState   # also copy conversations / secrets / identities from the old node
)

$ErrorActionPreference = 'Stop'
Write-Host "== eGPT node reinstall ($Stamp) ==" -ForegroundColor Cyan

# [1/6] Stop + remove the current daemon service (no-op if absent).
Write-Host "`n[1/6] stop + uninstall the current service"
if (Test-Path "$Src\setup\uninstall-nssm-service.cmd") { & "$Src\setup\uninstall-nssm-service.cmd" }
else { Write-Host "  (no old checkout — skipping service uninstall)" }

# [2/6] Move the old checkout + node dir aside (kept for rollback / diffing).
Write-Host "`n[2/6] move old checkout + ~/.egpt aside"
if (Test-Path $Src)  { Move-Item $Src  "$Src.old-$Stamp";  Write-Host "  $Src  -> $Src.old-$Stamp" }
if (Test-Path $Egpt) { Move-Item $Egpt "$Egpt.old-$Stamp"; Write-Host "  $Egpt -> $Egpt.old-$Stamp" }

# [3/6] Fresh clone + install (native deps build here — must run on the node).
Write-Host "`n[3/6] clone + npm install"
git clone $Repo $Src
Push-Location $Src; npm install; Pop-Location

# [4/6] Scaffold a MINIMAL config — keep ONLY this node's identity, then boot and let
#       the log tell you what's missing (that's the point of a clean reinstall).
Write-Host "`n[4/6] scaffold config (identity only)"
New-Item -ItemType Directory "$Egpt\config" -Force | Out-Null
$oldCfg = "$Egpt.old-$Stamp\config\config.yaml"
if (Test-Path $oldCfg) {
  Write-Host "  old config preserved at: $oldCfg"
  Write-Host "  carry over by hand: node_name, beeper_token, allowed_users, chat_id"
  # Copy-Item $oldCfg "$Egpt\config\config.yaml"   # uncomment to start from the old config, then TRIM
}

# [5/6] Optionally restore state for continuity (-RestoreState). Omit for a truly clean node.
if ($RestoreState) {
  Write-Host "`n[5/6] restore state (conversations / secrets / identities)"
  foreach ($p in 'conversations.yaml','conversations','secrets','identities') {
    $from = "$Egpt.old-$Stamp\$p"
    if (Test-Path $from) { Copy-Item $from "$Egpt\$p" -Recurse; Write-Host "  restored $p" }
  }
} else { Write-Host "`n[5/6] state NOT restored (pass -RestoreState to copy it)" }

# [6/6] Install + start the daemon, then watch the boot.
Write-Host "`n[6/6] install service"
& "$Src\setup\install-nssm-service.cmd"
Write-Host "`nVerify:  Get-Content $Egpt\logs\egpt.log -Wait -Tail 20" -ForegroundColor Yellow
Write-Host "Want:    transport=beeper -> WS open -> subscribed to all chats" -ForegroundColor Yellow
Write-Host "`nDone. Old node at $Egpt.old-$Stamp (delete once happy)." -ForegroundColor Green
