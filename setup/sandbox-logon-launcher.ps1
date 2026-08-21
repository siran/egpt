# sandbox-logon-launcher.ps1  - per-warm-session OS-level isolation for a
# `sandboxed: true` conversation. Run elevated (local admin) at least once so
# it can create the shared unprivileged account; every later invocation just
# needs LogonUser + folder-ACE + CreateProcessWithTokenW rights, which the
# elevated Administrator this daemon runs under already carries by default.
#
# MECHANISM (decided, see HANDOFF/ROADMAP; do not redesign):
# Windows LogonUser mints a FRESH, unique logon SID every call, even against
# the same account's credentials. So: ONE shared local account (egpt-sandbox),
# created once (idempotent) [step a]. Per invocation (= per warm session):
#   b) LogonUser the shared account -> a token for a brand-new logon session.
#   c) pull that session's logon SID off the token (S-1-5-5-<luid> group -
#      exactly the group GetTokenInformation(TokenGroups) would flag
#      SE_GROUP_LOGON_ID for; WindowsIdentity.Groups is the .NET wrapper over
#      that same GetTokenInformation(TokenGroups) call, used here instead of
#      hand-marshaling the variable-length SID_AND_ATTRIBUTES array).
#   d) grant that ONE SID a read/write (Modify) ACE on exactly TargetFolder -
#      never Everyone, never a parent dir.
#   e) CreateProcessWithTokenW launches InnerBin under that token, with the
#      launcher's OWN stdio handles passed straight through (STARTF_USESTDHANDLES)
#      so the inner process's stdin/stdout/stderr ARE the same pipes Node's
#      child_process.spawn of THIS script sees.
#   f) wait for the inner process, best-effort revoke the ACE, exit with the
#      inner process's own exit code.
#
# WHY CreateProcessWithTokenW, not CreateProcessAsUser (both were offered):
# CreateProcessAsUser needs SeAssignPrimaryTokenPrivilege in the CALLER's own
# token. Default Windows policy grants that right only to LOCAL SERVICE /
# NETWORK SERVICE / SYSTEM - NOT to Administrators (verify: secpol.msc ->
# User Rights Assignment -> "Replace a process level token"). This daemon
# runs interactively under the operator's own elevated account (Startup-
# folder supervisor, not a SYSTEM service), so CreateProcessAsUser would fail
# with ERROR_PRIVILEGE_NOT_HELD out of the box. CreateProcessWithTokenW only
# needs SeImpersonatePrivilege, which Administrators DO hold by default - so
# it is the one that actually works for this deployment shape.
# UNVERIFIED (needs the elevated smoke test, setup/test-sandbox-logon-launcher.ps1,
# which this file's author did not run): CreateProcessWithTokenW is serviced
# by the Secondary Logon (seclogon) SYSTEM service via RPC, a different
# process than this one. Whether its STARTF_USESTDHANDLES handle values
# survive that RPC hop intact (so the inner process's stdio really is the
# SAME pipe, not silently detached) is the one part of step (e) that could
# not be confirmed without local-admin rights to create the shared account.
# If the smoke test shows stdio does NOT come through: the fix is granting
# the operator's account "Replace a process level token" and switching this
# script to LogonUser -> DuplicateTokenEx(..., TokenPrimary) -> CreateProcessAsUser
# instead - do not fall back to anything broader (no Everyone ACL, no
# skipping per-session SID scoping) to paper over it.
#
# PARAMS: InnerArgs is declared ValueFromRemainingArguments (see below), NOT
# a named -InnerArgs flag one would join and re-parse. Verified empirically
# (a plain `-InnerArgs val1 val2 val3` NAMED array parameter only ever binds
# the FIRST following token in PowerShell 5.1  - everything after it fails
# with "A positional parameter cannot be found"): the caller must NOT pass
# the literal `-InnerArgs` token; it must just append the raw inner argv
# after -InnerBin, e.g.
#   powershell.exe -File sandbox-logon-launcher.ps1 -TargetFolder <dir> -InnerBin <bin> --input-format stream-json ...
# ValueFromRemainingArguments then collects every trailing token - INCLUDING
# ones starting with `--` - verbatim, one array element each, no shell
# re-parsing anywhere in the chain (Node's spawn() never touches a shell,
# and PowerShell's remaining-arguments capture does not re-tokenize).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetFolder,
  [Parameter(Mandatory = $true)][string]$InnerBin,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$InnerArgs
)

$ErrorActionPreference = 'Stop'

# Every diagnostic goes to STDERR ONLY. The inner process's stdout is wired
# straight through to THIS script's own stdout handle (step e)  - anything
# this script itself wrote to stdout would land in the same pipe Node is
# parsing as claude's stream-json output and could corrupt it.
function Log([string]$msg) { [Console]::Error.WriteLine("sandbox-logon-launcher: $msg") }

if (-not (Test-Path -LiteralPath $TargetFolder -PathType Container)) {
  throw "sandbox-logon-launcher: TargetFolder does not exist or is not a directory: $TargetFolder"
}
if (-not $InnerArgs -or $InnerArgs.Count -eq 0) {
  throw "sandbox-logon-launcher: InnerArgs is empty  - nothing to run"
}

$SandboxUser = 'egpt-sandbox'
# DPAPI (Export-Clixml's SecureString protection) is scoped to the Windows
# account that encrypts it  - only decryptable by that same account. Fine
# here: this daemon always runs under one fixed operator account (Startup-
# folder supervisor), never as a rotating service identity.
$CredDir = Join-Path $env:ProgramData 'egpt'
$CredPath = Join-Path $CredDir 'sandbox-cred.xml'

function New-RandomPassword {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  # base64 already mixes upper/lower/digits/symbols (+, /, =); append a fixed
  # symbol+digit+letter run so complexity policy is satisfied even if the
  # random draw happens to omit a category.
  return ([Convert]::ToBase64String($bytes) + '!Aa1')
}

# (a) Ensure the ONE shared account exists  - idempotent, local-admin only,
# fail loudly (never silently degrade) if creation is not possible.
function Get-SandboxCredential {
  $existing = Get-LocalUser -Name $SandboxUser -ErrorAction SilentlyContinue
  if ($existing -and (Test-Path -LiteralPath $CredPath)) {
    try { return Import-Clixml -Path $CredPath }
    catch { throw "sandbox-logon-launcher: account '$SandboxUser' exists but its stored credential at $CredPath could not be read ($($_.Exception.Message))  - delete that file to force a self-heal, or fix its permissions" }
  }
  $securePwd = ConvertTo-SecureString -String (New-RandomPassword) -AsPlainText -Force
  if (-not $existing) {
    Log "creating shared local account '$SandboxUser' (first sandboxed run on this node)"
    try {
      New-LocalUser -Name $SandboxUser -Password $securePwd `
        -FullName 'egpt sandbox' `
        -Description 'egpt sandboxed:true logon (managed)' `
        -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -ErrorAction Stop | Out-Null
    } catch {
      throw "sandbox-logon-launcher: failed to create local account '$SandboxUser'  - $($_.Exception.Message) (this must run as a local Administrator)"
    }
  } else {
    # Account exists but the credential file we'd need to LogonUser it is
    # gone (deleted, moved node, etc.)  - self-heal by resetting its password
    # to a freshly generated one we DO have, rather than getting stuck.
    Log "account '$SandboxUser' exists but its credential file is missing  - resetting its password to restore a known credential"
    try { Set-LocalUser -Name $SandboxUser -Password $securePwd -ErrorAction Stop }
    catch { throw "sandbox-logon-launcher: account '$SandboxUser' exists but its password could not be reset to restore a known credential  - $($_.Exception.Message) (must run as a local Administrator)" }
  }
  $cred = New-Object System.Management.Automation.PSCredential($SandboxUser, $securePwd)
  try {
    New-Item -ItemType Directory -Path $CredDir -Force -ErrorAction Stop | Out-Null
    $cred | Export-Clixml -Path $CredPath -Force
  } catch {
    throw "sandbox-logon-launcher: account '$SandboxUser' is ready but its credential could not be persisted to $CredPath  - $($_.Exception.Message)"
  }
  return $cred
}

# ---- Win32 P/Invoke (inline C#, no separate binary) ----
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SandboxLogon {
    public const int LOGON32_LOGON_INTERACTIVE = 2;
    public const int LOGON32_PROVIDER_DEFAULT = 0;
    public const int LOGON_WITH_PROFILE = 1;
    public const int CREATE_NO_WINDOW = 0x08000000;
    public const int STARTF_USESTDHANDLES = 0x00000100;
    public const int STARTF_USESHOWWINDOW = 0x00000001;
    public const int STD_INPUT_HANDLE = -10;
    public const int STD_OUTPUT_HANDLE = -11;
    public const int STD_ERROR_HANDLE = -12;
    public const uint TOKEN_QUERY = 0x0008;
    public const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    public const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    public const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread;
        public int dwProcessId; public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID Luid; public uint Attributes; }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool LogonUser(string lpszUsername, string lpszDomain, string lpszPassword,
        int dwLogonType, int dwLogonProvider, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessWithTokenW(IntPtr hToken, int dwLogonFlags,
        string lpApplicationName, StringBuilder lpCommandLine, int dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges,
        ref TOKEN_PRIVILEGES NewState, int BufferLength, IntPtr PreviousState, IntPtr ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop

function Enable-SeImpersonatePrivilege {
  # CreateProcessWithTokenW requires SE_IMPERSONATE_NAME ENABLED (not just
  # present) in the caller's own token  - an elevated Administrator token
  # carries it but typically disabled-by-default, same as SeDebugPrivilege.
  [IntPtr]$hProc = [SandboxLogon]::GetCurrentProcess()
  [IntPtr]$hTok = [IntPtr]::Zero
  if (-not [SandboxLogon]::OpenProcessToken($hProc, [SandboxLogon]::TOKEN_QUERY -bor [SandboxLogon]::TOKEN_ADJUST_PRIVILEGES, [ref]$hTok)) {
    throw "sandbox-logon-launcher: OpenProcessToken (self) failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    $luid = New-Object SandboxLogon+LUID
    if (-not [SandboxLogon]::LookupPrivilegeValue($null, 'SeImpersonatePrivilege', [ref]$luid)) {
      throw "sandbox-logon-launcher: LookupPrivilegeValue(SeImpersonatePrivilege) failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $tp = New-Object SandboxLogon+TOKEN_PRIVILEGES
    $tp.PrivilegeCount = 1
    $tp.Luid = $luid
    $tp.Attributes = [SandboxLogon]::SE_PRIVILEGE_ENABLED
    if (-not [SandboxLogon]::AdjustTokenPrivileges($hTok, $false, [ref]$tp, 0, [IntPtr]::Zero, [IntPtr]::Zero)) {
      throw "sandbox-logon-launcher: AdjustTokenPrivileges(SeImpersonatePrivilege) failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    # AdjustTokenPrivileges can return TRUE but leave nothing actually
    # changed (ERROR_NOT_ALL_ASSIGNED) when the privilege isn't held at all  -
    # that means this process is not really running as a local Administrator.
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1300) {
      throw "sandbox-logon-launcher: this process does not hold SeImpersonatePrivilege (ERROR_NOT_ALL_ASSIGNED)  - must run as a local Administrator"
    }
  } finally {
    [SandboxLogon]::CloseHandle($hTok) | Out-Null
  }
}

function Format-Win32Arg([string]$Arg) {
  # Standard MSVCRT/CommandLineToArgvW quoting so InnerBin/InnerArgs survive
  # the one unavoidable re-serialization into a Win32 lpCommandLine string
  # (CreateProcessWithTokenW has no argv-array form).
  if ($null -eq $Arg) { $Arg = '' }
  if ($Arg.Length -gt 0 -and $Arg -notmatch '[\s"]') { return $Arg }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $i = 0
  while ($i -lt $Arg.Length) {
    $nbs = 0
    while ($i -lt $Arg.Length -and $Arg[$i] -eq '\') { $nbs++; $i++ }
    if ($i -eq $Arg.Length) {
      [void]$sb.Append('\' * ($nbs * 2))
      break
    } elseif ($Arg[$i] -eq '"') {
      [void]$sb.Append('\' * ($nbs * 2 + 1))
      [void]$sb.Append('"')
      $i++
    } else {
      [void]$sb.Append('\' * $nbs)
      [void]$sb.Append($Arg[$i])
      $i++
    }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

# ---- (a) ensure the shared account ----
$cred = Get-SandboxCredential
$plainPwd = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($cred.Password))
$aceGranted = $false
$logonSid = $null
$hToken = [IntPtr]::Zero
try {
  # ---- (b) LogonUser: a fresh, unique logon session every call, even for
  # the same account credentials  - this IS the per-session isolation unit. ----
  if (-not [SandboxLogon]::LogonUser($SandboxUser, '.', $plainPwd, [SandboxLogon]::LOGON32_LOGON_INTERACTIVE, [SandboxLogon]::LOGON32_PROVIDER_DEFAULT, [ref]$hToken)) {
    $werr = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "sandbox-logon-launcher: LogonUser('$SandboxUser') failed, Win32 error $werr"
  }

  # ---- (c) pull this session's logon SID off the fresh token. A logon SID
  # is always S-1-5-5-<high>-<low> (NT_AUTHORITY, SECURITY_LOGON_IDS_RID)  -
  # exactly the group GetTokenInformation(TokenGroups) would report with the
  # SE_GROUP_LOGON_ID attribute; WindowsIdentity.Groups is the BCL's own
  # wrapper over that same token query, used here instead of hand-marshaling
  # a variable-length SID_AND_ATTRIBUTES array. ----
  $identity = New-Object System.Security.Principal.WindowsIdentity($hToken)
  try {
    $logonSid = $identity.Groups | Where-Object { $_.Value -match '^S-1-5-5-' } | Select-Object -First 1
  } finally {
    $identity.Dispose()
  }
  if (-not $logonSid) {
    throw "sandbox-logon-launcher: could not find a logon SID (S-1-5-5-*) among the fresh token's groups  - cannot scope the folder ACE to this session"
  }
  Log "logon SID for this session: $($logonSid.Value)"

  # ---- (d) grant read/write on exactly TargetFolder  - never broader ----
  $acl = Get-Acl -LiteralPath $TargetFolder
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $logonSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $TargetFolder -AclObject $acl
  $aceGranted = $true
  Log "granted Modify to $($logonSid.Value) on $TargetFolder"

  Enable-SeImpersonatePrivilege

  # ---- (e) launch InnerBin under this token, stdio proxied straight through ----
  $cmdParts = New-Object System.Collections.Generic.List[string]
  [void]$cmdParts.Add((Format-Win32Arg $InnerBin))
  foreach ($a in $InnerArgs) { [void]$cmdParts.Add((Format-Win32Arg $a)) }
  $cmdLine = New-Object System.Text.StringBuilder(($cmdParts -join ' '))

  $si = New-Object SandboxLogon+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf([type]([SandboxLogon+STARTUPINFO]))
  $si.dwFlags = [SandboxLogon]::STARTF_USESTDHANDLES -bor [SandboxLogon]::STARTF_USESHOWWINDOW
  $si.wShowWindow = 0   # SW_HIDE
  $si.hStdInput = [SandboxLogon]::GetStdHandle([SandboxLogon]::STD_INPUT_HANDLE)
  $si.hStdOutput = [SandboxLogon]::GetStdHandle([SandboxLogon]::STD_OUTPUT_HANDLE)
  $si.hStdError = [SandboxLogon]::GetStdHandle([SandboxLogon]::STD_ERROR_HANDLE)

  $pi = New-Object SandboxLogon+PROCESS_INFORMATION
  Log "launching under egpt-sandbox: $InnerBin (+$($InnerArgs.Count) args), cwd=$TargetFolder"
  $ok = [SandboxLogon]::CreateProcessWithTokenW(
    $hToken, [SandboxLogon]::LOGON_WITH_PROFILE,
    $null, $cmdLine, [SandboxLogon]::CREATE_NO_WINDOW,
    [IntPtr]::Zero, $TargetFolder, [ref]$si, [ref]$pi)
  if (-not $ok) {
    $werr = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "sandbox-logon-launcher: CreateProcessWithTokenW failed, Win32 error $werr"
  }

  # hToken is no longer needed once the process is created (it got its own
  # copy)  - close it now rather than holding it for the process's lifetime.
  [SandboxLogon]::CloseHandle($hToken) | Out-Null
  $hToken = [IntPtr]::Zero

  [SandboxLogon]::CloseHandle($pi.hThread) | Out-Null
  # ---- (f, part 1) wait for the inner process, capture its real exit code ----
  [SandboxLogon]::WaitForSingleObject($pi.hProcess, [SandboxLogon]::INFINITE) | Out-Null
  [uint32]$exitCode = 0
  [SandboxLogon]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode) | Out-Null
  [SandboxLogon]::CloseHandle($pi.hProcess) | Out-Null
  Log "inner process exited $exitCode"
  $finalExit = [int]$exitCode
} finally {
  if ($plainPwd) { $plainPwd = $null }
  if ($hToken -ne [IntPtr]::Zero) { [SandboxLogon]::CloseHandle($hToken) | Out-Null }
  # ---- (f, part 2) best-effort revoke the ACE  - never let cleanup failure
  # mask the inner process's own result. ----
  if ($aceGranted -and $logonSid) {
    try {
      $acl2 = Get-Acl -LiteralPath $TargetFolder
      $acl2.PurgeAccessRules($logonSid)
      Set-Acl -LiteralPath $TargetFolder -AclObject $acl2
      Log "revoked ACE for $($logonSid.Value) on $TargetFolder"
    } catch {
      Log "WARNING: could not revoke the ACE for $($logonSid.Value) on $TargetFolder  - $($_.Exception.Message)"
    }
  }
}

exit $finalExit
