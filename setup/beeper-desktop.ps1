# beeper-desktop.ps1 - helpers for this machine's Beeper Desktop installs: the optional eGPT
# Beeper services, who may stop/start them, the tokens in config.yaml and the API port each answers.
# Dot-sourced by src\tools\beeper-update.ps1, grant-beeper-service-control.ps1,
# install-beeper-s0-service.ps1, renew-beeper-token.ps1, egpt-wake-duty.ps1, beeper-window.ps1,
# s0-identity-reconcile.ps1 and share-beeper-primary-profile.ps1.
# Functions only: no top-level side effects (tests dot-source it).
#
# ASCII ONLY: PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI.

$BeeperApiPorts = 23373..23382   # a Desktop's API binds the first free port from 23373
$BeeperServiceRights = 'CCLCSWRPWPLORC'   # query, start (RP), stop (WP), interrogate, read control

# The NSSM services whose program is this Beeper.exe. None = the baseline: the Beeper app alone.
function Get-BeeperServices([string] $Exe) {
  Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'nssm' } | ForEach-Object {
    $app = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$($_.Name)\Parameters" -ErrorAction SilentlyContinue).Application
    if ($app -and $app -ieq $Exe) { [pscustomobject]@{ Name = $_.Name; Running = ($_.State -eq 'Running') } }
  }
}

# May this process stop and start the service? Asks the SCM for exactly those rights; changes nothing.
function Test-BeeperServiceControl([string] $Name) {
  if (-not ('EgptBeeper.Scm' -as [type])) {
    Add-Type -Namespace EgptBeeper -Name Scm -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenSCManager(string machine, string db, uint access);
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenService(IntPtr scm, string name, uint access);
[DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr h);
'@
  }
  $scm = [EgptBeeper.Scm]::OpenSCManager([NullString]::Value, [NullString]::Value, 1)   # SC_MANAGER_CONNECT
  if ($scm -eq [IntPtr]::Zero) { return $false }
  try {
    $h = [EgptBeeper.Scm]::OpenService($scm, $Name, 0x3C)   # START | STOP | ENUMERATE_DEPENDENTS | QUERY_STATUS: what Stop-/Start-Service use
    if ($h -eq [IntPtr]::Zero) { return $false }
    [void][EgptBeeper.Scm]::CloseServiceHandle($h)
    return $true
  } finally { [void][EgptBeeper.Scm]::CloseServiceHandle($scm) }
}

# --- the service's security descriptor (SDDL), as text ---------------------------------------
function Get-SddlAllowAces([string] $Sddl) {
  [regex]::Matches($Sddl, '\(A;([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*)\)')
}

# Does an allow ACE give $Sid both start (RP) and stop (WP)?
function Test-BeeperServiceAce([string] $Sddl, [string] $Sid) {
  foreach ($m in Get-SddlAllowAces $Sddl) {
    if ($m.Groups[5].Value -ne $Sid) { continue }
    $r = $m.Groups[2].Value
    if ($r -match '^0x') { $v = [Convert]::ToInt32($r, 16); if (($v -band 0x30) -eq 0x30) { return $true }; continue }
    $codes = [regex]::Matches($r, '..') | ForEach-Object { $_.Value }
    if ($codes -contains 'RP' -and $codes -contains 'WP') { return $true }
  }
  return $false
}

# Where the DACL's ACE list ends: after D:, its flags and its (...) entries.
function Get-SddlDaclEnd([string] $Sddl) {
  $i = $Sddl.IndexOf('D:')
  if ($i -lt 0) { throw "no DACL in '$Sddl'" }
  $j = $i + 2
  while ($j -lt $Sddl.Length -and $Sddl[$j] -match '[A-Z_]' -and -not ($j + 1 -lt $Sddl.Length -and $Sddl[$j + 1] -eq ':')) { $j++ }
  while ($j -lt $Sddl.Length -and $Sddl[$j] -eq '(') {
    $k = $Sddl.IndexOf(')', $j)
    if ($k -lt 0) { throw "unterminated ACE in '$Sddl'" }
    $j = $k + 1
  }
  return $j
}

function Add-BeeperServiceAce([string] $Sddl, [string] $Sid) {
  if (Test-BeeperServiceAce $Sddl $Sid) { return $Sddl }
  return $Sddl.Insert((Get-SddlDaclEnd $Sddl), "(A;;$BeeperServiceRights;;;$Sid)")
}

function Remove-BeeperServiceAce([string] $Sddl, [string] $Sid) {
  return [regex]::Replace($Sddl, '\(A;[^;()]*;[^;()]*;[^;()]*;[^;()]*;' + [regex]::Escape($Sid) + '\)', '')
}

# Grant (or -Revoke) $Sid start/stop on one service. Prints the SDDL before and after; idempotent.
function Set-BeeperServiceAccess {
  param([string] $Name, [string] $Sid, [switch] $Revoke, [switch] $DryRun)
  $before = ((& sc.exe sdshow $Name) -join '').Trim()
  if ($LASTEXITCODE -ne 0 -or $before -notmatch 'D:') { throw "sc.exe sdshow $Name failed: $before" }
  $after = if ($Revoke) { Remove-BeeperServiceAce $before $Sid } else { Add-BeeperServiceAce $before $Sid }
  Write-Host "  $Name before: $before"
  Write-Host "  $Name after:  $after"
  if ($after -eq $before) { Write-Host "  $Name unchanged"; return }
  if ($DryRun) { Write-Host "  $Name -DryRun: not written"; return }
  $out = (& sc.exe sdset $Name $after) -join ' '
  if ($LASTEXITCODE -ne 0) { throw "sc.exe sdset $Name failed: $out" }
  Write-Host "  $Name written"
}

# --- tokens and ports ------------------------------------------------------------------------
# connection name -> token, read from config.yaml by eGPT's own reader. Never print the values.
function Get-BeeperTokens([string] $RepoRoot, [string] $EgptHome) {
  $io = ([Uri](Join-Path $RepoRoot 'src\tools\config-io.mjs')).AbsoluteUri
  $js = 'const m = await import(process.argv[1]); const b = m.readConfigSync()?.beeper ?? {}; const o = {}; for (const [k, v] of Object.entries(b)) if (v && typeof v === ''object'' && v.token) o[k] = v.token; console.log(JSON.stringify(o));'
  $prev = $env:EGPT_HOME
  if ($EgptHome) { $env:EGPT_HOME = $EgptHome }
  try { $json = & node --input-type=module -e $js $io } finally { $env:EGPT_HOME = $prev }
  $t = @{}
  if ($LASTEXITCODE -eq 0 -and $json) {
    (($json | Out-String) | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $t[$_.Name] = [string]$_.Value }
  }
  return $t
}

# The port whose Desktop answers this token (200 on /v1/accounts), or $null.
function Find-BeeperPort([string] $Token) {
  foreach ($port in $BeeperApiPorts) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/v1/accounts" -Headers @{ Authorization = "Bearer $Token" }
      if ($r.StatusCode -eq 200) { return $port }
    } catch { }
  }
  return $null
}

# The Beeper version serving a port (/v1/info needs no token), or $null.
function Get-BeeperVersionAt([int] $Port) {
  try { return [string](Invoke-RestMethod -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/v1/info").app.version } catch { return $null }
}

# --- one profile, two runtimes ---------------------------------------------------------------
# A service may run the desktop user's OWN Beeper profile: the window runs it in Session 1 while
# it is open, the service in Session 0 otherwise, never both (two live instances of one profile
# are two clients claiming one device id). setup\share-beeper-primary-profile.ps1 sets it up;
# setup\beeper-window.ps1 hands it over; setup\s0-identity-reconcile.ps1 is the SYSTEM side.

# The --user-data-dir in a command line or AppParameters, or $null (the default profile).
function Get-BeeperUserDataDir([string] $CommandLine) {
  if ($CommandLine -match '--user-data-dir=(?:"([^"]+)"|(\S+))') { return $Matches[1] + $Matches[2] }
  return $null
}

function ConvertTo-BeeperPathKey([string] $Path) { $Path.Replace('\', '/').TrimEnd('/').ToLower() }

# The profile the window opens with no --user-data-dir.
function Get-BeeperDefaultProfile([string] $AppData = $env:APPDATA) { Join-Path $AppData 'BeeperTexts' }

# Does this service run the desktop user's own window profile?
function Test-BeeperSharedProfile([string] $AppParameters, [string] $AppData = $env:APPDATA) {
  $udd = Get-BeeperUserDataDir $AppParameters
  return [bool]$udd -and (ConvertTo-BeeperPathKey $udd) -eq (ConvertTo-BeeperPathKey (Get-BeeperDefaultProfile $AppData))
}

# The flags every Session 0 Beeper runs with:
#   --disable-gpu, --disable-gpu-compositing    no GPU in Session 0. Never add
#                                                --disable-software-rasterizer too: the app paints nothing.
#   --disable-background-timer-throttling,      nothing in Session 0 is ever foregrounded; without
#   --disable-renderer-backgrounding,           these a live sync socket stalls.
#   --disable-backgrounding-occluded-windows
# Never --remote-debugging-port (no CDP: loopback has no auth).
function Get-BeeperServiceArgLine([string] $UserDataDir) {
  return "--user-data-dir=`"$UserDataDir`" --disable-gpu --disable-gpu-compositing --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows"
}

# THE CLAIM: Session 1 owns the profile. An open handle, not a flag, so a logoff or a crash
# releases it with the process that held it.
function Get-BeeperClaimPath([string] $UserDataDir) { return $UserDataDir.TrimEnd('\', '/') + '.egpt-s1-claim' }

# An exclusive handle on the claim, or $null while someone else holds it.
function Open-BeeperClaim([string] $Path) {
  try { return New-Object IO.FileStream($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose) }
  catch [IO.IOException] { return $null }
}

# Held? Probed with an exclusive open that lets go at once.
function Test-BeeperClaimHeld([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try { ([IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)).Dispose(); return $false }
  catch [IO.FileNotFoundException] { return $false }
  catch { return $true }
}

# Does a live Beeper hold the profile's Chromium lockfile? It is held open with delete-on-close
# and no delete sharing, so deleting it fails exactly while an instance holds it; a file no
# instance holds (left by a power cut) is removed, as Chromium itself would recreate it.
function Test-BeeperLockHeld([string] $UserDataDir) {
  $lock = Join-Path $UserDataDir 'lockfile'
  if (-not (Test-Path -LiteralPath $lock)) { return $false }
  try { [IO.File]::Delete($lock); return $false } catch { return $true }
}

# Beeper processes naming this profile. A child always carries --user-data-dir; a process whose
# command line this user cannot read (another session's SYSTEM process) is not counted here.
function Select-BeeperProfileProcesses($Processes, [string] $UserDataDir) {
  $want = ConvertTo-BeeperPathKey $UserDataDir
  return @($Processes | Where-Object {
    $u = Get-BeeperUserDataDir ([string]$_.CommandLine)
    $_.Name -eq 'Beeper.exe' -and $u -and (ConvertTo-BeeperPathKey $u) -eq $want
  })
}

function Test-BeeperProfileInUse([string] $UserDataDir, $Processes) {
  return (Test-BeeperLockHeld $UserDataDir) -or (@(Select-BeeperProfileProcesses $Processes $UserDataDir).Count -gt 0)
}

# The service's NSSM Start/Pre hook: 99 makes NSSM abort the start and leave the service Stopped.
function Get-BeeperPreStartCode([bool] $Claimed, [bool] $InUse) { if ($Claimed -or $InUse) { return 99 } return 0 }

# The SYSTEM reconciler's only move: start a stopped service nobody in Session 1 claims or runs.
function Get-BeeperReconcileAction([string] $ServiceState, [bool] $Claimed, [bool] $InUse) {
  if ($ServiceState -eq 'Stopped' -and -not $Claimed -and -not $InUse) { return 'start' }
  return 'none'
}

# --- the spine, from a script ------------------------------------------------------------------
# Live = state\spine.pid names a running process and state\alive.txt beat within 2 min
# (src\daemon-singleton.mjs).
function Test-EgptSpineLive([string] $EgptHome) {
  $pidFile = Join-Path $EgptHome 'state\spine.pid'
  $alive = Join-Path $EgptHome 'state\alive.txt'
  if (-not (Test-Path -LiteralPath $pidFile) -or -not (Test-Path -LiteralPath $alive)) { return $false }
  if (((Get-Date) - (Get-Item -LiteralPath $alive).LastWriteTime).TotalSeconds -ge 120) { return $false }
  $n = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$n)) { return $false }
  return [bool](Get-Process -Id $n -ErrorAction SilentlyContinue)
}

# One command line into the ingest box (src\spine\ingest.mjs): temp -> rename, as upgrade.ps1 does.
function Send-EgptIngestLine([string] $EgptHome, [string] $Line) {
  $dir = Join-Path $EgptHome 'state\ingest'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $name = ($Line.TrimStart('/') -replace '\s+', '-') + '-' + (Get-Date -Format 'yyyyMMddHHmmssfff')
  $tmp = Join-Path $dir "$name.tmp"
  [IO.File]::WriteAllText($tmp, $Line, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination (Join-Path $dir $name) -Force
}

# --- closing the Beeper app ------------------------------------------------------------------
# WM_CLOSE to every top-level window of these processes whose class matches, hidden ones
# included: a window hidden in the tray has no MainWindowHandle, so Process.CloseMainWindow never
# reaches it. Beeper quits on it only when "Quit Beeper when closing the main window" is on;
# otherwise it hides, and the caller must not kill it. Returns how many windows were sent it.
function Close-BeeperAppWindows([int[]] $Pids, [string] $ClassLike = 'Chrome_WidgetWin_1') {
  if (-not ('EgptBeeper.Win' -as [type])) {
    Add-Type -Namespace EgptBeeper -Name Win -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
'@
  }
  $hits = New-Object System.Collections.Generic.List[IntPtr]
  $cb = [EgptBeeper.Win+EnumProc] {
    param($h, $l)
    $p = [uint32]0
    [void][EgptBeeper.Win]::GetWindowThreadProcessId($h, [ref]$p)
    if ($Pids -contains [int]$p) {
      $c = New-Object Text.StringBuilder 256
      [void][EgptBeeper.Win]::GetClassName($h, $c, 256)
      if ($c.ToString() -like $ClassLike) { $hits.Add($h) }
    }
    return $true
  }
  [void][EgptBeeper.Win]::EnumWindows($cb, [IntPtr]::Zero)
  foreach ($h in $hits) { [void][EgptBeeper.Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }   # WM_CLOSE
  return $hits.Count
}

# The Beeper app (Session 1): WM_CLOSE, then wait up to $Sec for its processes and its profile
# lockfile to go. $true once it has quit, or was not running. It never kills: one that only hid
# is still running when this returns $false.
function Close-BeeperApp([int] $Sec, [string] $ProfileDir, [scriptblock] $GetApp = { @(Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 }) }, [string] $ClassLike = 'Chrome_WidgetWin_1') {
  if (-not @(& $GetApp).Count) { return $true }
  $main = @(& $GetApp | Where-Object { [string]$_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId })
  [void](Close-BeeperAppWindows $main $ClassLike)
  $deadline = (Get-Date).AddSeconds($Sec)
  do {
    if (-not @(& $GetApp).Count -and -not (Test-BeeperLockHeld $ProfileDir)) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

# --- a Beeper service run as the desktop user ----------------------------------------------
# setup\beeper-services-run-as-user.ps1 and install-beeper-s0-service.ps1 -RunAsUser. The password
# only ever travels as a pointer to unmanaged memory (LogonUser, ChangeServiceConfig): never a
# file, a log line or a command line.
function Add-BeeperAccountType {
  if ('EgptBeeper.Acct' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
namespace EgptBeeper {
public static class Acct {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LogonUserW(string user, string domain, IntPtr password, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // 0, or the Win32 error of a SERVICE logon (5) with these credentials.
  public static int TryServiceLogon(string user, string domain, IntPtr password) {
    IntPtr t;
    if (LogonUserW(user, domain, password, 5, 0, out t)) { CloseHandle(t); return 0; }
    return Marshal.GetLastWin32Error();
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenSCManagerW(string m, string d, uint a);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenServiceW(IntPtr scm, string name, uint a);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ChangeServiceConfigW(IntPtr svc, uint type, uint start, uint error, string bin, string group, IntPtr tag, string deps, string account, IntPtr password, string display);
  [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr h);
  // 0, or the Win32 error of setting the service's log-on account.
  public static int SetServiceAccount(string service, string account, IntPtr password) {
    IntPtr scm = OpenSCManagerW(null, null, 0x0001);
    if (scm == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try {
      IntPtr s = OpenServiceW(scm, service, 0x0002);
      if (s == IntPtr.Zero) return Marshal.GetLastWin32Error();
      try { return ChangeServiceConfigW(s, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, null, null, IntPtr.Zero, null, account, password, null) ? 0 : Marshal.GetLastWin32Error(); }
      finally { CloseServiceHandle(s); }
    } finally { CloseServiceHandle(scm); }
  }
  [StructLayout(LayoutKind.Sequential)] struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LsaAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LsaAttributes attrs, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, bool all, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr p);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr h);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  static IntPtr OpenPolicy() {
    LsaAttributes a = new LsaAttributes(); a.Length = Marshal.SizeOf(typeof(LsaAttributes));
    IntPtr p; uint st = LsaOpenPolicy(IntPtr.Zero, ref a, 0x00000810, out p);   // POLICY_LOOKUP_NAMES | POLICY_CREATE_ACCOUNT
    if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
    return p;
  }
  // The rights granted to this SID directly (not through a group).
  public static string[] Rights(byte[] sid) {
    IntPtr p = OpenPolicy();
    try {
      IntPtr arr; uint n; uint st = LsaEnumerateAccountRights(p, sid, out arr, out n);
      if (st == 0xC0000034) return new string[0];   // STATUS_OBJECT_NAME_NOT_FOUND: no rights at all
      if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
      try {
        List<string> list = new List<string>(); int size = Marshal.SizeOf(typeof(LsaString));
        for (int i = 0; i < n; i++) { LsaString s = (LsaString)Marshal.PtrToStructure(new IntPtr(arr.ToInt64() + i * size), typeof(LsaString)); list.Add(Marshal.PtrToStringUni(s.Buffer, s.Length / 2)); }
        return list.ToArray();
      } finally { LsaFreeMemory(arr); }
    } finally { LsaClose(p); }
  }
  public static void SetRight(byte[] sid, string right, bool add) {
    IntPtr p = OpenPolicy();
    LsaString[] r = new LsaString[1];
    r[0].Buffer = Marshal.StringToHGlobalUni(right); r[0].Length = (ushort)(right.Length * 2); r[0].MaximumLength = (ushort)(r[0].Length + 2);
    try {
      uint st = add ? LsaAddAccountRights(p, sid, r, 1) : LsaRemoveAccountRights(p, sid, false, r, 1);
      if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
    } finally { Marshal.FreeHGlobal(r[0].Buffer); LsaClose(p); }
  }
}
}
'@
}

$BeeperServiceLogonRight = 'SeServiceLogonRight'
$BeeperBlankPasswordLine = 'a blank password cannot run a service: Windows allows blank-password accounts to log on at the console only'

# A SERVICE logon's Win32 result, in words. 1385 = the password is right but the account may not
# log on as a service yet: expected before the right is granted.
function Get-BeeperLogonVerdict([int] $Code) {
  $v = [ordered]@{ ok = $false; rightMissing = $false; message = $null }
  switch ($Code) {
    0 { $v.ok = $true }
    1385 { $v.ok = $true; $v.rightMissing = $true }
    1326 { $v.message = 'wrong user name or password' }
    1327 { $v.message = $BeeperBlankPasswordLine }
    1330 { $v.message = 'the password has expired' }
    1331 { $v.message = 'the account is disabled' }
    1907 { $v.message = 'the password must be changed before the account can log on' }
    1909 { $v.message = 'the account is locked out' }
    default { $v.message = "the service logon failed (Win32 error $Code)" }
  }
  return $v
}

# '.\an' / 'reve\an' / 'an' -> @{ domain; user; account ('.\an' for this machine) }
function Split-BeeperAccount([string] $Name) {
  if ($Name -match '^(.+?)\\(.+)$') { $d = $Matches[1]; $u = $Matches[2] } else { $d = '.'; $u = $Name }
  if ($d -ieq $env:COMPUTERNAME) { $d = '.' }
  return [ordered]@{ domain = $d; user = $u; account = "$d\$u" }
}

function Get-BeeperSidBytes([string] $Sid) {
  $s = New-Object Security.Principal.SecurityIdentifier($Sid)
  $b = New-Object byte[] $s.BinaryLength
  $s.GetBinaryForm($b, 0)
  return ,$b
}

# The verdict on a credential, before anything changes. A blank password is refused before LogonUser.
function Test-BeeperCredential([pscredential] $Credential) {
  if ($Credential.Password.Length -eq 0) { return [ordered]@{ ok = $false; rightMissing = $false; message = $BeeperBlankPasswordLine } }
  Add-BeeperAccountType
  $a = Split-BeeperAccount $Credential.UserName
  $p = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Credential.Password)
  try { return Get-BeeperLogonVerdict ([EgptBeeper.Acct]::TryServiceLogon($a.user, $a.domain, $p)) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($p) }
}

function Test-BeeperServiceLogonRight([string] $Sid) {
  Add-BeeperAccountType
  return [EgptBeeper.Acct]::Rights((Get-BeeperSidBytes $Sid)) -contains $BeeperServiceLogonRight
}

function Set-BeeperServiceLogonRight([string] $Sid, [switch] $Remove) {
  Add-BeeperAccountType
  [EgptBeeper.Acct]::SetRight((Get-BeeperSidBytes $Sid), $BeeperServiceLogonRight, -not $Remove)
}

# The service's log-on account: the credential's user, or LocalSystem when none is given.
function Set-BeeperServiceAccount([string] $Name, [pscredential] $Credential) {
  Add-BeeperAccountType
  $account = if ($Credential) { (Split-BeeperAccount $Credential.UserName).account } else { 'LocalSystem' }
  $p = if ($Credential) { [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Credential.Password) } else { [Runtime.InteropServices.Marshal]::StringToHGlobalUni('') }
  try { $code = [EgptBeeper.Acct]::SetServiceAccount($Name, $account, $p) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($p) }
  if ($code) { throw "could not set $Name to log on as $account (Win32 error $code)" }
}

# Does this rule set give $Sid full control of the object itself, with no deny?
function Test-BeeperAclRules($Rules, [string] $Sid) {
  $mine = @($Rules | Where-Object { $_.IdentityReference.Value -eq $Sid -and -not ([int]$_.PropagationFlags -band 2) })   # 2 = InheritOnly
  if (@($mine | Where-Object { "$($_.AccessControlType)" -eq 'Deny' }).Count) { return $false }
  return @($mine | Where-Object {
    "$($_.AccessControlType)" -eq 'Allow' -and ((([int]$_.FileSystemRights -band 2032127) -eq 2032127) -or ([int]$_.FileSystemRights -band 0x10000000))
  }).Count -gt 0
}

# Every entry under $Dir (and $Dir itself) that does not give $Sid full control.
function Get-BeeperAclGaps([string] $Dir, [string] $Sid) {
  $gaps = New-Object System.Collections.Generic.List[string]
  foreach ($e in @(Get-Item -LiteralPath $Dir -Force) + @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue)) {
    $rules = (Get-Acl -LiteralPath $e.FullName).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (-not (Test-BeeperAclRules $rules $Sid)) { $gaps.Add($e.FullName) }
  }
  return $gaps.ToArray()
}

# Hold the spine's Beeper bridges (calls wait, no redial) while an install changes hands, through
# the ingest box. $true when a live spine was asked.
function Enter-EgptBeeperHold([string] $EgptHome) {
  if (-not (Test-EgptSpineLive $EgptHome)) { return $false }
  Send-EgptIngestLine $EgptHome '/beeper-hold on'
  return $true
}

# Release it once $Token answers again (or after $Sec). Nothing to do when nothing was held.
function Exit-EgptBeeperHold([string] $EgptHome, [bool] $Held, [string] $Token, [int] $Sec = 90) {
  if (-not $Held) { return }
  $deadline = (Get-Date).AddSeconds($Sec)
  while ($Token -and -not (Find-BeeperPort $Token) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  Send-EgptIngestLine $EgptHome '/beeper-hold off'
}
