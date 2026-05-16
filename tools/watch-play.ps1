# tools/watch-play.ps1 — print play.md whenever it changes.
# Run in a terminal window during conversations:
#   powershell -NoProfile -File tools\watch-play.ps1
# Polls every 2s, redraws on change. Exit with Ctrl+C.

$path = Join-Path $env:USERPROFILE 'Documents\notes-markdown\projects\egpt\play.md'
$last = $null
while ($true) {
  $now = $null
  try { $now = Get-Content $path -Raw -ErrorAction Stop } catch {}
  if ($null -ne $now -and $now -ne $last) {
    Clear-Host
    Write-Host "=== play.md @ $(Get-Date -Format 'HH:mm:ss') ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host $now
    $last = $now
  }
  Start-Sleep -Seconds 2
}
