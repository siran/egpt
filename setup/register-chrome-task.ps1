# register-chrome-task.ps1 — register the `egpt-chrome` scheduled task so the Session-0
# spine can LAUNCH Chrome on the operator's Session-1 desktop via `schtasks /run /tn egpt-chrome`.
#
# WHY A SCHEDULED TASK (and not a direct spawn from the spine): the egpt spine runs as a
# Windows SERVICE in Session 0; a Chrome it spawned directly would inherit Session 0 and render
# on that session's isolated, invisible desktop. A task registered with **LogonType Interactive**
# runs in the operator's interactive session (Session 1), so the browser is actually visible.
# The Session-0 spine fires it on demand with `schtasks /run /tn egpt-chrome`. This is the exact
# pattern the egpt-lock-on-logon task uses (rundll32 LockWorkStation, Interactive, fired from
# Session 0). See src/spine/commands.mjs (the /chrome dispatch) for the caller side.
#
# GOTCHAS (learned the hard way — ROADMAP 2026-07-15):
#   - `schtasks /create /it /sc onlogon` emits INVALID task XML — DO NOT author the task with
#     schtasks /create. Use the PowerShell ScheduledTasks cmdlets (below).
#   - The principal user MUST be fully qualified `<COMPUTER>\<user>` — a bare `<user>` is
#     rejected as malformed XML.
#
# Idempotent: re-run to update (Register-ScheduledTask -Force). No trigger — this task only
# ever runs on demand via `schtasks /run`, so Chrome is NOT auto-launched at logon.
#
# Run from THIS repo checkout, as the operator (the same user the service runs as, so the
# profile + login match). No elevation needed to register a task that runs as yourself.
#   powershell -ExecutionPolicy Bypass -File .\setup\register-chrome-task.ps1
#   # a second, isolated node on profile ~/.egpt2:
#   powershell -ExecutionPolicy Bypass -File .\setup\register-chrome-task.ps1 -EgptHome "$env:USERPROFILE\.egpt2"

param(
  [string]$EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [int]$Port        = 9221,                 # the --remote-debugging-port /chrome attaches to (cdpHost default)
  [string]$TaskName = 'egpt-chrome'         # must match CHROME_LAUNCH_TASK in src/spine/commands.mjs
)

$ErrorActionPreference = 'Stop'

# --- locate Chrome exactly like src/tools/chrome-launcher.mjs (findChromeExecutable, win32) ---
$chromeCandidates = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "Chrome not found in standard locations: $($chromeCandidates -join ', ')" }

# --- resolve the brain profile from the SAME source of truth /chrome uses: chrome-launcher's
#     resolveBrainProfile() searches the v2 default + the operator's v1 browser profiles and
#     returns the one actually logged in to an AI site. Shell out to node so this task and the
#     spine pick the IDENTICAL directory. If node fails or prints nothing, fall back to the
#     v2 default path (Chrome creates it fresh on launch). ---
$repoRoot    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcherUrl = "file:///$($repoRoot -replace '\\','/')/src/tools/chrome-launcher.mjs"
$env:EGPT_HOME = $EgptHome
$userDataDir = (& node -e "import('$launcherUrl').then(m=>process.stdout.write(m.resolveBrainProfile()))")
if ($userDataDir) { $userDataDir = $userDataDir.Trim() }
if (-not $userDataDir) {
  Write-Warning "resolveBrainProfile via node returned empty; falling back to the v2 default profile."
  $userDataDir = Join-Path $EgptHome 'chrome\profiles\brain'
}

# --- the CDP flag set — MIRRORS chromeArgs() in src/tools/chrome-launcher.mjs (the source of
#     truth for a real spawn). One deliberate exception: the browser extension is backburnered,
#     so this launch drops --load-extension AND the DisableLoadExtensionCommandLineSwitch
#     feature-disable that only matters when an extension is loaded. ---
$chromeArgs = @(
  "--remote-debugging-port=$Port"
  '--remote-allow-origins=*'
  "--user-data-dir=$userDataDir"
  '--no-first-run'
  '--disable-features=ChromeWhatsNewUI'
  '--silent-debugger-extension-api'
  '--disable-backgrounding-occluded-windows'
  '--disable-background-timer-throttling'
  '--disable-renderer-backgrounding'
  '--new-window'
  'about:blank'
)

# --- author the task via cmdlets (NEVER schtasks /create — invalid XML, see header) ---
$action = New-ScheduledTaskAction -Execute $chrome -Argument ($chromeArgs -join ' ')
# fully-qualified <COMPUTER>\<user> — a bare user is rejected as malformed XML
$userId    = "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
# ExecutionTimeLimit = PT0S disables the 3-day kill so Chrome isn't reaped out from under the node.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName':" -ForegroundColor Green
Write-Host "  runs as   : $userId  (LogonType Interactive -> Session 1 desktop)"
Write-Host "  execute   : $chrome"
Write-Host "  arguments : $($chromeArgs -join ' ')"
Write-Host "  profile   : $EgptHome"
Write-Host ""
Write-Host "The Session-0 spine launches it on demand with:  schtasks /run /tn $TaskName"
