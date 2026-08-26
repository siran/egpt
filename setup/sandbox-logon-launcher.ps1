# sandbox-logon-launcher.ps1  - per-warm-session OS-level isolation for a
# `sandboxed: true` conversation. NEEDS NO PRIVILEGE AT RUNTIME: it runs as the
# ordinary, unelevated account the egpt daemon runs as. Elevation is SETUP-ONLY
# and one-time  - creating the pool accounts and their group, and granting that
# group ReadAndExecute on the CLI bin dir (~/.local/bin)  - all done by
# provision-sandbox-account.ps1, which self-elevates via UAC and then exits.
#
# MECHANISM (decided, see HANDOFF/ROADMAP; do not redesign):
# Windows LogonUser mints a FRESH, unique logon SID every call - but on this
# machine that logon SID never surfaces in the resulting token's TokenGroups
# (empirically confirmed by full token-group enumeration; do not re-attempt
# this via a different logon type or provider constant), so there is no
# per-call SID to ACL against. THAT is why the pool exists: a set of disposable
# local accounts (egpt-sbx-00..NN, provisioned once, elevated, by
# provision-sandbox-account.ps1 via sandbox-account.ps1's Ensure-SandboxPool),
# each with a FIXED user SID that can actually be ACL'd.
# Per invocation (= per warm session):
#   a) lease one pool account via an atomic per-account lock file (first
#      caller to successfully create the lock file with FileMode.CreateNew
#      owns the lease; the lock stays open, via $lockStream, for the whole
#      turn - that open handle IS the lease).
#   b) get that account's stored credential (DPAPI, operator-scoped).
#   c) resolve that account's own fixed user SID - always present in its own
#      token, unlike the broken per-call logon-session SID.
#   d) grant that SID a read/write (Modify) ACE on exactly TargetFolder -
#      never Everyone, never a parent dir.
#   e) create a PRIVATE per-turn desktop and grant that SID access to it (see
#      New-SandboxDesktop) - nothing on the operator's own WinSta0\Default.
#   f) CreateProcessWithLogonW launches AS that account, twice, through the one
#      shared Invoke-AsLeasedAccount helper: FIRST a short scrub pass that
#      empties the account's scratch profile (see Clear-SandboxProfileContents -
#      it must run as the account itself, which is the only principal that can
#      delete those files without being an Administrator), THEN InnerBin, with
#      the launcher's OWN stdio handles passed straight through
#      (STARTF_USESTDHANDLES) so the inner process's stdin/stdout/stderr ARE the
#      same pipes Node's child_process.spawn of THIS script sees.
#   g) wait for the inner process, destroy the desktop, best-effort revoke the
#      ACE, THEN release the lease (ACE revoke before lock release, so no other
#      turn can claim this account while its ACE from THIS turn might still be
#      getting cleaned up), exit with the inner process's own exit code.
#
# WHY CreateProcessWithLogonW, and not either token-based API (all three were
# tried; this is the only one that works from where this script actually runs):
#  - CreateProcessAsUser needs SeAssignPrimaryTokenPrivilege in the CALLER's own
#    token. Default Windows policy grants that right only to LOCAL SERVICE /
#    NETWORK SERVICE / SYSTEM - NOT to Administrators (verify: secpol.msc ->
#    User Rights Assignment -> "Replace a process level token"). Fails with
#    ERROR_PRIVILEGE_NOT_HELD out of the box.
#  - CreateProcessWithTokenW (LogonUser + this pair was the previous shape here)
#    needs SeImpersonatePrivilege. An ELEVATED Administrator holds it - but the
#    egpt daemon is deliberately UNELEVATED, and UAC token filtering strips that
#    privilege from the filtered token even for an account that IS in
#    Administrators (verified with `whoami /priv` on the unelevated token: only
#    the five standard-user privileges survive). So it worked only in a manually
#    elevated shell and could never have worked in production.
#  - CreateProcessWithLogonW (the API behind `runas`) authenticates from the
#    username + password directly instead of impersonating, and requires NO
#    privilege in the caller at all. That is why the password is STORED (DPAPI,
#    decryptable only by the operator account) rather than a token being minted.
# CAVEAT if anyone moves this: CreateProcessWithLogonW cannot be called from
# LocalSystem - it fails there by design. Irrelevant today (the daemon runs
# interactively as the operator, from the Startup folder), but re-hosting it in
# a SYSTEM service would break this and would have to go back to
# CreateProcessAsUser plus the "Replace a process level token" grant. Do not
# fall back to anything broader (no Everyone ACL, no skipping per-account SID
# scoping) to paper over that.
#
# Both CreateProcessWith*W calls are brokered by the Secondary Logon (seclogon)
# SYSTEM service over RPC, a different process than this one, so whether the
# STARTF_USESTDHANDLES handle values survive that hop is not a given. VERIFIED
# 2026-08-21 by running setup/test-sandbox-logon-launcher.ps1 UNELEVATED: they
# do - the inner process's stdout came back through the launcher's own pipe -
# and lpDesktop does land the child on its private desktop.
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

# Account-provisioning constants/functions ($SandboxPoolSize,
# $SandboxPoolPrefix, $CredDir, Log, New-RandomPassword, Get-SandboxCredential,
# Get-SandboxPoolAccountNames, Ensure-SandboxPool) live in sandbox-account.ps1,
# shared with provision-sandbox-account.ps1's self-elevating one-time setup.
. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

if (-not (Test-Path -LiteralPath $TargetFolder -PathType Container)) {
  throw "sandbox-logon-launcher: TargetFolder does not exist or is not a directory: $TargetFolder"
}
if (-not $InnerArgs -or $InnerArgs.Count -eq 0) {
  throw "sandbox-logon-launcher: InnerArgs is empty  - nothing to run"
}

# ---- Win32 P/Invoke (inline C#, no separate binary) ----
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SandboxLogon {
    public const int LOGON_WITH_PROFILE = 1;
    public const int CREATE_NO_WINDOW = 0x08000000;
    public const int STARTF_USESTDHANDLES = 0x00000100;
    public const int STARTF_USESHOWWINDOW = 0x00000001;
    public const int STD_INPUT_HANDLE = -10;
    public const int STD_OUTPUT_HANDLE = -11;
    public const int STD_ERROR_HANDLE = -12;
    public const uint INFINITE = 0xFFFFFFFF;

    // ---- window station / desktop security (see New-SandboxDesktop) ----
    public const uint READ_CONTROL = 0x00020000;
    public const uint WRITE_DAC    = 0x00040000;
    // What we must open the winsta/desktop WITH in order to read and rewrite
    // its DACL. Deliberately not WRITE_OWNER/DELETE - we only edit the DACL.
    public const uint SD_EDIT_ACCESS = READ_CONTROL | WRITE_DAC;
    public const uint DACL_SECURITY_INFORMATION = 0x00000004;
    public const int  UOI_NAME = 2;

    // Window-station object-specific rights (winuser.h).
    public const int WINSTA_ENUMDESKTOPS      = 0x0001;
    public const int WINSTA_READATTRIBUTES    = 0x0002;
    public const int WINSTA_ACCESSCLIPBOARD   = 0x0004;
    public const int WINSTA_CREATEDESKTOP     = 0x0008;
    public const int WINSTA_WRITEATTRIBUTES   = 0x0010;
    public const int WINSTA_ACCESSGLOBALATOMS = 0x0020;
    public const int WINSTA_EXITWINDOWS       = 0x0040;
    public const int WINSTA_ENUMERATE         = 0x0100;
    public const int WINSTA_READSCREEN        = 0x0200;
    public const int WINSTA_ALL_ACCESS = WINSTA_ENUMDESKTOPS | WINSTA_READATTRIBUTES
        | WINSTA_ACCESSCLIPBOARD | WINSTA_CREATEDESKTOP | WINSTA_WRITEATTRIBUTES
        | WINSTA_ACCESSGLOBALATOMS | WINSTA_EXITWINDOWS | WINSTA_ENUMERATE
        | WINSTA_READSCREEN;   // == 0x37F

    // Desktop object-specific rights (winuser.h).
    public const int DESKTOP_READOBJECTS     = 0x0001;
    public const int DESKTOP_CREATEWINDOW    = 0x0002;
    public const int DESKTOP_CREATEMENU      = 0x0004;
    public const int DESKTOP_HOOKCONTROL     = 0x0008;
    public const int DESKTOP_JOURNALRECORD   = 0x0010;
    public const int DESKTOP_JOURNALPLAYBACK = 0x0020;
    public const int DESKTOP_ENUMERATE       = 0x0040;
    public const int DESKTOP_WRITEOBJECTS    = 0x0080;
    public const int DESKTOP_SWITCHDESKTOP   = 0x0100;
    public const int DESKTOP_ALL_ACCESS = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW
        | DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD
        | DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS
        | DESKTOP_SWITCHDESKTOP;   // == 0x1FF

    // The mask we actually GRANT on the WINDOW STATION. WinSta0 is SHARED with
    // the operator's own live session (unlike the per-turn desktop below), so
    // this is deliberately NOT WINSTA_ALL_ACCESS - it is the empirically
    // determined MINIMUM that lets USER32.dll's DllMain find a station and
    // reach a desktop under it. Established by bisection against real binaries
    // (powershell.exe and claude.exe, both USER32 importers) on 2026-08-21;
    // each line below is a TEST RESULT, not a guess:
    //   WINSTA_ACCESSCLIPBOARD  EXCLUDED - verified not needed. Would other-
    //                           wise read/write the OPERATOR'S clipboard: the
    //                           clipboard belongs to the window STATION, so a
    //                           private desktop does NOT contain it.
    //   WINSTA_READSCREEN       EXCLUDED - verified not needed.
    //   WINSTA_EXITWINDOWS      REQUIRED - counterintuitive, but removing it
    //                           makes both binaries die at 0xC0000142. Grants
    //                           ExitWindowsEx (logoff/shutdown), i.e. a DoS the
    //                           sandbox can inflict. Accepted as unavoidable;
    //                           do not "clean it up" without re-testing.
    // Also NOT WRITE_DAC / WRITE_OWNER / DELETE: a sandboxed account must not
    // be able to re-ACL or destroy the station.
    // If a future InnerBin fails USER32 init with this set, WIDEN one flag at a
    // time and record which one was required - never jump to WINSTA_ALL_ACCESS.
    public const int WINSTA_GRANT = WINSTA_ENUMDESKTOPS | WINSTA_READATTRIBUTES
        | WINSTA_CREATEDESKTOP | WINSTA_WRITEATTRIBUTES | WINSTA_ACCESSGLOBALATOMS
        | WINSTA_EXITWINDOWS | WINSTA_ENUMERATE
        | (int)READ_CONTROL;

    // The mask we grant on the turn's OWN, PRIVATE desktop (created per lease -
    // see New-SandboxDesktop): everything. The desktop rights that are
    // catastrophic on WinSta0\Default - DESKTOP_JOURNALRECORD (system-wide
    // keylogging), DESKTOP_JOURNALPLAYBACK (synthetic input injection / shatter
    // attacks), DESKTOP_HOOKCONTROL, DESKTOP_SWITCHDESKTOP - reach NOTHING from
    // here: this desktop holds only the sandboxed process's own windows, it is
    // never the operator's, and it is destroyed when the turn ends. Full freedom
    // on its own desktop is the entire point of creating one. Still NOT
    // WRITE_DAC / WRITE_OWNER / DELETE: the account may USE its desktop, not
    // re-ACL it (which would let it open the door for other pool accounts).
    public const int DESKTOP_GRANT = DESKTOP_ALL_ACCESS | (int)READ_CONTROL;

    // What THIS process opens the per-turn desktop with: the same rights, plus
    // the right to read and rewrite its DACL, since we add the ACE immediately.
    public const int DESKTOP_CREATE_ACCESS = DESKTOP_ALL_ACCESS | (int)SD_EDIT_ACCESS;

    // CharSet.Unicode is LOAD-BEARING, not decoration: StructLayout defaults to
    // CharSet.Ansi, which marshals the string fields below as char* - and
    // CreateProcessWithLogonW reads them as STARTUPINFOW's WCHAR*. That mismatch
    // was harmless only while every string field stayed null; lpDesktop is
    // assigned now, so without this the child would be handed a garbage desktop
    // name.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
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

    // The launch API. Takes the account's name and password directly and needs
    // NO privilege in the calling process - see the WHY at the top of the file.
    // CharSet.Unicode: this is the *W entry point and every string here is a
    // WCHAR*, exactly as with STARTUPINFO above.
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessWithLogonW(string lpUsername, string lpDomain, string lpPassword,
        int dwLogonFlags, string lpApplicationName, StringBuilder lpCommandLine, int dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    // ---- window station / desktop creation and DACL editing ----
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetProcessWindowStation();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "OpenWindowStationW")]
    public static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    // Creates (or, if one of that name already exists, OPENS) a desktop under
    // the CALLING PROCESS's window station. lpszDevice and pDevmode MUST be
    // NULL - MSDN, not an optimisation. dwFlags is passed 0, i.e. deliberately
    // NOT DF_ALLOWOTHERACCOUNTHOOK (0x0001), which would let processes of other
    // accounts set hooks on this desktop. lpsa NULL means the new desktop gets
    // this process's default DACL (operator + SYSTEM, nobody else); the leased
    // account's access is then added explicitly rather than inherited.
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateDesktopW")]
    public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode,
        uint dwFlags, uint dwDesiredAccess, IntPtr lpsa);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    // nLength / lpnLengthNeeded are BYTE counts, not character counts.
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex,
        StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);

    // pSIRequested is a POINTER to a SECURITY_INFORMATION (DWORD), hence `ref`.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetUserObjectSecurity(IntPtr hObj, ref uint pSIRequested,
        IntPtr pSid, uint nLength, out uint lpnLengthNeeded);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetUserObjectSecurity(IntPtr hObj, ref uint pSIRequested, IntPtr pSid);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop

function Get-UserObjectName {
  param(
    [Parameter(Mandatory = $true)][IntPtr]$Handle,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $sb = New-Object System.Text.StringBuilder 256
  [uint32]$needed = 0
  if (-not [SandboxLogon]::GetUserObjectInformation($Handle, [SandboxLogon]::UOI_NAME, $sb, 512, [ref]$needed)) {
    throw "sandbox-logon-launcher: GetUserObjectInformation(UOI_NAME) on the current $Label failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  return $sb.ToString()
}

function Add-UserObjectAce {
  # Read-modify-write ONE user object's (window station or desktop) DACL.
  # Strictly ADDITIVE: the existing DACL is read back, ACEs are appended to it,
  # and nothing already there is replaced, reordered or removed. Idempotent:
  # an ACE whose SID+flags already carry the requested mask is skipped, so
  # re-running never accumulates duplicates.
  #   $Aces: array of @{ Flags = <AceFlags>; Mask = <int> }
  param(
    [Parameter(Mandatory = $true)][IntPtr]$Handle,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Sid,
    [Parameter(Mandatory = $true)][hashtable[]]$Aces
  )
  [uint32]$si = [SandboxLogon]::DACL_SECURITY_INFORMATION

  # ---- read the current DACL as a self-relative SD ----
  [uint32]$len = 4096
  $bytes = $null
  for ($try = 0; $try -lt 2 -and $null -eq $bytes; $try++) {
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$len)
    try {
      [uint32]$needed = 0
      if ([SandboxLogon]::GetUserObjectSecurity($Handle, [ref]$si, $buf, $len, [ref]$needed)) {
        $bytes = New-Object byte[] ([int]$len)
        [Runtime.InteropServices.Marshal]::Copy($buf, $bytes, 0, [int]$len)
      } else {
        $werr = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($werr -ne 122) {   # 122 = ERROR_INSUFFICIENT_BUFFER
          throw "sandbox-logon-launcher: GetUserObjectSecurity on $Label failed, Win32 error $werr"
        }
        $len = $needed
      }
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    }
  }
  if ($null -eq $bytes) {
    throw "sandbox-logon-launcher: GetUserObjectSecurity on $Label kept reporting ERROR_INSUFFICIENT_BUFFER"
  }

  $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($bytes, 0)
  if ($null -eq $sd.DiscretionaryAcl) {
    # A NULL DACL means unrestricted access. Synthesizing one here would REPLACE
    # that with a restrictive ACL and could lock the interactive session out of
    # its own window station  - refuse rather than "fix" it.
    throw "sandbox-logon-launcher: $Label has a NULL DACL  - refusing to synthesize one"
  }
  $acl = $sd.DiscretionaryAcl

  $added = 0
  foreach ($spec in $Aces) {
    $flags = [System.Security.AccessControl.AceFlags]$spec.Flags
    $mask = [int]$spec.Mask
    $dup = $false
    foreach ($existing in $acl) {
      if (($existing -is [System.Security.AccessControl.CommonAce]) -and
          ($existing.AceType -eq [System.Security.AccessControl.AceType]::AccessAllowed) -and
          ($existing.SecurityIdentifier -eq $Sid) -and
          ($existing.AceFlags -eq $flags) -and
          (($existing.AccessMask -band $mask) -eq $mask)) {
        $dup = $true
        break
      }
    }
    if ($dup) { continue }
    $ace = New-Object System.Security.AccessControl.CommonAce(
      $flags, [System.Security.AccessControl.AceQualifier]::AccessAllowed, $mask, $Sid, $false, $null)
    # Append: allow-ACEs go after any existing deny-ACEs, and appending is what
    # the Win32 reference implementation (AddAceToWindowStation) does too.
    $acl.InsertAce($acl.Count, $ace)
    $added++
  }
  if ($added -eq 0) {
    Log "$Label already grants $($Sid.Value)  - no ACE added"
    return
  }

  # ---- write the modified DACL back ----
  $out = New-Object byte[] ($sd.BinaryLength)
  $sd.GetBinaryForm($out, 0)
  $wbuf = [Runtime.InteropServices.Marshal]::AllocHGlobal($out.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($out, 0, $wbuf, $out.Length)
    if (-not [SandboxLogon]::SetUserObjectSecurity($Handle, [ref]$si, $wbuf)) {
      throw "sandbox-logon-launcher: SetUserObjectSecurity on $Label failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($wbuf)
  }
  Log "granted $($Sid.Value) $added ACE(s) on $Label"
}

function New-SandboxDesktop {
  # WHY A DESKTOP AT ALL (root cause, established empirically 2026-08-21): the
  # leased account's token has no access to any window station / desktop of this
  # logon session, so USER32.dll's DllMain  - which attaches the process to a
  # window station and desktop  - fails, and the child dies at 0xC0000142
  # (STATUS_DLL_INIT_FAILED) before its entry point ever runs. Confirmed by
  # launching three binaries through this exact code path: cmd.exe (no USER32
  # import) launches fine; powershell.exe and claude.exe (both import USER32)
  # both die at 0xC0000142.
  #
  # MSDN's "the function adds permission for the specified user account to the
  # inherited window station and desktop" applies to CreateProcessAsUser, NOT
  # to the CreateProcessWith*W pair  - those are brokered by the seclogon
  # service and do NOT fix up the winsta/desktop DACLs  - so we do it ourselves.
  #
  # WHY A PRIVATE ONE (operator 2026-08-21): the earlier shape granted the pool
  # group rights on WinSta0\Default  - the OPERATOR'S OWN LIVE DESKTOP  - and the
  # only masks that actually carried USER32 through init there were wide ones
  # (screen read, clipboard, hooks, input injection). Those reach out of the
  # sandbox onto the operator's session; that is a sandbox escape by design, not
  # an accident. So instead of widening the mask on a shared desktop, each turn
  # gets its OWN desktop: full freedom on it, and NOTHING on WinSta0\Default.
  # Same shape as the per-turn folder ACE, one layer up. Naming it after the
  # leased account  - already the per-turn isolation unit  - also keeps
  # concurrent sandboxed turns from seeing each other's windows.
  #
  # WHY here and not in provision-sandbox-account.ps1: unlike file ACLs,
  # window-station and desktop DACLs are NOT persistent  - the objects are
  # recreated per logon session, so this has to happen at runtime.
  #
  # Returns @{ Handle; LpDesktop }. The CALLER owns Handle and must CloseDesktop
  # it (see the finally block) - that close is what destroys the desktop.
  param(
    [Parameter(Mandatory = $true)][string]$DesktopName,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$LeasedSid,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$PoolGroupSid
  )

  $hWinStaCur = [SandboxLogon]::GetProcessWindowStation()
  if ($hWinStaCur -eq [IntPtr]::Zero) {
    throw "sandbox-logon-launcher: GetProcessWindowStation failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $winStaName = Get-UserObjectName -Handle $hWinStaCur -Label 'window station'

  # ---- 1. the SHARED window station. Only enough for the pool group to locate
  # a station and reach a desktop under it (WINSTA_GRANT)  - the station is
  # WinSta0, the operator's own, so nothing more.
  # ONE ACE, NO_PROPAGATE_INHERIT, applying to the station object itself. The
  # standard Win32 sample also adds an INHERIT_ONLY|CONTAINER_INHERIT|
  # OBJECT_INHERIT ACE so desktops created later inherit rights; that is exactly
  # what must NOT happen here  - it would hand the whole pool group access to
  # every per-turn desktop created afterwards and defeat the per-account
  # isolation set up in step 2.
  # The INHERITED handle above carries whatever rights it was opened with, which
  # need not include WRITE_DAC. Re-open BY NAME with exactly READ_CONTROL|
  # WRITE_DAC so a missing right fails loudly here rather than deep inside
  # GetUserObjectSecurity/SetUserObjectSecurity.
  $hWinSta = [SandboxLogon]::OpenWindowStation($winStaName, $false, [SandboxLogon]::SD_EDIT_ACCESS)
  if ($hWinSta -eq [IntPtr]::Zero) {
    throw "sandbox-logon-launcher: OpenWindowStation('$winStaName', READ_CONTROL|WRITE_DAC) failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    Add-UserObjectAce -Handle $hWinSta -Label "window station '$winStaName'" -Sid $PoolGroupSid -Aces @(
      @{ Flags = [System.Security.AccessControl.AceFlags]::NoPropagateInherit; Mask = [SandboxLogon]::WINSTA_GRANT }
    )
  } finally {
    # Only the handle WE opened gets closed. $hWinStaCur is the process's own
    # station  - closing that would detach this process from it.
    [SandboxLogon]::CloseWindowStation($hWinSta) | Out-Null
  }

  # ---- 2. this turn's OWN desktop, under that same station. NOTE: CreateDesktop
  # OPENS an existing desktop of the same name instead of failing, so a desktop
  # left behind by a crashed turn is silently reused. Acceptable: the lease lock
  # already serialises turns per account name, the ACE add below is idempotent,
  # and the reused desktop is granted to the same single account.
  $hDesk = [SandboxLogon]::CreateDesktop($DesktopName, [IntPtr]::Zero, [IntPtr]::Zero,
    0, [uint32][SandboxLogon]::DESKTOP_CREATE_ACCESS, [IntPtr]::Zero)
  if ($hDesk -eq [IntPtr]::Zero) {
    throw "sandbox-logon-launcher: CreateDesktop('$DesktopName') under '$winStaName' failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    # The LEASED ACCOUNT's own SID, NOT the pool group's: tighter, and it keeps
    # concurrent sandboxed turns isolated from one another's desktops.
    Add-UserObjectAce -Handle $hDesk -Label "desktop '$winStaName\$DesktopName'" -Sid $LeasedSid -Aces @(
      @{ Flags = [System.Security.AccessControl.AceFlags]::None; Mask = [SandboxLogon]::DESKTOP_GRANT }
    )
  } catch {
    # Not yet handed to the caller, so nothing else would ever close it.
    [SandboxLogon]::CloseDesktop($hDesk) | Out-Null
    throw
  }

  Log "created per-turn desktop '$winStaName\$DesktopName' (SwitchDesktop there to watch this turn)"
  [PSCustomObject]@{ Handle = $hDesk; LpDesktop = "$winStaName\$DesktopName" }
}

function Format-Win32Arg([string]$Arg) {
  # Standard MSVCRT/CommandLineToArgvW quoting so InnerBin/InnerArgs survive
  # the one unavoidable re-serialization into a Win32 lpCommandLine string
  # (CreateProcessWithLogonW has no argv-array form).
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

function Invoke-AsLeasedAccount {
  # THE single CreateProcessWithLogonW call site in this script. It is used
  # TWICE per turn - once for the scratch-profile scrub pass, once for InnerBin
  # itself - so that both go through exactly the same launch path (same logon
  # flags, same private desktop, same exit-code handling) instead of growing a
  # second, divergent copy of it.
  #
  # Throws if the LAUNCH fails. A non-zero exit code from the child is RETURNED,
  # not thrown: the caller decides whether that is fatal (InnerBin) or a warning
  # (the scrub).
  #
  # BUDGET, measured 2026-08-26 on this machine, do not exceed: MSDN's note that
  # CreateProcessWithLogonW's lpCommandLine maxes out at 1024 characters is real
  # and ENFORCED - a 3074-character command line fails outright with
  # E_INVALIDARG (0x80070057), it does not truncate. That is why the scrub below
  # is a compact inline -Command and NOT a -EncodedCommand payload (base64 of
  # UTF-16 would be ~3x the script's size and blow the limit immediately).
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][string]$Password,
    [Parameter(Mandatory = $true)][string]$Bin,
    [Parameter(Mandatory = $true)][string[]]$BinArgs,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$LpDesktop,
    [Parameter(Mandatory = $true)][string]$Label,
    [IntPtr]$StdIn = [IntPtr]::Zero,
    [IntPtr]$StdOut = [IntPtr]::Zero,
    [IntPtr]$StdError = [IntPtr]::Zero
  )
  $cmdParts = New-Object System.Collections.Generic.List[string]
  [void]$cmdParts.Add((Format-Win32Arg $Bin))
  foreach ($a in $BinArgs) { [void]$cmdParts.Add((Format-Win32Arg $a)) }
  $cmdLine = New-Object System.Text.StringBuilder(($cmdParts -join ' '))

  $si = New-Object SandboxLogon+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf([type]([SandboxLogon+STARTUPINFO]))
  # Land the child on ITS OWN desktop rather than letting it inherit this
  # launcher's. "<winsta>\<desktop>"  - the backslash is what tells Win32 the
  # string names both. Without this the child would inherit WinSta0\Default,
  # which it now (deliberately) has no rights on at all, and die at 0xC0000142.
  $si.lpDesktop = $LpDesktop
  $si.dwFlags = [SandboxLogon]::STARTF_USESTDHANDLES -bor [SandboxLogon]::STARTF_USESHOWWINDOW
  $si.wShowWindow = 0   # SW_HIDE
  # CreateProcessWithLogonW never inherits handles (seclogon duplicates exactly
  # these three into the child), so a handle left at IntPtr::Zero gives the child
  # NO such stream at all rather than a leaked one - verified 2026-08-26, the
  # call succeeds with a NULL hStdInput. That is how the scrub pass is kept from
  # ever reading the stream-json stdin or writing the stream-json stdout.
  $si.hStdInput = $StdIn
  $si.hStdOutput = $StdOut
  $si.hStdError = $StdError

  $pi = New-Object SandboxLogon+PROCESS_INFORMATION
  Log "$Label under ${AccountName}: $Bin (+$($BinArgs.Count) args), cwd=$WorkingDirectory"
  # lpApplicationName MUST be the resolved path, not $null (operator 2026-08-21):
  # leaving it null relies on the target account's own (unpredictable) PATH
  # search to resolve the first token of lpCommandLine, and empirically that
  # path (not a permissions issue) is what the ERROR_PATH_NOT_FOUND was about.
  # InnerBin must therefore always be a fully-resolved absolute path by the time
  # it reaches this script -- callers (sandbox-cli-session.mjs) are responsible
  # for that, same as any other CreateProcess-family caller.
  # Domain '.' = this machine's local account database; the pool accounts are
  # local, never domain.
  $ok = [SandboxLogon]::CreateProcessWithLogonW(
    $AccountName, '.', $Password, [SandboxLogon]::LOGON_WITH_PROFILE,
    $Bin, $cmdLine, [SandboxLogon]::CREATE_NO_WINDOW,
    [IntPtr]::Zero, $WorkingDirectory, [ref]$si, [ref]$pi)
  if (-not $ok) {
    $werr = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "sandbox-logon-launcher: CreateProcessWithLogonW('$AccountName') failed for $Label, Win32 error $werr"
  }

  [SandboxLogon]::CloseHandle($pi.hThread) | Out-Null
  [SandboxLogon]::WaitForSingleObject($pi.hProcess, [SandboxLogon]::INFINITE) | Out-Null
  [uint32]$exitCode = 0
  [SandboxLogon]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode) | Out-Null
  [SandboxLogon]::CloseHandle($pi.hProcess) | Out-Null
  Log "$Label exited $exitCode"
  # A crashed process's exit code is often a raw NTSTATUS (e.g. 0xC0000142)
  # reported through GetExitCodeProcess as a uint32 -- a CHECKED [int] cast
  # throws on anything past Int32.MaxValue instead of exiting with it. Bit-
  # reinterpret instead (same bytes, signed), matching how exit codes are
  # conventionally represented everywhere else (Node's child_process included).
  return [BitConverter]::ToInt32([BitConverter]::GetBytes($exitCode), 0)
}

function Clear-SandboxProfileContents {
  # Empty ONE pool account's Windows user profile. Called on LEASE ACQUIRE,
  # before InnerBin runs.
  #
  # WHY (operator ruling 2026-08-21: the account profile is SCRATCH, the
  # conversation folder is the only durable storage): pool accounts are REUSED
  # across DIFFERENT conversations, and LOGON_WITH_PROFILE materialises
  # C:\Users\<account>\. Anything the inner CLI writes under %USERPROFILE% /
  # %APPDATA% / %LOCALAPPDATA%  - browser profiles, caches, tokens, app config  -
  # survives there and is visible to whichever DIFFERENT conversation leases that
  # account next. That is a cross-conversation information leak the per-turn
  # folder ACE cannot catch, because it is not a permissions failure at all; it
  # can only be fixed by wiping.
  #
  # WHY AS THE LEASED ACCOUNT (operator ruling 2026-08-26, and the whole point of
  # this function): the previous shape deleted the entire Win32_UserProfile from
  # HERE, in the launcher's own context, which needs local-Administrator rights.
  # That worked only while the launcher still ran elevated; the launch path moved
  # to CreateProcessWithLogonW precisely so the daemon runs UNELEVATED, so in
  # production it failed on EVERY turn with "A required privilege is not held by
  # the client" and the leak was live (all 16 profile dirs on REVE, never
  # emptied). The leased account OWNS everything under its own profile, so IT can
  # delete those files with no privilege at all - hence a scrub pass launched
  # through the same Invoke-AsLeasedAccount path as InnerBin itself. Do NOT move
  # this back into the launcher's own context, and do NOT reintroduce an
  # elevation requirement on the launch path.
  #
  # WHY ONLY THE CONTENTS: removing the profile REGISTRATION (its ProfileList
  # registry entry) or the C:\Users\<account> directory itself still needs
  # admin, so neither is attempted. Nothing is lost by that - an EMPTY directory
  # leaks nothing - and it also sidesteps the accumulation hazard the old
  # comment here warned about: because the directory and its ProfileList entry
  # stay in agreement, the next logon reuses them instead of creating
  # egpt-sbx-07.REVE, then .REVE.000, forever.
  #
  # KNOWN RESIDUE, accepted: the profile is LOADED during the scrub (the scrub
  # pass is itself a LOGON_WITH_PROFILE logon), so the hive files - NTUSER.DAT,
  # UsrClass.dat and their logs - are locked and get skipped, i.e. HKCU state
  # does carry across conversations. Deleting them is not an option: a profile
  # directory whose hive is missing makes the NEXT logon fail into a temporary
  # profile. Files are where the CLIs actually put tokens and caches.
  #
  # SAFETY: this deletes a whole user profile's worth of files, so a targeting
  # bug could destroy the operator's own. The guards below are belt-and-braces
  # and REFUSE (throw) rather than proceed - unchanged from the admin-only
  # version this replaces - and the scrub itself re-checks, INSIDE the child,
  # that the path it was handed is its own %USERPROFILE%.
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][string]$Password,
    [Parameter(Mandatory = $true)][string]$LpDesktop
  )
  # ---- GUARD 1 (pool prefix): checked FIRST, before a SID is even resolved, so
  # that no code path in this function can target 'an', 'Administrator' or any
  # other non-pool account even if it is called wrongly.
  if (-not $AccountName.StartsWith($SandboxPoolPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "sandbox-logon-launcher: refusing to scrub the profile of '$AccountName'  - it is not a sandbox pool account (its name must start with '$SandboxPoolPrefix')"
  }

  # Resolve the NAME to a SID and select the profile BY SID  - never by matching
  # path strings, which a lookalike directory name could fool. Win32_UserProfile
  # is READABLE unelevated (verified 2026-08-26); only Remove-CimInstance on one
  # needed the privilege we no longer have.
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
  } catch {
    # The account does not exist yet (first-ever use on this node  - the pool is
    # created lazily by Get-SandboxCredential later in the launcher's flow). No
    # account means no profile: nothing to scrub, and nothing was deleted.
    Log "no profile to scrub for '$AccountName'  - the account does not resolve to a SID ($($_.Exception.Message))"
    return
  }

  $found = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
    Where-Object { $_.SID -eq $sid.Value })

  # NORMAL CASE, not an error: first-ever use of this account. There is nothing
  # to scrub AND no profile directory yet, so skip the extra logon entirely -
  # step (f)'s own LOGON_WITH_PROFILE will create it fresh.
  if ($found.Count -eq 0) { return }
  # ---- GUARD 2 (exactly one match): a SID matching several profiles means
  # something is wrong that this function is not equipped to reason about.
  if ($found.Count -gt 1) {
    throw "sandbox-logon-launcher: refusing to scrub the profile of '$AccountName'  - $($found.Count) Win32_UserProfile entries match SID $($sid.Value)"
  }
  $candidate = $found[0]
  # ---- GUARD 3 (not a system profile).
  if ($candidate.Special) {
    throw "sandbox-logon-launcher: refusing to scrub the profile of '$AccountName' (SID $($sid.Value))  - it is flagged Special, i.e. a system profile"
  }
  # ---- GUARD 4 (independent path check): the SID lookup above and this leaf
  # comparison must AGREE. Deliberately redundant with GUARD 1.
  if ([string]::IsNullOrWhiteSpace($candidate.LocalPath)) {
    throw "sandbox-logon-launcher: refusing to scrub the profile of '$AccountName' (SID $($sid.Value))  - its Win32_UserProfile entry has no LocalPath"
  }
  $leaf = Split-Path -Path $candidate.LocalPath -Leaf
  if ($leaf -ne $AccountName) {
    throw "sandbox-logon-launcher: refusing to scrub the profile of '$AccountName' (SID $($sid.Value))  - it lives at '$($candidate.LocalPath)', whose leaf '$leaf' is not the account name"
  }
  $profilePath = $candidate.LocalPath

  # The scrub itself, run by the account that owns these files. Both values
  # interpolated below are launcher-derived and already prefix-guarded above -
  # the account name comes from Get-SandboxPoolAccountNames and the path from
  # the Win32_UserProfile entry for its SID - so NEITHER is caller-supplied and
  # neither can contain a quote. Line by line:
  #  - GUARD 5, inside the child: refuse unless this really is our own profile.
  #    Cheap, and it is the one check that cannot be fooled by anything the
  #    launcher got wrong, because the child is the account.
  #  - delete the CHILDREN of the profile dir, never the dir itself (see WHY
  #    ONLY THE CONTENTS above). -Force covers hidden/system/read-only;
  #    SilentlyContinue is the best-effort part: locked files (the loaded hive,
  #    a handle a previous turn has not closed yet) are skipped, not fatal.
  #    Remove-Item deletes a junction/symlink as a LINK rather than recursing
  #    through it (re-verified 2026-08-26 against a planted junction), so a
  #    junction a previous turn planted here cannot steer the scrub outside
  #    this profile.
  #  - report what is left, so a scrub that silently stops working is visible in
  #    the log instead of having to be discovered by listing C:\Users.
  # Keep this SHORT: the whole command line must fit in 1024 characters, see
  # Invoke-AsLeasedAccount's BUDGET note.
  $scrubScript = @(
    "`$r = '$profilePath'"
    "if (`$env:USERNAME -ne '$AccountName' -or `$env:USERPROFILE -ne `$r) { [Console]::Error.WriteLine('sandbox-logon-launcher: scrub REFUSED - running as ' + `$env:USERNAME + ' at ' + `$env:USERPROFILE); exit 11 }"
    "Get-ChildItem -LiteralPath `$r -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"
    "[Console]::Error.WriteLine('sandbox-logon-launcher: scrubbed ' + `$r + ', ' + @(Get-ChildItem -LiteralPath `$r -Force -Recurse -ErrorAction SilentlyContinue).Count + ' locked entries left')"
  ) -join '; '

  # NON-FATAL: the scrub is a HYGIENE step, not a security gate. Warn on stderr
  # (stdout is the inner process's own stream-json pipe, see Log's comment) and
  # let the turn proceed.
  try {
    # stdin/stdout deliberately left NULL: this pass must not be able to touch
    # the stream-json pipes. Its stdout is pointed at the launcher's own STDERR
    # so that anything it prints - including the report line above - is a
    # diagnostic, never protocol. cwd is %SystemRoot%, a directory every account
    # can use; the scrub has no business in TargetFolder.
    $errHandle = [SandboxLogon]::GetStdHandle([SandboxLogon]::STD_ERROR_HANDLE)
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $rc = Invoke-AsLeasedAccount -AccountName $AccountName -Password $Password `
      -Bin $psExe -BinArgs @('-NoProfile', '-NonInteractive', '-Command', $scrubScript) `
      -WorkingDirectory $env:SystemRoot -LpDesktop $LpDesktop -Label 'profile scrub' `
      -StdOut $errHandle -StdError $errHandle
    if ($rc -ne 0) {
      Log "WARNING: the scratch-profile scrub for '$AccountName' at $profilePath exited $rc (continuing anyway: hygiene step, not a security gate)"
    }
  } catch {
    Log "WARNING: could not scrub the scratch profile for '$AccountName' at $profilePath  - $($_.Exception.Message) (continuing anyway: hygiene step, not a security gate)"
  }
}

# ---- (a) lease one pool account. An atomic per-account lock file - the
# first caller to successfully create it with FileMode.CreateNew (atomic on
# NTFS) owns the lease. Every other concurrent caller gets an IOException
# (file already exists) and moves on to the next pool name. The open
# FileStream handle IS the lease; it stays open for the whole turn. ----
$locksDir = Join-Path (Join-Path $env:ProgramData 'egpt') 'sandbox-pool-locks'
New-Item -ItemType Directory -Path $locksDir -Force -ErrorAction Stop | Out-Null

$poolNames = Get-SandboxPoolAccountNames
$leasedName = $null
$lockStream = $null
$lockPath = $null
$maxLeaseAttempts = 40   # ~10s total at 250ms between full-pool sweeps
for ($attempt = 1; $attempt -le $maxLeaseAttempts -and -not $leasedName; $attempt++) {
  $shuffled = Get-Random -InputObject $poolNames -Count $poolNames.Count
  foreach ($name in $shuffled) {
    $candidatePath = Join-Path $locksDir "$name.lock"
    try {
      $lockStream = [System.IO.File]::Open($candidatePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
      $leasedName = $name
      $lockPath = $candidatePath
      break
    } catch [System.IO.IOException] {
      # already leased by another concurrent turn  - try the next pool name
    }
  }
  if (-not $leasedName -and $attempt -lt $maxLeaseAttempts) {
    Start-Sleep -Milliseconds 250
  }
}
if (-not $leasedName) {
  throw "sandbox-logon-launcher: sandbox pool exhausted ($($poolNames.Count) accounts all in use)"
}
Log "leased pool account '$leasedName'"

$plainPwd = $null
$aceGranted = $false
$leasedSid = $null
$hSandboxDesk = [IntPtr]::Zero
try {
  # ---- (b) get this account's stored credential  - self-heals if somehow
  # missing, but under normal operation the pool was already provisioned by
  # provision-sandbox-account.ps1, so this just reads the existing file. ----
  $cred = Get-SandboxCredential -AccountName $leasedName
  $plainPwd = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($cred.Password))

  # ---- (c) resolve this account's own fixed user SID  - always present in
  # its own token, unlike the broken per-call logon-session SID. ----
  $leasedSid = (New-Object System.Security.Principal.NTAccount($leasedName)).Translate([System.Security.Principal.SecurityIdentifier])

  # ---- (d) grant read/write on exactly TargetFolder  - never broader ----
  $acl = Get-Acl -LiteralPath $TargetFolder
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $leasedSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $TargetFolder -AclObject $acl
  $aceGranted = $true
  Log "granted Modify to $($leasedSid.Value) ($leasedName) on $TargetFolder"

  # ---- (e) give this turn its own desktop and the window-station access to
  # reach it, or every USER32-importing InnerBin dies at 0xC0000142 before its
  # entry point (see the long WHY on New-SandboxDesktop). Two different
  # principals, deliberately: the WINDOW STATION is shared by every concurrent
  # turn, so its narrow ACE goes to the POOL GROUP (all 16 accounts are members;
  # one group ACE beats 16 identical ones); the DESKTOP belongs to this turn
  # alone, so its ACE goes to the LEASED ACCOUNT's SID only. Nothing whatsoever
  # is granted on WinSta0\Default, the operator's own desktop. ----
  $poolGroupSid = (New-Object System.Security.Principal.NTAccount($SandboxPoolGroup)).Translate([System.Security.Principal.SecurityIdentifier])
  $sandboxDesk = New-SandboxDesktop -DesktopName $leasedName -LeasedSid $leasedSid -PoolGroupSid $poolGroupSid
  $hSandboxDesk = $sandboxDesk.Handle

  # ---- (f, scrub pass) empty this account's scratch profile BEFORE InnerBin
  # runs, as the account itself - the only principal that can delete those files
  # without being an Administrator (see Clear-SandboxProfileContents). ON
  # ACQUIRE, deliberately: scrubbing on RELEASE would be skipped entirely
  # whenever a turn crashes or is killed, which is why there is none in the
  # finally block. Scrub-on-acquire is a clean start regardless of how the
  # previous turn ended. It needs the desktop from step (e) - powershell.exe
  # imports USER32 like any other InnerBin - which is why it runs here and not
  # earlier. ----
  Clear-SandboxProfileContents -AccountName $leasedName -Password $plainPwd -LpDesktop $sandboxDesk.LpDesktop

  # ---- (f) launch InnerBin AS the leased account, stdio proxied straight
  # through. CreateProcessWithLogonW does the logon itself from the name +
  # password, so there is no separate LogonUser step and no token handle to
  # own: it needs no privilege in THIS process (see the WHY at the top). ----
  # ---- (g, part 1) ...and wait for it, capturing its real exit code. Both the
  # launch and the wait live in Invoke-AsLeasedAccount, shared with the scrub
  # pass above. ----
  $finalExit = Invoke-AsLeasedAccount -AccountName $leasedName -Password $plainPwd `
    -Bin $InnerBin -BinArgs $InnerArgs `
    -WorkingDirectory $TargetFolder -LpDesktop $sandboxDesk.LpDesktop -Label 'launching' `
    -StdIn ([SandboxLogon]::GetStdHandle([SandboxLogon]::STD_INPUT_HANDLE)) `
    -StdOut ([SandboxLogon]::GetStdHandle([SandboxLogon]::STD_OUTPUT_HANDLE)) `
    -StdError ([SandboxLogon]::GetStdHandle([SandboxLogon]::STD_ERROR_HANDLE))
} finally {
  if ($plainPwd) { $plainPwd = $null }
  # A desktop dies once its last handle closes and no threads remain attached  -
  # and the inner process has already exited by now, so this close DESTROYS the
  # desktop. That is deliberate: the desktop is ephemeral by construction, which
  # is why there is no "revoke the desktop ACE" step anywhere in this script  -
  # the whole object, its DACL included, simply ceases to exist. Done BEFORE the
  # lease is released below, so no other turn can lease this account name while
  # a desktop named after it from THIS turn is still alive.
  if ($hSandboxDesk -ne [IntPtr]::Zero) { [SandboxLogon]::CloseDesktop($hSandboxDesk) | Out-Null }
  # NOTE: of the ACEs, only the per-turn FOLDER one is revoked here. The WINDOW
  # STATION ACE from step (e) is deliberately LEFT IN PLACE: it is granted to
  # the pool GROUP (not per-turn, not per-account) and is shared by every
  # concurrent turn, so revoking it here would race sessions still running. It
  # is volatile anyway  - winsta DACLs die with the logon session.
  # ---- (g, part 2) best-effort revoke the ACE  - never let cleanup failure
  # mask the inner process's own result. ----
  if ($aceGranted -and $leasedSid) {
    try {
      $acl2 = Get-Acl -LiteralPath $TargetFolder
      $acl2.PurgeAccessRules($leasedSid)
      Set-Acl -LiteralPath $TargetFolder -AclObject $acl2
      Log "revoked ACE for $($leasedSid.Value) ($leasedName) on $TargetFolder"
    } catch {
      Log "WARNING: could not revoke the ACE for $($leasedSid.Value) ($leasedName) on $TargetFolder  - $($_.Exception.Message)"
    }
  }
  # ---- (g, part 3) release the lease  - ACE revoke happens first (above),
  # so no other turn can claim this account while its ACE from THIS turn
  # might still be getting cleaned up. ----
  if ($lockStream) {
    try {
      $lockStream.Close()
    } catch {
      Log "WARNING: could not close lease lock stream for '$leasedName'  - $($_.Exception.Message)"
    }
    try {
      Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
    } catch {
      Log "WARNING: could not remove lease lock file $lockPath for '$leasedName'  - $($_.Exception.Message)"
    }
  }
}

exit $finalExit
