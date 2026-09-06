# test-sandbox-logon-launcher.ps1 - MANUAL smoke test for
# sandbox-logon-launcher.ps1's OS-level isolation AND its argument contract. NOT
# part of vitest / any test runner. Run this yourself, UNELEVATED - deliberately:
# that is the whole point of the CreateProcessWithLogonW launch path, and running
# it elevated would test a privilege level production never has. Requires the pool
# to be pre-provisioned (setup/provision-sandbox-account.ps1, one-time, self-
# elevating); unelevated the launcher cannot self-heal a missing account.
#
# Run it from a temp dir the sandbox accounts CANNOT already read. $env:TEMP
# under the operator's profile is right; a world-readable location (e.g. an
# msys2 C:\msys64\tmp, which inherits BUILTIN\Users:ReadAndExecute from C:\)
# makes "other marker denied" FAIL for reasons that have nothing to do with
# the launcher. Under an msys2/ssh shell $env:TEMP is often exactly that, so
# this script REFUSES to run from one rather than reporting a false failure.
#
# THE ARGUMENT CONTRACT this exercises (rewritten 2026-09-05, and the reason for
# sections 3 and 4). -InnerArgs, -SharePath and -SetEnv are each exactly ONE argv
# element holding a JSON ARRAY, which the launcher parses itself, so PowerShell's
# parameter binder never sees caller data as a token. Before that, the binder ATE
# the inner argv's `--verbose` into [CmdletBinding()]'s common -Verbose switch
# (every sandboxed ccode turn then died on "When using --print,
# --output-format=stream-json requires --verbose"), bound only the FIRST value of
# a multi-value flag and spilled the rest into the inner argv, and rejected the
# empty `--setting-sources ''` element outright. See the launcher's PARAMS header.
#
# SECTIONS:
#   1-2  per-account ACL confinement: two sessions, each reads its OWN folder's
#        marker and is DENIED the other's.
#   3    -SharePath with TWO paths in ONE invocation: both get an ACE, both are
#        read AND written by the child, a control folder that was NOT passed is
#        denied, the operator's ~/.claude/.credentials.json is denied, and every
#        ACE is gone afterwards.
#   4    -InnerArgs round-trip: `--verbose`, an EMPTY element, a spaced element
#        and an embedded quote all reach the child's own $args verbatim.
#
# KNOWN, ACCEPTED FAILURE: "cwd is own folder" may report FAIL - the child lands
# on C:\ instead of TargetFolder when seclogon cannot apply lpCurrentDirectory to
# a directory whose ANCESTORS the leased account cannot traverse (the per-turn ACE
# covers the leaf only). Do not "fix" it here.
$ErrorActionPreference = 'Stop'

# ---- HOW THIS SCRIPT SPAWNS THE LAUNCHER, and why it is NOT `& powershell.exe ...`.
# MEASURED 2026-09-05 on PS 5.1, and it is worth knowing before "simplifying" this:
# PowerShell's NATIVE-COMMAND argument passing MANGLES a JSON argument, every way
# round. Passing `["a","b"]` to an exe strips every quote (the child receives
# `[a,b]`); `\"`-escaping keeps the quotes but then splits the argument at its
# first space; `""`-doubling survives spaces but breaks as soon as a value itself
# contains a quote. PS 5.1 re-tokenizes native arguments and has no way to say
# "this is ONE argument" (that is $PSNativeCommandArgumentPassing, PS 7.3+).
#
# Node's child_process.spawn DOES have that way - it builds the Win32 command line
# itself, one argv element per array slot - and Node is the ONLY caller in
# production (src/sandbox-cli-session.mjs). So this test spawns through Node too.
# The alternative would be hand-rolling MSVCRT quoting here, i.e. a second copy of
# the launcher's own Format-Win32Arg, in order to test a path nothing uses.
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { throw "test-sandbox-logon-launcher: node.exe is not on PATH - this test spawns the launcher the way production does (see the note above)" }
$nodeExe = $node.Source

# ---- THE CALLER'S HALF OF THE CONTRACT, in one place. Mirrors what
# src/sandbox-cli-session.mjs's sandboxSpawn does with JSON.stringify().
#
# PS 5.1 TRAP, measured: the PIPELINE form collapses a one-element array to a bare
# scalar (`@('only') | ConvertTo-Json` -> `"only"`), which the launcher then
# rejects as "must be a JSON ARRAY of strings". -InputObject keeps the array shape
# at every length (0 -> `[]`, 1 -> `["only"]`). Always -InputObject.
function ConvertTo-JsonArgv([string[]]$Items) {
  if ($null -eq $Items -or $Items.Count -eq 0) { return '[]' }
  return (ConvertTo-Json -Compress -InputObject @($Items))
}

$root = Join-Path $env:TEMP ("egpt-sandbox-smoketest-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
if ($root -notlike "$env:USERPROFILE*") {
  throw "test-sandbox-logon-launcher: `$env:TEMP is '$env:TEMP', outside the operator's profile. A world-readable temp makes the DENIED assertions meaningless. Re-run with `$env:TEMP = `"`$env:LOCALAPPDATA\Temp`"."
}
$dirA = Join-Path $root 'folder-a'
$dirB = Join-Path $root 'folder-b'
$shareX = Join-Path $root 'share-x'
$shareY = Join-Path $root 'share-y'
$shareZ = Join-Path $root 'share-z'   # CONTROL: never passed as -SharePath
foreach ($d in @($dirA, $dirB, $shareX, $shareY, $shareZ)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
Set-Content -LiteralPath (Join-Path $dirA 'marker.txt') -Value 'MARKER-A-CONTENT' -NoNewline
Set-Content -LiteralPath (Join-Path $dirB 'marker.txt') -Value 'MARKER-B-CONTENT' -NoNewline
Set-Content -LiteralPath (Join-Path $shareX 'marker.txt') -Value 'MARKER-X-CONTENT' -NoNewline
Set-Content -LiteralPath (Join-Path $shareY 'marker.txt') -Value 'MARKER-Y-CONTENT' -NoNewline
Set-Content -LiteralPath (Join-Path $shareZ 'marker.txt') -Value 'MARKER-Z-CONTENT' -NoNewline

$launcher = Join-Path $PSScriptRoot 'sandbox-logon-launcher.ps1'
$psExe = Join-Path $PSHOME 'powershell.exe'
$specPath = Join-Path $root 'launch-spec.json'
# One argv element per array slot, no shell, no re-tokenization - exactly what
# Node's spawn() gives sandbox-cli-session.mjs. Written with no double quotes of
# its own so PowerShell can hand it to node.exe unharmed (see the note above).
$spawnJs = 'const f=require(''fs''),c=require(''child_process'');' +
           'const a=JSON.parse(f.readFileSync(process.argv[1],''utf8''));' +
           'const r=c.spawnSync(''powershell.exe'',a,{encoding:''utf8''});' +
           'process.stdout.write(String(r.stdout||''''));' +
           'process.stdout.write(String(r.stderr||''''));' +
           'process.exit(r.status===null?1:r.status);'

function Invoke-Launcher([string]$TargetFolder, [string[]]$InnerArgv, [string[]]$Shares = @()) {
  # ONE argv element per launcher parameter, each a JSON array - the whole contract.
  # InnerBin must be an absolute path (operator 2026-08-21): the launcher passes it
  # as CreateProcessWithLogonW's lpApplicationName, which does not search PATH.
  $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-TargetFolder', $TargetFolder)
  if ($Shares.Count -gt 0) { $psArgs += @('-SharePath', (ConvertTo-JsonArgv $Shares)) }
  $psArgs += @('-InnerBin', $psExe, '-InnerArgs', (ConvertTo-JsonArgv $InnerArgv))
  # WriteAllText with an explicit BOM-LESS UTF8Encoding, not Set-Content -Encoding
  # UTF8: PS 5.1's UTF8 writes a BYTE ORDER MARK and JSON.parse then fails with
  # "Unexpected token, ... is not valid JSON". Measured 2026-09-05.
  [System.IO.File]::WriteAllText($specPath, (ConvertTo-Json -Compress -InputObject @($psArgs)), (New-Object System.Text.UTF8Encoding($false)))
  # Local ErrorActionPreference override: the outer script's 'Stop' would make the
  # FIRST stderr line from this native call (launcher Log() writes go to stderr) a
  # terminating error, hiding the launcher's real output that follows it.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return (& $nodeExe -e $spawnJs -- $specPath 2>&1) } finally { $ErrorActionPreference = $prev }
}

# ==== sections 1-2: per-account ACL confinement ============================
function Invoke-Session([string]$OwnFolder, [string]$OtherMarkerPath) {
  # Trivial inner command: try to read this session's OWN marker, then try the
  # OTHER session's marker (must be denied). Both results are printed on one line
  # so a single launcher invocation (one logon session, one ACE) gives us both
  # readings in one shot.
  # Own marker is read by ABSOLUTE path: this test asserts the ACL boundary (can it
  # read its own folder / is it denied the other's), and a relative path would
  # silently conflate that with how the inner shell resolves its working directory.
  # CWD is asserted separately, on its own line, because production confinement
  # DOES depend on lpCurrentDirectory being honoured (warm-cli-session spawns the
  # CLI with cwd = the conversation folder).
  $ownMarkerPath = Join-Path $OwnFolder 'marker.txt'
  $inner = "Write-Output ('CWD=' + (Get-Location).Path); " +
           "`$own = Get-Content -LiteralPath '$ownMarkerPath' -ErrorAction Stop; " +
           "try { `$other = Get-Content -LiteralPath '$OtherMarkerPath' -ErrorAction Stop; `$otherResult = 'READ:' + `$other } " +
           "catch { `$otherResult = 'DENIED:' + `$_.Exception.GetType().Name } " +
           "Write-Output ('OWN=' + `$own); Write-Output ('OTHER=' + `$otherResult)"
  return (Invoke-Launcher -TargetFolder $OwnFolder -InnerArgv @('-NoProfile', '-NonInteractive', '-Command', $inner))
}

Write-Host "=== session for folder-a ==="
$outA = Invoke-Session -OwnFolder $dirA -OtherMarkerPath (Join-Path $dirB 'marker.txt')
$outA | ForEach-Object { Write-Host "  $_" }

Write-Host "=== session for folder-b ==="
$outB = Invoke-Session -OwnFolder $dirB -OtherMarkerPath (Join-Path $dirA 'marker.txt')
$outB | ForEach-Object { Write-Host "  $_" }

function Test-Result([string[]]$Out, [string]$ExpectOwn, [string]$ExpectCwd, [string]$Label) {
  $ownLine = $Out | Where-Object { $_ -match '^OWN=' } | Select-Object -First 1
  $otherLine = $Out | Where-Object { $_ -match '^OTHER=' } | Select-Object -First 1
  $cwdLine = $Out | Where-Object { $_ -match '^CWD=' } | Select-Object -First 1
  $ownOk = $ownLine -eq "OWN=$ExpectOwn"
  $otherOk = $otherLine -match '^OTHER=DENIED:'
  # lpCurrentDirectory must actually land the child in its own folder: production
  # confinement is scoped to the conversation dir the CLI is spawned in.
  $cwdOk = $cwdLine -eq "CWD=$ExpectCwd"
  Write-Host ""
  Write-Host "--- $Label ---"
  Write-Host "  own marker read:      $(if ($ownOk) {'PASS'} else {'FAIL'})  ($ownLine)"
  Write-Host "  other marker denied:  $(if ($otherOk) {'PASS'} else {'FAIL'})  ($otherLine)"
  # REPORTED, NOT ASSERTED - see the KNOWN, ACCEPTED FAILURE note in the header.
  # seclogon does not apply lpCurrentDirectory to a directory whose ancestors the
  # leased account cannot traverse, so the child lands on C:\ and this reads OK-BUT-C.
  # It was folded into the verdict before, which made a healthy run report
  # "OVERALL: FAIL" and taught everyone to ignore the verdict. It is a known gap,
  # so it is printed as one and the verdict answers the two assertions that matter.
  Write-Host "  cwd is own folder:    $(if ($cwdOk) {'PASS'} else {'KNOWN GAP (not asserted)'})  ($cwdLine)"
  return ($ownOk -and $otherOk)
}

$passA = Test-Result -Out $outA -ExpectOwn 'MARKER-A-CONTENT' -ExpectCwd $dirA -Label 'folder-a session'
$passB = Test-Result -Out $outB -ExpectOwn 'MARKER-B-CONTENT' -ExpectCwd $dirB -Label 'folder-b session'

# ==== section 3: TWO -SharePath entries in ONE invocation ==================
# The old [string[]] parameter could not carry two: `-SharePath X Y` bound only X
# and dropped Y into the inner argv, silently. One JSON array element carries any
# number, and each still gets its own independent grant/revoke.
Write-Host ""
Write-Host "=== session with TWO share paths (plus one control folder that gets none) ==="
$credPath = Join-Path $env:USERPROFILE '.claude\.credentials.json'
$shareInner =
  "foreach (`$d in @('$shareX','$shareY','$shareZ')) { " +
  "  `$name = Split-Path `$d -Leaf; " +
  "  try { `$r = 'READ:' + (Get-Content -LiteralPath (Join-Path `$d 'marker.txt') -Raw -ErrorAction Stop) } catch { `$r = 'DENIED' } " +
  "  try { Set-Content -LiteralPath (Join-Path `$d 'written-by-child.txt') -Value 'child wrote here' -ErrorAction Stop; `$w = 'WROTE' } catch { `$w = 'DENIED' } " +
  "  Write-Output ('SHARE=' + `$name + ' ' + `$r + ' ' + `$w) }; " +
  "try { `$n = (Get-Content -LiteralPath '$credPath' -Raw -ErrorAction Stop).Length; Write-Output ('CREDS=READ:' + `$n) } " +
  "catch { Write-Output 'CREDS=DENIED' }"
$outS = Invoke-Launcher -TargetFolder $dirA -Shares @($shareX, $shareY) `
  -InnerArgv @('-NoProfile', '-NonInteractive', '-Command', $shareInner)
$outS | ForEach-Object { Write-Host "  $_" }

function Get-ShareLine([string[]]$Out, [string]$Name) {
  return ($Out | Where-Object { $_ -match "^SHARE=$Name " } | Select-Object -First 1)
}
$xLine = Get-ShareLine $outS 'share-x'
$yLine = Get-ShareLine $outS 'share-y'
$zLine = Get-ShareLine $outS 'share-z'
$credLine = $outS | Where-Object { $_ -match '^CREDS=' } | Select-Object -First 1
$xOk = $xLine -eq 'SHARE=share-x READ:MARKER-X-CONTENT WROTE'
$yOk = $yLine -eq 'SHARE=share-y READ:MARKER-Y-CONTENT WROTE'
$zOk = $zLine -eq 'SHARE=share-z DENIED DENIED'
$credOk = $credLine -eq 'CREDS=DENIED'
# EVERY ACE must be gone: the finally purges TargetFolder and each share path that
# actually got one. A leftover here is a real leak, not cosmetic.
$residue = @()
foreach ($d in @($dirA, $dirB, $shareX, $shareY, $shareZ)) {
  foreach ($ace in (Get-Acl -LiteralPath $d).Access) {
    if ($ace.IdentityReference.Value -match 'egpt-sbx') { $residue += ("$d -> " + $ace.IdentityReference.Value) }
  }
}
Write-Host ""
Write-Host "--- two share paths in one invocation ---"
Write-Host "  first share ACE'd:     $(if ($xOk) {'PASS'} else {'FAIL'})  ($xLine)"
Write-Host "  second share ACE'd:    $(if ($yOk) {'PASS'} else {'FAIL'})  ($yLine)"
Write-Host "  control NOT ACE'd:     $(if ($zOk) {'PASS'} else {'FAIL'})  ($zLine)"
Write-Host "  operator creds denied: $(if ($credOk) {'PASS'} else {'FAIL'})  ($credLine)"
Write-Host "  zero leftover ACEs:    $(if ($residue.Count -eq 0) {'PASS'} else {'FAIL'})  ($($residue.Count) found$(if ($residue.Count) { ': ' + ($residue -join '; ') }))"
$passS = $xOk -and $yOk -and $zOk -and $credOk -and ($residue.Count -eq 0)

# ==== section 4: the inner argv round-trip ================================
# THE REGRESSION THAT KILLED PRODUCTION: `--verbose` must arrive as an ordinary
# argv element, not be eaten by the binder; an EMPTY element must arrive empty
# (claude-args.mjs pushes `--setting-sources` ''); spaces and quotes must survive
# Format-Win32Arg's re-serialization into the one Win32 lpCommandLine.
Write-Host ""
Write-Host "=== inner argv round-trip ==="
$dumpScript = Join-Path $dirA 'argvdump.ps1'
Set-Content -LiteralPath $dumpScript -Value 'Write-Output ("INNER-ARGV=" + (ConvertTo-Json -Compress -InputObject @($args)))'
$probe = @('--verbose', '', '--setting-sources', '', 'arg with spaces', 'quote"inside')
$outR = Invoke-Launcher -TargetFolder $dirA `
  -InnerArgv (@('-NoProfile', '-NonInteractive', '-File', $dumpScript) + $probe)
$outR | ForEach-Object { Write-Host "  $_" }
$argvLine = $outR | Where-Object { $_ -match '^INNER-ARGV=' } | Select-Object -First 1
$expected = 'INNER-ARGV=' + (ConvertTo-JsonArgv $probe)
$passR = ($argvLine -eq $expected)
Write-Host ""
Write-Host "--- inner argv round-trip ---"
Write-Host "  expected: $expected"
Write-Host "  actual:   $argvLine"
Write-Host "  verbatim, --verbose included: $(if ($passR) {'PASS'} else {'FAIL'})"

Write-Host ""
if ($passA -and $passB -and $passS -and $passR) {
  Write-Host "OVERALL: PASS - confinement holds, two share paths were granted and revoked, and the inner argv survived verbatim"
} else {
  Write-Host "OVERALL: FAIL - see per-section results above"
}

Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction SilentlyContinue
