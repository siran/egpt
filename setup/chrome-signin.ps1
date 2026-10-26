# chrome-signin.ps1 - open an eGPT browser profile in a PLAIN Chrome window (no automation flags), so a
# site that refuses eGPT's automated Chrome (Google sign-in, a captcha) lets you through. eGPT's Chrome on
# that profile is closed first and reuses the session the next time it opens. You sign in or pass the
# check yourself, then close the window. While the node runs, prefer the chat command
# /<handle> browser refresh [url] (MANUAL.md): it also keeps eGPT off the profile until you close it.
# Usage: chrome-signin.cmd [profile] [url]   (default: brain, Google sign-in)
#   e.g. chrome-signin.cmd brain https://iapps.courts.state.ny.us/nyscef/Login
param([string]$ProfileName = 'brain', [string]$Url = 'https://accounts.google.com/')
$egptHome = if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }
$root = Join-Path $egptHome 'chrome\profiles'
$dir = Join-Path $root $ProfileName
if (-not (Test-Path $dir)) {
  Write-Host "No profile '$ProfileName'. Available:" (Get-ChildItem $root -Directory | ForEach-Object Name)
  exit 1
}
$chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host 'Chrome not found in the standard locations.'; exit 1 }
# This profile's processes only: 'brain' must not match 'brain2'.
$mine = '--user-data-dir="?' + [regex]::Escape($dir) + '("|\s|$)'
$held = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match $mine }
if ($held) {
  Write-Host "egpt's Chrome is using profile '$ProfileName' - closing it (egpt reopens it when a being needs it)."
  $held | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}
Start-Process $chrome -ArgumentList "--user-data-dir=`"$dir`"", '--no-first-run', $Url
Write-Host ""
Write-Host "1. Sign in (and solve any captcha yourself) in the window that just opened."
Write-Host "2. Then CLOSE that Chrome window completely."
Write-Host "egpt's Chrome for '$ProfileName' will use that login next time it opens."
