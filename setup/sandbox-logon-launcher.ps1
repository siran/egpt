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
#      turn - that open handle IS the lease, and a lock file NO process holds
#      open is stale and gets reclaimed in place - see the leasing block).
#      The pool is walked STICKILY: the account this conversation's own folder
#      hashes to is tried first and the rest follow in random order, so a
#      conversation keeps the same account across leases whenever it is free.
#   b) get that account's stored credential (DPAPI, operator-scoped).
#   c) resolve that account's own fixed user SID - always present in its own
#      token, unlike the broken per-call logon-session SID.
#   d) grant that SID a read/write (Modify) ACE on exactly TargetFolder -
#      never Everyone, never a parent dir - and one ACE on each shared path, if
#      any were passed: Modify for a -SharePath entry, ReadAndExecute for a
#      -SharePathReadOnly one, because a path a being declared read-only must be
#      read-only to the KERNEL and not only to Claude Code's own deny rules.
#      Still never broader: each is one named path.
#      THE DACL IS THEN READ BACK (see Assert-SandboxPathReachable): icacls
#      can exit 0 and write no ACE at all, and a grant nobody read back is a
#      promise, not a fact. A TargetFolder the leased SID cannot reach ends the
#      turn HERE, loudly, instead of at (f) as a Win32 267 nobody can explain.
#      Each is written into the lease lock file FIRST, as this lease's ACE
#      LEDGER, so that a turn killed before (g) can still be cleaned up: the
#      reclaim in (a) revokes whatever the dead turn's ledger names before that
#      account runs anything again. See sandbox-account.ps1's lease-ledger
#      block for why the lock file is the right place for that list.
#   e) create a PRIVATE per-turn desktop and grant that SID access to it (see
#      New-SandboxDesktop) - nothing on the operator's own WinSta0\Default.
#   f) the reachability of TargetFolder is verified ONCE MORE - the scrub pass
#      below is a whole logon round trip, and an ACE can go away in it - and
#      then CreateProcessWithLogonW launches AS that account, twice, through the
#      one shared Invoke-AsLeasedAccount helper: FIRST a short scrub pass that
#      empties the account's scratch profile and re-plants its junctions - `src`
#      onto the operator's read-only ~\src, and `egpt` onto THIS conversation's
#      TargetFolder (see Clear-SandboxProfileContents - it
#      must run as the account itself, which is the only principal that can
#      delete or create those files without being an Administrator), THEN InnerBin, with
#      the launcher's OWN stdio handles passed straight through
#      (STARTF_USESTDHANDLES) so the inner process's stdin/stdout/stderr ARE the
#      same pipes Node's child_process.spawn of THIS script sees. InnerBin's cwd
#      is that `egpt` MOUNT, never TargetFolder itself: a being quotes its cwd
#      into group chats, and the Room's own path names the operator and, in its
#      slug, the person the conversation is with. Every ACL above still names
#      TargetFolder - a junction is a name, the target's DACL is the fact.
#   g) wait for the inner process, destroy the desktop, best-effort revoke the
#      ACEs from (d), THEN release the lease (revoke before lock release, so no
#      other turn can claim this account while an ACE from THIS turn might still
#      be getting cleaned up), exit with the inner process's own exit code.
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
# PARAMS - ONE ARGV ELEMENT PER PARAMETER, AND THAT ELEMENT IS A JSON ARRAY.
# Every caller-supplied LIST (-InnerArgs, -SharePath, -SharePathReadOnly,
# -SetEnv) arrives as a SINGLE [string] holding a JSON array, which this script
# parses itself (see ConvertFrom-JsonArgv below). NOTHING A CALLER SUPPLIES IS
# EVER SEEN BY POWERSHELL'S PARAMETER BINDER AS A TOKEN, and that is the entire
# point: the binder is what broke all three of the following. All three were
# MEASURED on this machine 2026-09-05 against the previous param block, not
# theorised, and all three are ONE root cause.
#
# 1) THE BINDER ATE --verbose, AND THAT KILLED EVERY SANDBOXED ccode TURN.
#    [CmdletBinding()] enables PowerShell's COMMON parameters, and PowerShell
#    PREFIX-MATCHES them: the inner argv's own `--verbose` (claude-args.mjs's
#    BASE_ARGS) bound the common -Verbose SWITCH instead of reaching InnerArgs.
#    Observed, running the real launcher with the real claude argv:
#      VERBOSE: Perform operation 'Enumerate CimInstances' ...   <- OUR verbose stream, switched on by the caller's data
#      sandbox-logon-launcher: launching under egpt-sbx-06: claude.exe (+6 args)   <- 7 sent, 6 arrived
#      Error: When using --print, --output-format=stream-json requires --verbose
#    `claude --help` makes --verbose MANDATORY alongside
#    `--print --output-format stream-json`, so the turn died before the model on
#    EVERY sandboxed ccode turn. This is very likely the outage
#    ~/.egpt/config/config.yaml records against the `egpt` being ("don ran
#    OS-sandboxed and every turn died before the model"), and the reason the
#    handoffs concluded "a ccode being cannot be sandboxed".
#
# 2) A MULTI-VALUE PARAMETER SILENTLY CORRUPTED THE INNER ARGV. Through
#    `powershell.exe -File`, spawned by Node with one argv element per token:
#      -SharePath A B            -> SharePath=@('A')   InnerArgs=@('B','--print',...)
#      -SetEnv X=1 Y=2           -> SetEnv=@('X=1')    InnerArgs=@('Y=2','--print',...)
#      -SharePath A,B            -> SharePath=@('A,B')  - ONE literal string; PS 5.1
#                                   does not re-parse an argv element into an array
#      -SharePath A -SharePath B -> hard error, ParameterAlreadyBound
#    PositionalBinding = $false did NOT fix this. It stopped the spill hitting the
#    next NAMED parameter and made it land in the inner argv instead - which is
#    WORSE, because it is silent.
#
# 3) AN EMPTY ARGV ELEMENT BROKE BINDING. claude-args.mjs pushes the PAIR
#    `--setting-sources` '' - the EMPTY string IS the value, and it is what stops
#    a sandboxed being inheriting the operator's personal ~/.claude (above all
#    its MCP servers). It was papered over with [AllowEmptyString()] on the two
#    parameters the binder saw.
#
# THE FIX IS THE SAME ONE FIX FOR ALL THREE: caller data no longer reaches the
# binder. `-InnerArgs '["--print","--output-format","stream-json","--verbose"]'`
# is ONE token; it is not a flag, it is not empty, and it is not a second value.
#
# NOT -Command, deliberately. That would ADD a PowerShell re-parse of the whole
# command string (a quoting bug there is arbitrary code execution, not merely a
# corrupted argv), and it would not have fixed (1) anyway - the script still
# binds parameters either way.
#
# ONE WAY TO INVOKE. The parameter NAMES are unchanged:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File sandbox-logon-launcher.ps1 `
#     -TargetFolder <dir> [-SharePath '["<dir>","<dir>"]'] `
#     [-SharePathReadOnly '["<dir>"]'] [-SetEnv '["NAME=VALUE"]'] `
#     -InnerBin <absolute exe> -InnerArgs '["--print","--verbose",""]'
# src/sandbox-cli-session.mjs's sandboxSpawn is THE one builder of that argv and
# it JSON.stringify()s every one of them. There is no second shape to support.
#
# WHAT SURVIVED THE REWRITE, and why - the two attributes the old shape needed:
#  - PositionalBinding = $false: KEPT, but it now guards something DIFFERENT and
#    much smaller. No parameter takes remaining arguments any more, so a stray
#    token has nowhere to be swept - but with positional binding ON it would
#    silently bind BY POSITION to $TargetFolder/$InnerBin/$InnerArgs (a
#    PowerShell parameter declared with no explicit Position is positional by
#    default). Off, the same stray token is a loud "A positional parameter cannot
#    be found that accepts argument ...". Cheap, and it turns a silent misbind
#    into a crash.
#  - [AllowEmptyString()] ON THESE PARAMETERS: REMOVED - it is now dead. It
#    existed because a [string[]] bound the inner argv ELEMENT BY ELEMENT and one
#    element was ''. The inner argv is a single JSON string now; the empty element
#    lives INSIDE it and the binder never sees it. The attribute is still
#    LOAD-BEARING further down this file - on Invoke-AsLeasedAccount's -BinArgs,
#    on New-SandboxEnvironmentBlock's -SetEnv, and on Set-EnvBlockEntry's -Value -
#    because those three receive the PARSED arrays, empty elements and all, and
#    are Mandatory. Do not "clean up" those.
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)][string]$TargetFolder,
  [Parameter(Mandatory = $true)][string]$InnerBin,
  # A JSON array of strings: the inner argv, verbatim, one element each.
  # NOT Mandatory on purpose. A missing Mandatory parameter PROMPTS, and this
  # script is spawned by a daemon with no console attached - it would hang for
  # ever instead of failing. The explicit guard below throws instead, loudly and
  # immediately.
  [string]$InnerArgs = '',
  # ---- OPTIONAL. '' (this default) and '[]' both mean "no entries", so with
  # neither flag passed this script does exactly what it did before they existed:
  # no extra ACL write, and no environment block built at all.
  [string]$SharePath = '',
  # THE SAME THING, READ-ONLY (operator 2026-09-13). Each entry gets a
  # ReadAndExecute ACE instead of -SharePath's Modify, and step (d2) below is one
  # loop over both classes. A being's `allowed_paths` already classifies every
  # declared path (brainpool.mjs's allowedPathsFor: a grant naming no write-class
  # tool is read-only), and the two classes used to arrive here CONCATENATED into
  # -SharePath - so a read-only path got a WRITE-capable ACE and, for a being
  # holding Bash or PowerShell, "read-only" meant nothing below the CLI layer.
  #
  # A SECOND FLAG, not objects inside -SharePath: ConvertFrom-JsonArgv below is
  # the ONE parser for every list here and it means "a JSON array of STRINGS".
  # Teaching it a second element type would put a union at the exact boundary
  # whose entire purpose is that nothing a caller sends is ever interpreted. The
  # default keeps every existing caller byte-identical: no entries, no read-only
  # pass, no ACL write.
  [string]$SharePathReadOnly = '',
  # A JSON array of NAME=VALUE strings. A VALUE may legitimately be empty
  # ("FOO="); it lives inside the JSON, so nothing out here has to allow for it.
  [string]$SetEnv = ''
)

$ErrorActionPreference = 'Stop'

# Account-provisioning constants/functions ($SandboxPoolSize,
# $SandboxPoolPrefix, $CredDir, Log, New-RandomPassword, Get-SandboxCredential,
# Get-SandboxPoolAccountNames, Ensure-SandboxPool) live in sandbox-account.ps1,
# shared with provision-sandbox-account.ps1's self-elevating one-time setup.
. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

# ---- THE ONE PARSER for the JSON-array parameters (see PARAMS above).
# Four consumers, ONE implementation: -InnerArgs, -SharePath, -SharePathReadOnly
# and -SetEnv all mean "a JSON array of strings" and must fail identically when
# they are not one.
#
# PS 5.1 TRAP, and this repo has been bitten by it before, so it is spelled out
# rather than trusted to memory. ConvertFrom-Json on a TOP-LEVEL ARRAY writes the
# WHOLE ARRAY as ONE object to the pipeline, so `@(ConvertFrom-Json $raw)` is a
# ONE-ELEMENT array whose single element is the array. MEASURED on this box:
#   $raw            @(ConvertFrom-Json $raw).Count   $p = ConvertFrom-Json $raw; @($p).Count
#   []                           1                                 0
#   ["a"]                        1                                 1
#   ["a","","b"]                 1                                 3
#   [""]                         1                                 1  (one EMPTY element)
# ASSIGN FIRST, THEN WRAP. That is exactly what this function does, and the only
# reason $parsed exists as its own variable.
#
# ANYTHING MALFORMED THROWS, naming the parameter. Never a silent empty array: a
# silently-empty -InnerArgs is the precise class of failure this whole contract
# exists to end.
function ConvertFrom-JsonArgv {
  param(
    [Parameter(Mandatory = $true)][string]$ParamName,
    # AllowEmptyString because '' is THIS SCRIPT'S OWN default for the optional
    # parameters and means "no entries" - it is not caller data. A caller that
    # means the same thing sends '[]'.
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Raw
  )
  if ([string]::IsNullOrWhiteSpace($Raw)) { return ,@() }
  $parsed = $null
  try {
    $parsed = ConvertFrom-Json $Raw
  } catch {
    throw "sandbox-logon-launcher: -$ParamName is not valid JSON  - $($_.Exception.Message). Received: $Raw"
  }
  # `$null -eq $parsed`, NOT `$parsed -eq $null`: with an array on the left the
  # latter is an ELEMENT-WISE filter that returns an array, not a boolean.
  if ($null -eq $parsed -or $parsed -isnot [System.Object[]]) {
    throw "sandbox-logon-launcher: -$ParamName must be a JSON ARRAY of strings, e.g. [`"--print`",`"`"]  - received: $Raw"
  }
  $arr = @($parsed)
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($e in $arr) {
    if ($null -ne $e -and $e -isnot [string]) {
      throw "sandbox-logon-launcher: -$ParamName element $($out.Count) is not a string (got $($e.GetType().Name))  - received: $Raw"
    }
    [void]$out.Add([string]$e)
  }
  # The leading comma stops PowerShell unrolling the array on the way out: an
  # empty one would otherwise come back as $null and a one-element one as a bare
  # string, which is the same shape bug in a different costume.
  return ,$out.ToArray()
}

# Parsed ONCE, here, into the arrays the rest of this script already
# expects. Every use below is unchanged from when these were [string[]]
# parameters - the ONLY difference is that PowerShell's parameter binder never
# saw the contents.
$InnerArgsList = ConvertFrom-JsonArgv -ParamName 'InnerArgs' -Raw $InnerArgs
$SharePathList = ConvertFrom-JsonArgv -ParamName 'SharePath' -Raw $SharePath
$SharePathReadOnlyList = ConvertFrom-JsonArgv -ParamName 'SharePathReadOnly' -Raw $SharePathReadOnly
$SetEnvList    = ConvertFrom-JsonArgv -ParamName 'SetEnv'    -Raw $SetEnv

if (-not (Test-Path -LiteralPath $TargetFolder -PathType Container)) {
  throw "sandbox-logon-launcher: TargetFolder does not exist or is not a directory: $TargetFolder"
}
if ($InnerArgsList.Count -eq 0) {
  throw "sandbox-logon-launcher: -InnerArgs parsed to an empty array  - nothing to run. It must be a JSON array of the inner argv, one element per token."
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

    // ---- per-spawn environment (see New-SandboxEnvironmentBlock) ----
    // NOT optional whenever a block is actually passed: lpEnvironment is read as
    // ANSI unless this flag is set, so a UTF-16 block without it reaches the
    // child as garbage. Only ever OR'd in on the -SetEnv path.
    public const int CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    // The LOGON32_* pair that lived here went with the second logon (2026-09-23).

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

    // ---- the two below exist ONLY to build a per-spawn environment block,
    // i.e. only on the -SetEnv path; with no -SetEnv neither is ever called and
    // lpEnvironment above stays NULL exactly as before.
    //
    // THERE IS NO LogonUser HERE ANY MORE (2026-09-23). It existed to render a
    // block FROM THAT USER'S OWN TOKEN, and that is precisely what failed in
    // production with ERROR_ACCESS_DENIED whenever the account's hive happened
    // to be loaded: rendering a loaded hive means reading HKEY_USERS\<their
    // SID>, which an unelevated caller may not do and may not impersonate its
    // way into. Every name that token contributed is derived instead in
    // New-SandboxEnvironmentBlock's rebase - see NO SECOND LOGON there for the
    // measurements and for the one name (SESSIONNAME) that is genuinely gone.
    // Do not reintroduce it: it cannot produce anything the rebase does not.
    //
    // userenv.dll, not kernel32. Called with hToken = NULL, which renders the
    // SYSTEM variables and touches no user hive at all. bInherit=false means
    // "do not fold the CALLING process's environment in", which is the single
    // most load-bearing argument in this whole feature; see THE TRAP in
    // New-SandboxEnvironmentBlock.
    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

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

function Get-SandboxProfilePath {
  # THE one place in this script that answers "where does this pool account's
  # Windows profile live". TWO callers need that answer and they must never be
  # able to disagree: Clear-SandboxProfileContents (which deletes everything
  # under it) and New-SandboxEnvironmentBlock (which points a -SetEnv child's
  # USERPROFILE/APPDATA/LOCALAPPDATA/TEMP at it). A second derivation - even an
  # identical-looking copy - would be a second thing to keep correct, and the
  # guards below are the whole reason this is safe at all.
  #
  # Returns the profile's LocalPath, or $null when this account HAS no profile
  # yet - a normal state, not an error: the pool is provisioned before any
  # profile exists, and a profile directory is only materialised by the first
  # LOGON_WITH_PROFILE launch on that account. Every OTHER unexpected shape
  # THROWS rather than guessing.
  #
  # Resolve the NAME to a SID and select the profile BY SID  - never by matching
  # path strings, which a lookalike directory name could fool. Win32_UserProfile
  # is READABLE unelevated (verified 2026-08-26); only Remove-CimInstance on one
  # needed the privilege we no longer have.
  param(
    [Parameter(Mandatory = $true)][string]$AccountName
  )
  # ---- GUARD 1 (pool prefix): checked FIRST, before a SID is even resolved, so
  # that nothing reachable from here can target 'an', 'Administrator' or any
  # other non-pool account even if this is called wrongly.
  if (-not $AccountName.StartsWith($SandboxPoolPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "sandbox-logon-launcher: refusing to resolve the profile path of '$AccountName'  - it is not a sandbox pool account (its name must start with '$SandboxPoolPrefix')"
  }

  try {
    $sid = (New-Object System.Security.Principal.NTAccount($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
  } catch {
    # The account does not exist yet (first-ever use on this node  - the pool is
    # created lazily by Get-SandboxCredential later in the launcher's flow). No
    # account means no profile.
    Log "no profile for '$AccountName'  - the account does not resolve to a SID ($($_.Exception.Message))"
    return $null
  }

  $found = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
    Where-Object { $_.SID -eq $sid.Value })

  # NORMAL CASE, not an error: first-ever use of this account, no profile
  # directory yet. $null, and each caller decides what that means for it.
  if ($found.Count -eq 0) { return $null }
  # ---- GUARD 2 (exactly one match): a SID matching several profiles means
  # something is wrong that this script is not equipped to reason about.
  if ($found.Count -gt 1) {
    throw "sandbox-logon-launcher: refusing to use the profile of '$AccountName'  - $($found.Count) Win32_UserProfile entries match SID $($sid.Value)"
  }
  $candidate = $found[0]
  # ---- GUARD 3 (not a system profile).
  if ($candidate.Special) {
    throw "sandbox-logon-launcher: refusing to use the profile of '$AccountName' (SID $($sid.Value))  - it is flagged Special, i.e. a system profile"
  }
  # ---- GUARD 4 (independent path check): the SID lookup above and this leaf
  # comparison must AGREE. Deliberately redundant with GUARD 1.
  if ([string]::IsNullOrWhiteSpace($candidate.LocalPath)) {
    throw "sandbox-logon-launcher: refusing to use the profile of '$AccountName' (SID $($sid.Value))  - its Win32_UserProfile entry has no LocalPath"
  }
  $leaf = Split-Path -Path $candidate.LocalPath -Leaf
  if ($leaf -ne $AccountName) {
    throw "sandbox-logon-launcher: refusing to use the profile of '$AccountName' (SID $($sid.Value))  - it lives at '$($candidate.LocalPath)', whose leaf '$leaf' is not the account name"
  }
  return $candidate.LocalPath
}

function Set-EnvBlockEntry {
  # Upsert ONE NAME=VALUE into an environment block's entry list, IN PLACE
  # ($Entries is a List, i.e. a reference - the caller sees the change).
  #
  # Windows wants an environment block sorted by NAME, case-insensitively, and
  # CreateEnvironmentBlock hands one back already sorted that way (verified
  # 2026-09-05 on this machine, 52 entries, in order). So a name that ALREADY
  # exists is replaced IN PLACE - which keeps the ordering intact for free - and
  # a genuinely new name is INSERTED at its sorted position rather than
  # appended, because appending would be the one move that breaks the ordering
  # the API just established.
  #
  # BOTH overlays in New-SandboxEnvironmentBlock go through here - the leased
  # account's own per-user variables and the caller's -SetEnv pairs - so there
  # is exactly one implementation of "put this name in the block".
  #
  # NEVER logs anything: a -SetEnv VALUE is expected to BE a credential.
  param(
    # AllowEmptyCollection: a Mandatory collection parameter is rejected by the
    # BINDER when it is empty, and "the block had no entries" must surface as
    # whatever the caller makes of it, not as a binding exception here.
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Entries,
    [Parameter(Mandatory = $true)][string]$Name,
    # A value may legitimately be the empty string ("FOO="), which a Mandatory
    # [string] would reject in the binder - same attribute, same reason, as
    # -InnerArgs and -BinArgs elsewhere in this file.
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
  )
  $pair = "$Name=$Value"
  $at = -1
  for ($i = 0; $i -lt $Entries.Count; $i++) {
    if ($Entries[$i].StartsWith("$Name=", [System.StringComparison]::OrdinalIgnoreCase)) { $at = $i; break }
  }
  if ($at -ge 0) {
    $Entries[$at] = $pair
    return
  }
  $ins = $Entries.Count
  for ($i = 0; $i -lt $Entries.Count; $i++) {
    $cur = $Entries[$i]
    $cut = $cur.IndexOf('=')
    $curName = if ($cut -gt 0) { $cur.Substring(0, $cut) } else { $cur }
    if ([string]::Compare($curName, $Name, [System.StringComparison]::OrdinalIgnoreCase) -gt 0) { $ins = $i; break }
  }
  $Entries.Insert($ins, $pair)
}

function New-SandboxEnvironmentBlock {
  # Build the environment block a spawned child will get: THE LEASED ACCOUNT'S
  # OWN environment, with $SetEnv's NAME=VALUE pairs laid over it. Returns
  # @{ Ptr; Names }. The CALLER owns Ptr and must FreeHGlobal it (see
  # Invoke-AsLeasedAccount, which does it in a finally the moment
  # CreateProcessWithLogonW returns).
  #
  # WHY THIS EXISTS AT ALL: with lpEnvironment NULL the child simply inherits
  # the pool account's default environment and NOTHING can be handed to it per
  # spawn. provision-sandbox-account.ps1 records the cost of that in its own
  # comments - PI_CODING_AGENT_DIR had to be set at MACHINE scope, redirecting
  # every pi on the box including the operator's own terminal, purely because
  # "the launcher passes lpEnvironment = NULL - so it cannot be per-spawn". The
  # target case here is a per-turn CREDENTIAL (CLAUDE_CODE_OAUTH_TOKEN) that
  # must reach exactly one child and be persisted NOWHERE: not on disk, not in a
  # machine-wide variable, not in this launcher's own environment.
  #
  # THE TRAP, and the reason this is forty lines rather than four: lpEnvironment
  # REPLACES the child's entire environment - it does not merge into it. So the
  # obvious shape (copy $env:*, add the extras, pass that) is WRONG in the one
  # way that matters: the child would get the OPERATOR'S USERPROFILE, APPDATA,
  # TEMP and PATH, i.e. a pool account running pointed at the operator's own
  # profile. That is precisely the isolation this entire script exists to
  # create. Do NOT "simplify" it that way. The block is built from the MACHINE's
  # own environment and then rebased onto the leased account's real profile:
  #     CreateEnvironmentBlock(NULL) -> the system variables, no user in them
  #     the REBASE below             -> every per-user name, from that account's
  #                                     own profile path
  # and only then are $SetEnv's pairs overlaid on the result. There is NO second
  # logon here any more; see NO SECOND LOGON below for what removed it.
  #
  # THE GAP THAT WAS ONCE ONLY SUSPECTED HERE IS REAL, AND IS FIXED BELOW.
  # MEASURED 2026-09-05 by running this launcher: same account, same inner
  # command, ONLY -SetEnv differing.
  #                 USERPROFILE                TEMP
  #   no -SetEnv    C:\Users\egpt-sbx-NN       the account's own
  #   with -SetEnv  C:\Users\Default           C:\WINDOWS\TEMP
  # CAUSE: CreateProcessWithLogonW with LOGON_WITH_PROFILE loads the account's
  # hive and derives those names ITSELF - but ONLY while lpEnvironment is NULL.
  # The moment a block is supplied, THE BLOCK WINS and seclogon derives nothing.
  # And the token minted here is a SEPARATE logon whose profile hive is NOT
  # loaded, so CreateEnvironmentBlock falls back to the DEFAULT profile.
  # CONSEQUENCE while it was unfixed: a `claude` launched this way looked for
  # ~/.claude under C:\Users\Default, i.e. -SetEnv - the whole mechanism for
  # handing a turn a credential without persisting it - was unusable.
  # THE FIX (see the REBASE block below): overlay the per-user names onto the
  # block after CreateEnvironmentBlock returns, exactly the way the -SetEnv
  # names are overlaid, deriving them from the account's REAL profile path via
  # Get-SandboxProfilePath.
  # NOT LoadUserProfile, the obvious-looking alternative: it requires
  # SE_RESTORE_NAME and SE_BACKUP_NAME in the CALLER, and this launcher's entire
  # premise (see the top of the file) is that it needs NO privilege in the
  # caller - which is exactly why CreateProcessWithLogonW was chosen over both
  # token-based APIs in the first place. Neither privilege is among the five an
  # unelevated logon keeps, which this file's header already records from a
  # `whoami /priv` on the real token (SeShutdown, SeChangeNotify, SeUndock,
  # SeIncreaseWorkingSet, SeTimeZone).
  # A WARNING TO WHOEVER TESTS THIS NEXT, measured 2026-09-05 the hard way: the
  # defect above REPRODUCES ONLY WITHOUT those two privileges. The same -SetEnv
  # launch, same account, minutes apart, run from an ELEVATED shell - which DOES
  # hold SeBackup/SeRestore - came out with the RIGHT USERPROFILE, because
  # userenv could load the hive itself. An elevated test therefore cannot see
  # this bug at all; the runs that found it were made from a token cut down to
  # exactly those five privileges. The rebase below needs none of that either
  # way: it is string math over a block we already have.
  #
  # ---- NO SECOND LOGON. hToken IS NULL, DELIBERATELY (2026-09-23).
  #
  # THE LIVE FAILURE THAT ENDED IT. Turns died, on a DIFFERENT pool account each
  # time (egpt-sbx-12 09-23 07:44, then -05, then -08 at 12:35), with:
  #   sandbox-logon-launcher: CreateEnvironmentBlock for 'egpt-sbx-08' failed,
  #   Win32 error 5
  # 5 is ERROR_ACCESS_DENIED, and it is raised INSIDE userenv, not by us.
  #
  # WHY. CreateEnvironmentBlock(hToken) renders that user's variables, and once
  # the user's hive is LOADED it must read HKEY_USERS\<their SID>. That key is
  # granted to the user, SYSTEM and Administrators - and this launcher runs as
  # the operator, UNELEVATED, so its filtered token carries BUILTIN\Administrators
  # as a DENY-ONLY SID and is not an effective administrator at all. Reading
  # another account's loaded hive from here is ACCESS_DENIED, and reaching it the
  # two legitimate ways is barred by the same premise the whole file rests on:
  # impersonating that token needs SeImpersonatePrivilege and loading the hive
  # needs SeBackup/SeRestore, and the five privileges listed above are all there
  # are. MEASURED on reve 2026-09-23, unelevated, read-only:
  #   HKU\S-1-5-21-...-1013 (= reve\egpt-sbx-09, hive loaded at that moment)
  #     -> "Requested registry access is not allowed"
  #   the operator's OWN hive, same call  -> opened, 6 values
  # So the outcome depended entirely on whether that account's hive happened to
  # be loaded: not loaded, userenv fell back to the DEFAULT profile and the call
  # SUCCEEDED (which is exactly the C:\Users\Default measurement above); loaded,
  # ACCESS_DENIED and the turn died. The scrub pass is a LOGON_WITH_PROFILE logon
  # as that same account moments earlier and its hive unload is not instant, so
  # this fired at random, on whichever account a turn had leased.
  #
  # WHY NULL IS NOT A DOWNGRADE. With hToken NULL the call returns the SYSTEM
  # variables only - and every per-user name it does carry is already one the
  # REBASE below overwrites. MEASURED on reve 2026-09-23, the NULL block against
  # a real user token's block: NULL carried 29 entries, all of them also in the
  # token block; the token block's extra 11 were APPDATA, HOMEDRIVE, HOMEPATH,
  # LOCALAPPDATA, USERDOMAIN (all rebased below), LOGONSERVER and
  # USERDOMAIN_ROAMINGPROFILE (now rebased below too - for a LOCAL account both
  # are this machine's own name, which is how USERDOMAIN was already derived),
  # SESSIONNAME, and three values out of that user's own HKCU\Environment. The
  # three NULL carries with a user in them - USERPROFILE=C:\Users\Default,
  # USERNAME=SYSTEM, TEMP/TMP=C:\WINDOWS\TEMP - are all rebased.
  # SO THE CHILD DIFFERS BY EXACTLY ONE NAME: SESSIONNAME, which is not
  # derivable here and is deliberately NOT invented. And it no longer inherits
  # the leased account's HKCU\Environment, which is a GAIN: that hive survives
  # the scrub by design ("KNOWN RESIDUE, accepted"), so a `setx` by one
  # conversation used to reach the next one through this block.
  #
  # AND NO FALLBACK. There is no "try the token, fall back to NULL" here: the
  # token path cannot produce anything this one does not, so a second path would
  # be a second thing to go wrong and a per-turn coin flip over which
  # environment a being got.
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    # NO -Password. Nothing here authenticates any more, so the credential is not
    # passed to this function at all - one fewer place a per-turn password
    # exists. Invoke-AsLeasedAccount still holds it for CreateProcessWithLogonW.
    # AllowEmptyString for the same reason as -BinArgs below: a Mandatory
    # [string[]] rejects an empty element in the BINDER, and a malformed pair
    # should come back as this function's own explicit error, not as a
    # parameter-binding exception the caller cannot act on.
    [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$SetEnv,
    # THE CHILD'S CWD, and the ONLY input here that is not derived from the
    # account. It is threaded from Invoke-AsLeasedAccount's own
    # -WorkingDirectory - the very variable CreateProcessWithLogonW is handed,
    # in the same call frame - so the PWD row below cannot disagree with the
    # directory the process actually starts in.
    # NOT RECOMPUTED HERE as "$profilePath\egpt", which would look identical and
    # be a second derivation of one path: the mount is planted by the scrub pass,
    # which is the only thing that CAN plant it (it runs as the leased account),
    # and Clear-SandboxProfileContents returns the value it planted for exactly
    # this reason. Mandatory, so a caller that forgets fails in the binder rather
    # than shipping a child with no PWD at all.
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  $block = [IntPtr]::Zero
  try {
    # hToken = NULL: the SYSTEM variables, rendered without reading any user's
    # hive, so nothing here can be ACCESS_DENIED by one (see NO SECOND LOGON).
    # bInherit = $false. See THE TRAP: $true would fold THIS process's (the
    # operator's) environment into the result.
    if (-not [SandboxLogon]::CreateEnvironmentBlock([ref]$block, [IntPtr]::Zero, $false)) {
      throw "sandbox-logon-launcher: CreateEnvironmentBlock (system variables, no user token) for '$AccountName' failed, Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }

    # ---- read it. An environment block is NUL-terminated UTF-16 "NAME=VALUE"
    # runs back to back, with one EXTRA NUL closing the whole block.
    # PtrToStringUni stops at the first NUL, so the walker advances by the
    # string it just read plus its terminator, and an empty read means it hit
    # the block's own final NUL, i.e. the end.
    $entries = New-Object System.Collections.Generic.List[string]
    $off = 0
    while ($true) {
      $s = [Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($block, $off))
      if ([string]::IsNullOrEmpty($s)) { break }
      [void]$entries.Add($s)
      $off += ($s.Length + 1) * 2   # +1 for the NUL, *2 because these are WCHARs
    }

    # ---- REBASE the block on the account's REAL profile. This is the fix for
    # the measured defect written up above the param block: everything
    # CreateEnvironmentBlock derived from an unloaded hive points at
    # C:\Users\Default, and lpEnvironment is authoritative, so whatever is wrong
    # here is what the child gets. Only the PER-USER names can be wrong - the
    # rest of the block (PATH, ProgramFiles, SystemRoot, ...) is machine-wide
    # and identical either way - so exactly those are rewritten:
    #   USERPROFILE APPDATA LOCALAPPDATA TEMP TMP HOMEDRIVE HOMEPATH
    #   USERNAME USERDOMAIN
    # DERIVED FROM THE PROFILE PATH, never by string-guessing "C:\Users\<name>":
    # Get-SandboxProfilePath is the same SID-based lookup, with the same four
    # guards, that the scrub uses - and the scrub then cross-checks that answer
    # from INSIDE the account (it refuses unless the child's own
    # $env:USERPROFILE equals the path it was handed), so the value this rebases
    # onto is known-good rather than merely plausible.
    $profilePath = Get-SandboxProfilePath -AccountName $AccountName
    if (-not $profilePath) {
      # No profile directory yet, i.e. this account has never been launched on
      # this node. REFUSE rather than ship the Default-profile block that the
      # whole rebase exists to prevent: a child silently pointed at
      # C:\Users\Default is the exact failure this is fixing, and a loud, one-
      # line-fix error beats a turn that half-works. Any single launch on this
      # account WITHOUT -SetEnv materialises the profile (LOGON_WITH_PROFILE
      # does it), after which this path is resolvable forever.
      throw "sandbox-logon-launcher: refusing to build a -SetEnv environment block for '$AccountName'  - it has no Win32_UserProfile entry yet, so there is no profile path to point USERPROFILE/APPDATA/LOCALAPPDATA/TEMP at and the child would silently get the DEFAULT profile. Run one turn on this account without -SetEnv first (any LOGON_WITH_PROFILE launch creates the profile)."
    }
    # ---- THE CWD MUST BE INSIDE THIS ACCOUNT'S OWN PROFILE, i.e. the `egpt`
    # mount and never the Room it points at. The PWD row below is echoed
    # VERBATIM by the being's shell (measured 2026-09-23), so a -WorkingDirectory
    # that named the Room would put the operator's username and the conversation
    # slug straight back into the group chat - the exact disclosure the mount
    # exists to close, arriving through an environment variable instead of
    # through a cwd. Both sides of this comparison come from ONE derivation:
    # Get-SandboxProfilePath above, and Clear-SandboxProfileContents' own
    # `Join-Path $profilePath 'egpt'` off the same function. So it cannot fire on
    # the shipped path at all; it fires for a NEW caller, loudly, before the
    # child is spawned rather than after a path has been read out in a chat.
    if (-not $WorkingDirectory.StartsWith("$profilePath\", [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "sandbox-logon-launcher: refusing to build a -SetEnv environment block for '$AccountName' with a working directory of '$WorkingDirectory'  - it is not inside that account's own profile at '$profilePath', so PWD would name a directory outside the sandbox mount. A being's shell echoes PWD verbatim, so that path is what it quotes into the conversation; the mount ('$profilePath\egpt') is the only cwd this may be."
    }
    $localAppData = Join-Path $profilePath 'AppData\Local'
    $userTemp = Join-Path $localAppData 'Temp'
    # 'C:' from 'C:\Users\egpt-sbx-NN\', so HOMEDRIVE/HOMEPATH re-concatenate to
    # exactly USERPROFILE, which is what Windows itself guarantees about them.
    $homeDrive = [System.IO.Path]::GetPathRoot($profilePath).TrimEnd('\')
    # ---- THE PWD ROW (2026-09-23), the one entry in the table below that is
    # NOT derived from the profile. It is the cwd, and it lives in that table
    # rather than in a second overlay because this is the ONE place a -SetEnv
    # child's environment is written; a second overlay would be a second thing
    # to keep correct.
    #
    # WHY IT IS NEEDED AT ALL. The `egpt` mount already works at the OS level:
    # bash does NOT resolve a junction cwd, and with PWD unset it reports the
    # junction. The leak is one layer up - CLAUDE CODE RESOLVES ITS OWN CWD AT
    # STARTUP and hands its Bash tool the resolved path - so a being asked to run
    # `pwd` in a group chat answered with the ROOM,
    # /c/Users/an/.egpt/conversations/whatsapp/<slug>, naming the operator and,
    # in the slug, the person the conversation is with. An INHERITED PWD
    # overrides that resolution and is the only lever that does.
    #
    # THE FORM IS MSYS, AND IT WAS MEASURED RATHER THAN CHOSEN. Each consumer
    # spawned with its cwd on a real junction, three PWD values, 2026-09-23:
    #   unset          bash prints the junction; claude.exe prints the TARGET
    #   windows form   ECHOED VERBATIM, and bash renders it C:\...\tmp/x/link -
    #                  MIXED separators, worse than doing nothing
    #   msys form      ECHOED VERBATIM by bash, and claude.exe's Bash tool
    #                  prints the same - /c/Users/egpt-sbx-NN/egpt, the mount
    # Both consumers agree, so there is one form and no trade-off to make.
    # Rendered by ConvertTo-MsysPath (sandbox-account.ps1), which mirrors
    # src\conversations-state.mjs's toMsysPath; the note there says why the rule
    # has to exist in two languages.
    #
    # AND IT CANNOT LIE ABOUT WHERE THE CHILD IS. bash VALIDATES an inherited
    # PWD against the directory it is really in (measured the same day: a bogus
    # value is discarded and `pwd` falls back to computing the junction), so a
    # wrong value costs nothing. What a wrong value CAN do is name a DIFFERENT
    # TRUE name for the same directory - the Room resolves as happily as the
    # mount does - which is exactly what the guard above refuses.
    $perUser = [ordered]@{
      USERPROFILE  = $profilePath
      APPDATA      = (Join-Path $profilePath 'AppData\Roaming')
      LOCALAPPDATA = $localAppData
      TEMP         = $userTemp
      TMP          = $userTemp
      HOMEDRIVE    = $homeDrive
      HOMEPATH     = $profilePath.Substring($homeDrive.Length)
      # The pool accounts are LOCAL (domain '.' at every logon call in this
      # file), so their USERDOMAIN is this machine's own name.
      USERNAME     = $AccountName
      USERDOMAIN   = [System.Environment]::MachineName
      # THE TWO THE REMOVED SECOND LOGON USED TO SUPPLY (2026-09-23), derived
      # the same way and for the same reason: a LOCAL account is authenticated
      # by this machine, so its logon server and roaming-profile domain are both
      # this machine. Listed so dropping the token costs the child nothing it
      # was getting - see NO SECOND LOGON for the one name that IS gone.
      USERDOMAIN_ROAMINGPROFILE = [System.Environment]::MachineName
      LOGONSERVER  = "\\$([System.Environment]::MachineName)"
      # The cwd, msys-rendered. NOT profile-derived - see THE PWD ROW above.
      PWD          = (ConvertTo-MsysPath $WorkingDirectory)
    }
    foreach ($n in $perUser.Keys) { Set-EnvBlockEntry -Entries $entries -Name $n -Value ([string]$perUser[$n]) }
    # Paths and an account name, never a secret - and the scrub already logs
    # this same profile path on every turn.
    Log "environment block for '$AccountName' rebased on its own profile at ${profilePath}: $($perUser.Keys -join ', ')"

    # ---- overlay $SetEnv, AFTER the rebase and deliberately so: a caller that
    # passes one of the names above by hand is being explicit and outranks our
    # derivation.
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($pair in $SetEnv) {
      $eq = $pair.IndexOf('=')
      # Only the FIRST '=' splits: a Win32 variable NAME cannot contain one, a
      # VALUE can contain anything (and may be empty, e.g. "FOO="). $eq -lt 1
      # therefore rejects both "no '=' at all" and a leading '=' (the "=C:"
      # drive-cwd form, which is never something a caller means to inject).
      if ($eq -lt 1) {
        throw "sandbox-logon-launcher: -SetEnv entry is not NAME=VALUE: '$pair'"
      }
      $name = $pair.Substring(0, $eq)
      [void]$names.Add($name)
      Set-EnvBlockEntry -Entries $entries -Name $name -Value $pair.Substring($eq + 1)
    }

    # ---- write it back out in exactly the shape it was read in, into memory we
    # own, and hand the caller the pointer.
    $sb = New-Object System.Text.StringBuilder
    foreach ($e in $entries) { [void]$sb.Append($e); [void]$sb.Append([char]0) }
    [void]$sb.Append([char]0)   # the block's own closing NUL
    $chars = $sb.ToString().ToCharArray()
    $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($chars.Length * 2)
    [Runtime.InteropServices.Marshal]::Copy($chars, 0, $ptr, $chars.Length)
    return [PSCustomObject]@{ Ptr = $ptr; Names = $names.ToArray() }
  } finally {
    # Released HERE and not by the caller: the block has already been copied into
    # our own HGlobal above. The caller therefore owns exactly one resource, Ptr
    # - which is the whole point of returning it alone. (There is no token to
    # close any more; see NO SECOND LOGON.)
    if ($block -ne [IntPtr]::Zero) { [SandboxLogon]::DestroyEnvironmentBlock($block) | Out-Null }
  }
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
    # THIS is the parameter that broke production, and the reason for the
    # attribute: Mandatory on a [string[]] validates EVERY ELEMENT as non-empty,
    # so one empty element rejects the whole array with
    #   Cannot bind argument to parameter 'BinArgs' because it is an empty string
    #   ParameterArgumentValidationErrorEmptyStringNotAllowed,sandbox-logon-launcher.ps1
    # and claude-args.mjs:123 always pushes one - the `--setting-sources` ''
    # pair, whose empty value is exactly what stops a sandboxed being inheriting
    # the operator's ~/.claude. Reproduced and fixed in isolation 2026-09-05:
    # Mandatory [string[]] throws on @('--setting-sources','',...), the same
    # parameter with [AllowEmptyString()] binds all six elements.
    # The failure mode is nasty because it is LATE and PARTIAL - by the time it
    # fires the lease is held and the folder ACE is granted, and only the launch
    # dies - so the symptom is a confined ccode being that cannot be sandboxed AT
    # ALL while every other part of the turn looks healthy. Do not "clean up"
    # this attribute; -InnerArgs at the top of the file carries the same one for
    # the same reason.
    [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$BinArgs,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$LpDesktop,
    [Parameter(Mandatory = $true)][string]$Label,
    [IntPtr]$StdIn = [IntPtr]::Zero,
    [IntPtr]$StdOut = [IntPtr]::Zero,
    [IntPtr]$StdError = [IntPtr]::Zero,
    # NAME=VALUE pairs to inject into THIS child's environment. Empty by default
    # and the default path is untouched: with none passed, no block is built,
    # lpEnvironment stays [IntPtr]::Zero and dwCreationFlags stays exactly
    # CREATE_NO_WINDOW - byte for byte the call that was here before.
    # NOT plumbed through from the scrub pass, deliberately; the argument for
    # that asymmetry is at the scrub's own call site in
    # Clear-SandboxProfileContents.
    [string[]]$SetEnv = @()
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

  # ---- per-spawn environment. NOTHING is built unless -SetEnv was actually
  # passed, so the ordinary path below still hands CreateProcessWithLogonW a
  # NULL lpEnvironment and the child gets the account's default environment from
  # seclogon, unchanged.
  # NAMES ONLY in the log, never values. A -SetEnv value is expected to BE a
  # credential - CLAUDE_CODE_OAUTH_TOKEN is the reason this exists - and Log
  # writes to the daemon's stderr, which is captured to
  # ~/.egpt/config/logs/daemon-startup-err.log and kept. A token in there would
  # outlive the turn it was minted for, which defeats the point of never
  # persisting it.
  $creationFlags = [SandboxLogon]::CREATE_NO_WINDOW
  $envBlock = [IntPtr]::Zero
  if ($SetEnv -and $SetEnv.Count -gt 0) {
    # -WorkingDirectory is passed on VERBATIM - the same variable, the same call
    # frame, the one CreateProcessWithLogonW gets below - so the child's PWD and
    # its real cwd are one value, not two that happen to agree.
    $envInfo = New-SandboxEnvironmentBlock -AccountName $AccountName -SetEnv $SetEnv -WorkingDirectory $WorkingDirectory
    $envBlock = $envInfo.Ptr
    $creationFlags = $creationFlags -bor [SandboxLogon]::CREATE_UNICODE_ENVIRONMENT
    Log "$Label under ${AccountName}: injecting $($envInfo.Names.Count) env var(s) into the child: $($envInfo.Names -join ', ') (names only - values are never logged)"
  }
  # lpApplicationName MUST be the resolved path, not $null (operator 2026-08-21):
  # leaving it null relies on the target account's own (unpredictable) PATH
  # search to resolve the first token of lpCommandLine, and empirically that
  # path (not a permissions issue) is what the ERROR_PATH_NOT_FOUND was about.
  # InnerBin must therefore always be a fully-resolved absolute path by the time
  # it reaches this script -- callers (sandbox-cli-session.mjs) are responsible
  # for that, same as any other CreateProcess-family caller.
  # Domain '.' = this machine's local account database; the pool accounts are
  # local, never domain.
  $werr = 0
  try {
    $ok = [SandboxLogon]::CreateProcessWithLogonW(
      $AccountName, '.', $Password, [SandboxLogon]::LOGON_WITH_PROFILE,
      $Bin, $cmdLine, $creationFlags,
      $envBlock, $WorkingDirectory, [ref]$si, [ref]$pi)
    # Captured INSIDE the try, immediately: the free in the finally must never
    # get a chance to come between a failure and the error code that explains it.
    if (-not $ok) { $werr = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  } finally {
    # Freed as soon as the call returns, success or failure, and NOT after the
    # wait: the kernel copies the environment block into the new process at
    # creation time, so nothing past this point ever reads it again. A finally
    # rather than a straight line so a throw here cannot leak it.
    if ($envBlock -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($envBlock) }
  }
  if (-not $ok) {
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
  # bug could destroy the operator's own. The guards in Get-SandboxProfilePath,
  # which is where the path this function deletes under now comes from, are
  # belt-and-braces and REFUSE (throw) rather than proceed - unchanged in
  # substance from the admin-only version this replaces - and the scrub itself
  # re-checks, INSIDE the child, that the path it was handed is its own
  # %USERPROFILE%.
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][string]$Password,
    [Parameter(Mandatory = $true)][string]$LpDesktop,
    # The durable Room this lease is for. Planted here as the `egpt` junction -
    # see Get-SandboxProfileJunctionStatement - and NOT used for anything else:
    # every ACL in this script still names the Room itself, never the mount.
    [Parameter(Mandatory = $true)][string]$RoomTarget
  )
  # RETURNS THE WORKING DIRECTORY THIS PASS PLANTED, or $null if it planted
  # none. That is the whole reason this stopped being a void hygiene step
  # (2026-09-23): the `egpt` junction IS the being's cwd, only this pass can
  # create it - it runs AS the account, the one principal that may write inside
  # that profile - so the cwd cannot be derived anywhere else without the two
  # drifting apart. A caller that gets $null has no sandboxed cwd and must
  # refuse the turn rather than fall back to the Room's own path, which is the
  # path this whole feature exists to keep out of a group chat.
  # WHERE: Get-SandboxProfilePath, which is the SINGLE derivation of a pool
  # account's profile path in this script and carries every guard this function
  # used to carry inline (pool-name prefix; exactly one Win32_UserProfile match
  # for the SID; not Special; non-empty LocalPath; leaf == account name). It is
  # shared with New-SandboxEnvironmentBlock, which must point a -SetEnv child's
  # USERPROFILE at the very same directory this pass empties - two copies of
  # this lookup would be two things to keep in agreement. The prefix guard still
  # runs before anything else can touch $AccountName, because this call is the
  # first statement in the function.
  $profilePath = Get-SandboxProfilePath -AccountName $AccountName
  # FIRST-EVER USE of this account (or an account that does not exist yet):
  # nothing to scrub and no profile directory to scrub it in, so the extra logon
  # is skipped. It used to be a plain "normal case" because step (f)'s own
  # LOGON_WITH_PROFILE creates the profile - but there is now nowhere to plant
  # `egpt`, so this returns $null and the caller refuses the turn. The remedy is
  # the one New-SandboxEnvironmentBlock already names for the same precondition:
  # one launch on this account materialises its profile for ever.
  if (-not $profilePath) { return $null }

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
  #    the log instead of having to be discovered by listing C:\Users. BEFORE the
  #    re-creation below, deliberately: that count is "what the wipe could not
  #    delete", and counting anything this pass then creates would make a healthy
  #    scrub and a stuck one report the same non-zero number.
  #  - RE-PLANT THE JUNCTIONS (operator 2026-09-20), see the WHY below.
  # Keep this SHORT: the whole command line must fit in 1024 characters, see
  # Invoke-AsLeasedAccount's BUDGET note. MEASURED 2026-09-20 with the real
  # values (profile C:\Users\egpt-sbx-07, target C:\Users\an\src): 677-character
  # script, 775-character command line with ONE junction. Every link rides a
  # single `foreach` statement for that reason - see
  # Get-SandboxProfileJunctionStatement, which owns the budget note and is the
  # only place any link is named. Retiring `my-code` (2026-09-23) took a whole
  # table row back out of this payload, which is about 34 characters of a margin
  # that was measured at roughly 40 with an 80-character conversation slug. The
  # only part that varies by node is the junction target, so a node whose
  # operator home is much longer than C:\Users\an is the one thing that could eat
  # what is left.
  #
  # `src` IS THE eGPT CHECKOUT, ~\src\egpt, READ-ONLY (operator 2026-09-23:
  # "dismiss mounting ~/src always, that was a faux-pas" and "in the same way
  # that the conversation directory is mounted in the sandbox account, the
  # src/egpt can also be mounted as src/"). It used to be the operator's WHOLE
  # ~\src, and the `my-code` link beside it was the checkout; one name now does
  # the job of both and the wider target is retired. See
  # Get-SandboxProfileJunctionStatement, which owns that decision.
  # Directory JUNCTIONS, which need no privilege to create (unlike a symlink) -
  # and they are only half the feature. The OTHER half is a STANDING
  # ReadAndExecute grant to the pool group on ~\src\egpt, written by
  # provision-sandbox-account.ps1, which carries the reasoning for why that one
  # is standing rather than per-turn. Without it this link is a directory the
  # being can see and cannot open.
  # NOTHING IS NEEDED AT THE CLI LAYER ANY MORE (operator ruling 2026-09-23:
  # "--permission-mode [should] be none at all. free roam inside the sandbox").
  # A sandboxed being's argv carries no `--add-dir` and no permission mode but
  # bypass, so there is no second gate to teach about this mount - see
  # src/claude-args.mjs, which holds that tier and the reasoning for it. Until
  # then the being needed `C:/Users/an/src` in its own `allowed_paths`, which put
  # the operator's username into every sandboxed being's argv; that is the leak
  # this ruling closed, and it closed it by removing the gate rather than by
  # renaming the path.
  #
  # WHY IT IS RE-PLANTED HERE RATHER THAN PROVISIONED ONCE. This scrub empties
  # the profile on every lease acquire, so anything the provisioner put in there
  # would survive exactly until the next turn. The link therefore belongs on the
  # acquire path, after the wipe, in the same child that does the wiping - the
  # only principal that can write inside that profile without being an
  # Administrator. No second logon, no second script, and NO EXEMPTION IN THE
  # SCRUB: the wipe stays total (Remove-Item takes a junction as a LINK, so the
  # operator's src is never walked), and what is rebuilt is one link to a
  # read-only tree, which carries nothing between conversations. Existing pool
  # accounts need no repair step - their next turn plants it.
  #
  # A missing convenience link must not cost the turn, and the provisioner
  # already says on its own run that the node has no ~\src to grant - see
  # Get-SandboxProfileJunctionStatement's -EA 0 note.
  #
  # THE BEING'S OWN HOME-LIKE FOLDERS ARE NOT HERE (operator ruling 2026-09-20,
  # revising the first cut of this): Desktop/Documents/Downloads in the pool
  # profile would be scratch - wiped every acquire, unreachable from the
  # conversation the being actually works in. They live in the CONVERSATION
  # folder instead, which is the being's cwd, is durable, and is the one place it
  # can write. See Room.treeDirs in src/room-core.mjs.
  $repoRoot = Join-Path (Join-Path $env:USERPROFILE 'src') 'egpt'
  $scrubScript = @(
    "`$r = '$profilePath'"
    "if (`$env:USERNAME -ne '$AccountName' -or `$env:USERPROFILE -ne `$r) { [Console]::Error.WriteLine('sandbox-logon-launcher: scrub REFUSED - running as ' + `$env:USERNAME + ' at ' + `$env:USERPROFILE); exit 11 }"
    "Get-ChildItem -LiteralPath `$r -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"
    "[Console]::Error.WriteLine('sandbox-logon-launcher: scrubbed ' + `$r + ', ' + @(Get-ChildItem -LiteralPath `$r -Force -Recurse -ErrorAction SilentlyContinue).Count + ' locked entries left')"
    (Get-SandboxProfileJunctionStatement -RepoRoot $repoRoot -RoomTarget $RoomTarget)
  ) -join '; '

  # IT STOPPED BEING PURELY HYGIENE when `egpt` joined the junction statement
  # (2026-09-23): this pass is the only thing that plants the being's working
  # directory, so a pass that did not finish leaves the turn with nowhere to run.
  # The WIPE half is still best-effort - every delete in the payload carries
  # -EA 0, so a locked hive does not fail it - which means a non-zero exit is
  # the child's own REFUSAL guard or a launch that never happened, and both of
  # those mean no junction. Either way this returns $null and the caller refuses
  # the turn, loudly, by name. Warnings go to stderr (stdout is the inner
  # process's stream-json pipe, see Log's comment).
  try {
    # stdin/stdout deliberately left NULL: this pass must not be able to touch
    # the stream-json pipes. Its stdout is pointed at the launcher's own STDERR
    # so that anything it prints - including the report line above - is a
    # diagnostic, never protocol. cwd is %SystemRoot%, a directory every account
    # can use; the scrub has no business in TargetFolder.
    #
    # NO -SetEnv HERE, and this function does not even take one - the asymmetry
    # is the decision, not an oversight. Invoke-AsLeasedAccount is shared so
    # that the two passes get the same LAUNCH MECHANICS (logon flags, desktop,
    # exit-code handling); it was never a promise that they get the same
    # PAYLOAD, which is why they already differ on stdio, cwd, bin and args. A
    # -SetEnv value is a credential meant for the inner CLI and for one turn. An
    # environment variable is readable by anything running as that same account
    # for the life of the process that holds it, so handing it to a second
    # process only widens where the token exists - and this second process is a
    # powershell.exe whose entire job is deleting files under one profile, which
    # has no use for it whatsoever. Least exposure beats uniformity. It also
    # keeps the scrub's launch byte-identical to what it was before -SetEnv
    # existed, so a bug in the environment-block path cannot take the hygiene
    # pass down with it.
    $errHandle = [SandboxLogon]::GetStdHandle([SandboxLogon]::STD_ERROR_HANDLE)
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $rc = Invoke-AsLeasedAccount -AccountName $AccountName -Password $Password `
      -Bin $psExe -BinArgs @('-NoProfile', '-NonInteractive', '-Command', $scrubScript) `
      -WorkingDirectory $env:SystemRoot -LpDesktop $LpDesktop -Label 'profile scrub' `
      -StdOut $errHandle -StdError $errHandle
    if ($rc -ne 0) {
      Log "WARNING: the scratch-profile scrub for '$AccountName' at $profilePath exited $rc, so its junctions were not planted and this turn has no working directory"
      return $null
    }
    # The mount the payload just planted, and the value the launch runs in.
    return (Join-Path $profilePath 'egpt')
  } catch {
    Log "WARNING: could not scrub the scratch profile for '$AccountName' at $profilePath  - $($_.Exception.Message) (so its junctions were not planted and this turn has no working directory)"
    return $null
  }
}

# ---- (a) lease one pool account. An atomic per-account lock file - the
# first caller to successfully create it with FileMode.CreateNew (atomic on
# NTFS) owns the lease. Every other concurrent caller gets an IOException
# (file already exists) and moves on to the next pool name. The open
# FileStream handle IS the lease; it stays open for the whole turn.
#
# WHAT "LEASED" MEANS, and why the file EXISTING is not it (bug found live
# 2026-08-26): release happens in the finally block at the bottom - close the
# stream, delete the file - and a HARD-killed turn (taskkill /F, crash, reboot)
# never runs it. The OS drops the file HANDLE, but the FILE survives, so
# CreateNew failed forever afterwards for that account and the name was starved
# PERMANENTLY. Measured on this machine: 14 lock files, 13 of which nothing
# held - the 16-account pool was down to 2 leasable names, two crashes from
# total exhaustion, silently.
#
# So the discriminator is NOT the file's existence and NOT its age (an
# `idle_ttl_by_class: conversation: -1` warm session never idle-evicts, so a
# LEGITIMATE lease can be days old): it is whether a LIVE HANDLE holds it.
# Opening a path with FileShare::None succeeds only when no other handle is
# open on it - and both opens below use FileShare::None (File.Open's 3-arg
# overload defaults to it), so the test is exact in both directions.
#
# RACE SAFETY: the successful exclusive open IS the reclaimed lease - the same
# $lockStream the whole turn holds and the same finally releases. It is
# deliberately NOT "open, close, re-CreateNew", which would reopen the very
# window it is testing. Two launchers racing the same stale lock both fail
# CreateNew and both attempt the exclusive open; the kernel's share-mode check
# is atomic, so exactly one gets a handle and the loser takes the IOException
# path to the next pool name, exactly as against a live lease. ----
$locksDir = $SandboxLocksDir
New-Item -ItemType Directory -Path $locksDir -Force -ErrorAction Stop | Out-Null

# STICKY, THEN FREE (operator ruling 2026-09-06). ONLY THE ORDER the pool is
# walked in changes here; the lease MECHANISM below - CreateNew, the exclusive
# reclaim, the handle that IS the lease - is untouched.
#   PREFERRED: the account $TargetFolder hashes to, tried first on every sweep,
#     so a conversation keeps landing on the same Windows account. See
#     Get-SandboxPoolAccountForFolder in sandbox-account.ps1 for the derivation
#     and for why account-bound (DPAPI) browser state needs it.
#   THEN THE REST, still shuffled - the shuffle spreads concurrent turns whose
#     preferred account is taken instead of herding them all onto the same next
#     name.
# A BUSY PREFERRED ACCOUNT IS NORMAL, NOT AN ERROR. The walk always continues
# into the rest of the pool: stickiness is a preference, and one stuck or
# long-held lease must never be able to wedge a conversation out of running.
$poolNames = Get-SandboxPoolAccountNames
$preferredName = Get-SandboxPoolAccountForFolder -Folder $TargetFolder
$leasedName = $null
$lockStream = $null
$lockPath = $null
# Whatever a RECLAIM below could NOT revoke. Those paths are still granted to
# the account this turn is about to lease, so they join this turn's own revoke
# list and get one more attempt in the finally. Declared out here because the
# reclaim happens inside the loop and the list is built after it.
$reclaimCarryOver = @()
$maxLeaseAttempts = 40   # ~10s total at 250ms between full-pool sweeps
for ($attempt = 1; $attempt -le $maxLeaseAttempts -and -not $leasedName; $attempt++) {
  $sweepOrder = Get-SandboxPoolLeaseOrder -Folder $TargetFolder
  foreach ($name in $sweepOrder) {
    $candidatePath = Join-Path $locksDir "$name.lock"
    try {
      # ReadWrite, not Write: the lock file is also this lease's ACE LEDGER (see
      # the lease-ledger block in sandbox-account.ps1), and a reclaim has to be
      # able to READ the dead turn's list back off it. The share mode is
      # untouched - File.Open's 3-arg overload is still FileShare::None, so the
      # CreateNew is still the atomic "first caller wins" it has always been.
      $lockStream = [System.IO.File]::Open($candidatePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite)
      $leasedName = $name
      $lockPath = $candidatePath
      # Stamp the empty ledger's header so a human who finds this file knows
      # what it is. NON-FATAL, but LOUD: a lease whose ledger cannot be written
      # still runs, it just cannot be cleaned up after a hard kill, and that has
      # to be said rather than discovered later as a leaked ACE.
      try {
        Write-SandboxLeaseLedger -Stream $lockStream
      } catch {
        Log "WARNING: could not stamp the ACE ledger into $candidatePath  - $($_.Exception.Message). The turn runs, but if it is HARD-KILLED the reclaim of '$name' will not know which ACEs to revoke."
      }
      break
    } catch [System.IO.IOException] {
      # The lock FILE exists. That is not yet a lease - see WHAT "LEASED" MEANS
      # above. Try to take it EXCLUSIVELY: if that succeeds nothing held it, the
      # lock is a crashed turn's litter, and this handle is now our lease. If it
      # throws (sharing violation from a live turn's own handle; or the file
      # vanished under us because its owner's release ran in between; or it is
      # unreadable), fall through to the next pool name exactly as before.
      try {
        $lockStream = [System.IO.File]::Open($candidatePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $leasedName = $name
        $lockPath = $candidatePath
        Log "RECLAIMED stale lease lock $candidatePath  - the file existed but NO process held it open, i.e. a previous turn on '$name' was hard-killed before its release ran. Frequent reclaims mean turns are dying badly."
        # ---- (a2) ...AND THE DEAD TURN'S ACEs GO WITH IT. This is the one
        # moment we KNOW a finally was skipped, and it is the last moment before
        # this account runs something again - for a DIFFERENT conversation than
        # the one that leaked. Without this the pool account keeps Modify on the
        # dead turn's conversation folder and on its ~/.egpt-jsonl/<thread>
        # store forever, which is the cross-conversation leak the scrub exists
        # to prevent arriving through the ACL instead of the profile. Measured
        # on this node before the fix: 42 such ACEs live, one conversation
        # folder carrying twelve different pool accounts.
        #
        # It rides the reclaim rather than a sweeper of its own precisely
        # BECAUSE the reclaim already is the hard-kill detector. Clear-
        # SandboxStaleLease reads the ledger off the handle we just took,
        # revokes each path, and leaves the ledger holding only what it could
        # NOT revoke, so the next reclaim retries instead of forgetting.
        #
        # NEVER FATAL, and never silent: we already own this lease, and refusing
        # the turn over a cleanup failure would trade a leak for an outage. Each
        # outcome is logged by name, and a FAILED revoke says the ACE is still
        # there.
        try {
          $reclaimed = @(Clear-SandboxStaleLease -Stream $lockStream -AccountName $name)
          $reclaimCarryOver = @($reclaimed | Where-Object { $_.Status -eq 'failed' } | ForEach-Object { $_.Path })
          # AN EMPTY LEDGER IS NOT A CLEAN BILL OF HEALTH, and must not read like
          # one. Every lock file written before 2026-09-11 is 0 bytes, so a
          # reclaim of one of those knows nothing about what that turn granted
          # and revokes nothing. Say so, rather than logging silence.
          if ($reclaimed.Count -eq 0) {
            Log "reclaim of $candidatePath found NO ACE ledger in it  - either that turn granted nothing, or the lock predates the ledger (locks written before 2026-09-11 are empty). Nothing was revoked, and any ACE it did leave cannot be identified from here."
          }
          foreach ($rec in $reclaimed) {
            if ($rec.Status -eq 'revoked') {
              Log "reclaim revoked the hard-killed turn's ACE for $($rec.Sid) ($name) on $($rec.Path)  - $($rec.Message)"
            } elseif ($rec.Status -eq 'failed') {
              Log "WARNING: reclaim could NOT revoke the hard-killed turn's ACE for '$name' on $($rec.Path)  - $($rec.Message). That account STILL has an explicit ACE there; the path stays in this lock's ledger so the next reclaim retries it."
            } else {
              Log "reclaim found nothing to revoke for '$name' on $($rec.Path)  - $($rec.Status): $($rec.Message)"
            }
          }
        } catch {
          Log "WARNING: reclaim of $candidatePath could not process its ACE ledger  - $($_.Exception.Message). Whatever ACEs the hard-killed turn left are STILL granted to '$name'."
        }
        break
      } catch {
        # genuinely leased by another concurrent turn  - try the next pool name
      }
    }
  }
  if (-not $leasedName -and $attempt -lt $maxLeaseAttempts) {
    Start-Sleep -Milliseconds 250
  }
}
if (-not $leasedName) {
  throw "sandbox-logon-launcher: sandbox pool exhausted ($($poolNames.Count) accounts all in use)"
}
if ($leasedName -eq $preferredName) {
  Log "leased pool account '$leasedName' (this conversation's preferred account)"
} else {
  Log "leased pool account '$leasedName'  - fell back: preferred '$preferredName' was already leased. Normal under concurrency; account-bound per-conversation state (e.g. a browser profile) does not carry over to this turn."
}

# ---- (a3) ...AND THE REST OF THE POOL'S DEAD LEASES GO TOO. THE FIX FOR THE
# LEAK, and the reason it is here and not in a sweeper (2026-09-23).
#
# WHAT WAS ACTUALLY WRONG, measured on kg from the live artefacts rather than
# reasoned about: the revoke mechanism is correct and is simply never reached.
# warm-cli-session.mjs's close() ends the session with proc.kill(), which on
# Windows is TerminateProcess, so the `finally` at the bottom of this file does
# not run at the ORDINARY end of a sandboxed session - the hard-kill path is the
# NORMAL path. (a2) above is the only thing that then revokes, and it is keyed to
# ONE account and fires only when THAT account is leased again. An account that
# leaks and then goes quiet keeps its ACEs indefinitely. On the day this was
# written, 14 of the 16 pool locks existed, NOT ONE of them was held by any
# process, and all 14 of the ACEs their ledgers named were still on disk - nine
# different conversations' thread stores, one of them granted to three pool
# accounts at once. Two of those locks were two days old.
#
# SO THE RECLAIM STOPS BEING PER-ACCOUNT. The same function the provisioner runs
# for repair, called here, over every OTHER lock in the pool. It is not a second
# mechanism: Clear-SandboxAbandonedLeases is the same ledger read, the same
# Revoke-SandboxPathAces and the same staleness test as (a2), only grouped across
# locks so that one icacls pass covers every account that leaked onto one path.
#
# OUR OWN LOCK NEEDS NO EXEMPTION, and deliberately gets none: this process holds
# it FileShare::None, so the sweep's own exclusive open fails on it and it is
# reported 'held' and left alone - the launcher's staleness test applied to the
# launcher. A concurrent turn's live lease is protected by exactly the same fact.
#
# AFTER THE LEASE, NEVER BEFORE IT: while the sweep holds another account's stale
# lock, a launcher racing for that account sees a live lease and walks on. Doing
# this before our own lease could therefore cost this turn its preferred account
# (or, under 16 concurrent sweeps, its turn), and litter that is not ours must
# never do that.
#
# BUDGETED, because the old argument for keeping this off the turn path was real:
# a DACL write on a big tree re-propagates inheritance and was measured at 307 s
# for ~\src. That tree is no longer reachable from a ledger - ~\src\egpt is a
# STANDING group grant now and is never granted per lease - so what is left is
# Rooms and thread stores. The budget is the guarantee rather than the
# expectation: whatever is not reached stays on its ledger with its lock, and the
# next turn or setup\sweep-sandbox-leases.ps1 finishes it.
#
# NEVER FATAL. We hold the lease; refusing the turn over someone else's litter
# would trade a leak for an outage.
try {
  $sweepBudget = 10
  $sweptRecs = @(Clear-SandboxAbandonedLeases -LocksDir $locksDir -TimeBudgetSeconds $sweepBudget)
  $sweptAces = @($sweptRecs | ForEach-Object { $_.Aces } | Where-Object { $_.Status -eq 'revoked' }).Count
  $sweptLocks = @($sweptRecs | Where-Object { $_.Status -eq 'reclaimed' }).Count
  if ($sweptAces -gt 0 -or $sweptLocks -gt 0) {
    Log "pool reclaim on lease: revoked $sweptAces ACE(s) left by $sweptLocks abandoned lease(s) that nothing was going to lease again"
  }
} catch {
  Log "WARNING: the pool-wide reclaim could not run  - $($_.Exception.Message). This turn is unaffected; ACEs other dead leases left are still granted."
}

$plainPwd = $null
# EVERY path this turn grants an ACE on, TargetFolder first and then whichever
# -SharePath entries got one, in the order they were attempted. Declared out
# here, before the try, so the finally can always see it - and mirrored line for
# line into the lock file, which is what a RECLAIM reads when this process is
# killed before the finally runs (see the lease-ledger block in
# sandbox-account.ps1).
#
# RECORDED BEFORE THE GRANT, not after, which is the one thing that changed
# about this list: a crash log must be a SUPERSET of what landed, or the crash
# it exists for is the case it misses. The old "only what actually landed" rule
# is now enforced where it belongs - Revoke-SandboxLeaseAces looks before it
# writes and reports 'clean' for a path that carries no ACE of ours, so a path
# whose grant threw is still never re-ACLed on the way out.
$acesGranted = New-Object System.Collections.Generic.List[string]
# Seeded with anything the reclaim above could not clear: those ACEs belong to
# THIS account and are still live, so the finally gets one more go at them. Not
# re-appended to the file - Clear-SandboxStaleLease already wrote them back into
# the ledger, so a second hard kill still finds them.
foreach ($carried in $reclaimCarryOver) { [void]$acesGranted.Add($carried) }
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
  # How this turn's principal is named in every grant log line below. The SID is
  # what is actually written; the name is what an operator reads.
  $leasedLabel = "$($leasedSid.Value) ($leasedName)"

  # ---- (d) grant read/write on exactly TargetFolder  - never broader ----
  # Ledger first, ACE second. If this process dies between the two lines the
  # reclaim revokes a path that carries nothing, which costs one Get-Acl; the
  # other order would leak the ACE it failed to record.
  [void]$acesGranted.Add($TargetFolder)
  try {
    Add-SandboxLeaseLedgerPath -Stream $lockStream -Path $TargetFolder
  } catch {
    Log "WARNING: could not record $TargetFolder in the ACE ledger at $lockPath  - $($_.Exception.Message). This turn's own revoke is unaffected, but a HARD KILL will leave '$leasedName' holding Modify there with nothing to find it by."
  }
  # THE SAME WRITER THE PROVISIONER USES, and the same check-first rule: the
  # grant table lives in sandbox-account.ps1 and this passes the LEASED
  # ACCOUNT's SID instead of the pool group's. Nothing is written when the ACE
  # is already exactly right, which on this path - the hot one, once per turn -
  # is the whole point (operator 2026-09-20: "i think we can use always the
  # fast way").
  Grant-SandboxPoolAce -Path $TargetFolder -Grant 'Modify' -Sid $leasedSid -Principal $leasedLabel | Out-Null
  # ---- (d1) READ THE DACL BACK. THE DACL DECIDES, NOT THE EXIT CODE.
  # THE BUG THIS CLOSES, measured on kg 2026-09-23: a turn was leased
  # egpt-sbx-05, the line above reported a grant, and CreateProcessWithLogonW
  # then died with Win32 error 267 - ERROR_DIRECTORY, which for
  # lpCurrentDirectory means "not reachable BY THE TARGET USER". icacls on that
  # conversation folder carried explicit Modify for egpt-sbx-07, -12 and -13 and
  # NOTHING for egpt-sbx-05. The grant had not landed, nothing ever looked, and
  # the launch went ahead into a cwd the account could not enter.
  # Grant-SandboxPoolAce branches on icacls's EXIT CODE, and this repo's own
  # measurement (2026-09-20) is that icacls can exit 0, print success and write
  # no ACE at all. Its sibling Revoke-SandboxPathAces was given the opposite
  # rule the same day - the explicit DACL is read BEFORE and AFTER, "THE DACL
  # DECIDES, NOT THE EXIT CODE" - and the grant half never got it. This is that
  # rule, applied where the cost of missing it is a dead turn.
  # It costs ONE Get-Acl per turn on the folder the turn is about to use.
  Assert-SandboxPathReachable -Path $TargetFolder -Sid $leasedSid -AccountName $leasedName -Stage 'step (d), reading back the grant on the conversation folder' | Out-Null

  # ---- (d2) ONE ACE PER SHARE PATH, IN THE CLASS ITS CALLER DECLARED IT IN.
  # WHY THIS EXISTS: a being's `allowed_paths` produce a `--add-dir` at the CLI
  # layer and NOTHING at the OS layer, so under the sandbox the folder is
  # permitted by Claude Code and denied by the kernel - the being is told it may
  # use a directory that then refuses it. This closes that one gap and only that
  # gap: with no share paths neither loop body executes and this step costs a
  # turn nothing.
  #
  # TWO CLASSES, ONE LOOP (operator 2026-09-13). -SharePath gets Modify;
  # -SharePathReadOnly gets Read, the grant table's name for (OI)(CI)(RX), i.e.
  # ReadAndExecute. Until then this step had exactly one ACE mode and both
  # classes arrived concatenated in -SharePath, so a path the CLI layer treats
  # as read-only was WRITABLE to the kernel - and these beings hold Bash and
  # PowerShell, so one shell command wrote past the deny rule. Under the
  # `all`/`sandbox` tiers there is no CLI layer at all, so there the ACE was the
  # only gate and it granted write. The grant name comes from the class table
  # below rather than from a copied second loop: a copy is how the two would
  # drift into disagreeing about ledgers, de-duplication or failure handling,
  # and the ledger half of that is a leaked ACE.
  #
  # EACH PATH INDEPENDENTLY, deliberately, and that is the whole design of this
  # block: one unshareable path must not cost the turn its OTHER paths or its
  # launch, so every entry gets its own try/catch and a failure is logged and
  # stepped over. A MISSING path is likewise logged and skipped rather than
  # thrown - a share path that was renamed, or lives on a drive that is not
  # mounted right now, is a configuration problem, and failing every turn of
  # that being over it would be a far worse outcome than the being not seeing
  # one directory.
  #
  # ON THE INHERITANCE FLAGS: a share path may be a single FILE, where (OI)(CI)
  # is illegal, so a file gets the same mask with no inheritance instead.
  # Grant-SandboxPoolAce derives that from the path itself - see its header for
  # why a leaf must never be handed (OI)(CI) through icacls either.
  #
  # AND A READ-ONLY SHARE THE POOL GROUP CAN ALREADY READ GETS NOTHING AT ALL
  # (operator 2026-09-20). ~\src now carries a standing (OI)(CI)(RX) for
  # egpt-sandbox-pool, written by the provisioner, so every read-only share under
  # it - which is most of them, ~\src\egpt above all - was a DACL write on a big
  # tree that granted the being exactly what it already had, and left behind one
  # more per-account ACE for a hard kill to leak. Windows UNIONS Allow ACEs, so
  # the skipped grant subtracts nothing. Test-SandboxPoolReadCovered carries what
  # makes that check safe to act on; it is deliberately NOT applied to the
  # WRITABLE class, whose Modify is real, per-lease, and covered by no standing
  # grant anywhere.
  $sharesSeen = New-Object 'System.Collections.Generic.HashSet[string]' -ArgumentList ([System.StringComparer]::OrdinalIgnoreCase)
  # Seeded with TargetFolder so that a share entry naming the conversation
  # folder is recognised as already covered by (d) - otherwise it would mean a
  # second grant for an ACE that is already there, and a second purge on the
  # way out, both pointless work on the folder the turn is actually using.
  # SHARED ACROSS BOTH CLASSES, so one path can never collect two ACEs; the
  # writable pass runs first, so a path in both lists keeps its Modify and the
  # read-only pass logs it as a duplicate. src/sandbox-cli-session.mjs drops
  # such a path from the read-only list before it ever gets here.
  [void]$sharesSeen.Add([System.IO.Path]::GetFullPath($TargetFolder).TrimEnd('\'))
  foreach ($shareClass in @(
    @{ Grant = 'Modify'; SkipIfPoolReadCovered = $false; Paths = $SharePathList },
    @{ Grant = 'Read';   SkipIfPoolReadCovered = $true;  Paths = $SharePathReadOnlyList }
  )) {
    $shareGrant = $shareClass.Grant
    foreach ($sp in $shareClass.Paths) {
      if ([string]::IsNullOrWhiteSpace($sp)) { continue }
      try {
        if (-not (Test-Path -LiteralPath $sp)) {
          Log "share path does not exist  - skipping, no ACE granted: $sp"
          continue
        }
        if ($shareClass.SkipIfPoolReadCovered -and (Test-SandboxPoolReadCovered -Path $sp -LeasedSid $leasedSid)) {
          Log "share path is already readable by $SandboxPoolGroup (standing group grant, inherited or explicit)  - skipping the per-account $shareGrant ACE, nothing to grant and nothing to revoke: $sp"
          continue
        }
        # Pure string math on a path that was just shown to exist, so it cannot
        # throw, and it is used ONLY as a de-duplication key - every ACL call
        # below still uses the caller's own spelling of the path.
        if (-not $sharesSeen.Add([System.IO.Path]::GetFullPath($sp).TrimEnd('\'))) {
          Log "share path already granted this turn  - skipping duplicate: $sp"
          continue
        }
        # Ledger first, ACE second - the same order and the same reason as step
        # (d), and for BOTH classes: a read-only ACE nothing recorded is exactly
        # the leak the ledger exists to prevent, since the revoke purges by SID
        # and neither knows nor cares which rights the ACE carried. The failure
        # to RECORD is warned about but does not skip the grant: a being losing
        # a share path it was promised is a worse outcome than a crash-path
        # cleanup gap, and this says which one happened.
        [void]$acesGranted.Add($sp)
        try {
          Add-SandboxLeaseLedgerPath -Stream $lockStream -Path $sp
        } catch {
          Log "WARNING: could not record shared path $sp in the ACE ledger at $lockPath  - $($_.Exception.Message). This turn's own revoke is unaffected, but a HARD KILL will leave '$leasedName' holding $shareGrant there with nothing to find it by."
        }
        Grant-SandboxPoolAce -Path $sp -Grant $shareGrant -Sid $leasedSid -Principal $leasedLabel | Out-Null
      } catch {
        Log "WARNING: could not grant $shareGrant to $leasedLabel on shared path $sp  - $($_.Exception.Message) (continuing: the other share paths and the launch are unaffected)"
      }
    }
  }

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
  # ...AND IT PLANTS THE BEING'S WORKING DIRECTORY, which is why its return
  # value is captured (operator ruling 2026-09-23). $sandboxCwd is
  # C:\Users\egpt-sbx-NN\egpt, a junction onto $TargetFolder planted by the same
  # payload that just wiped the profile, and it is the ONLY thing the inner
  # process is ever told about where it is. TWO NAMES FOR TWO DIFFERENT JOBS,
  # kept apart on purpose and never collapsed:
  #   $TargetFolder - the durable Room. EVERY ACL names this: the grant at (d),
  #                   the ledger, the revoke in the finally, and both
  #                   reachability gates. An ACE on a junction would be an ACE
  #                   on nothing; the target's DACL is what the kernel reads.
  #   $sandboxCwd   - the mount. The cwd, and NOTHING else.
  # WHY: process.cwd() and `pwd` return the JUNCTION (measured 2026-09-23), so
  # this is the path a being quotes into a group chat all day. The Room's own
  # path names the operator's account and, in its slug, usually a third party -
  # see Get-SandboxProfileJunctionStatement for the disclosure this closes.
  $sandboxCwd = Clear-SandboxProfileContents -AccountName $leasedName -Password $plainPwd `
    -LpDesktop $sandboxDesk.LpDesktop -RoomTarget $TargetFolder
  if (-not $sandboxCwd) {
    throw ("sandbox-logon-launcher: REFUSING to launch  - the scrub pass planted no working directory for '$leasedName', " +
      "so there is no $($leasedName)\egpt mount onto $TargetFolder to run in. The scrub is the only thing that can create it: " +
      "it runs AS the leased account, the one principal allowed to write inside that profile. Its own WARNING above says which " +
      "of the two happened  - the account has no Windows profile yet (run one turn on it first; any LOGON_WITH_PROFILE launch " +
      "materialises one), or the pass itself did not finish. The turn is NOT run in the conversation folder instead: that path " +
      "names the operator and the person this conversation is with, and keeping it out of the being's cwd is the whole point.")
  }
  # The ONE line of this launch that reaches the daemon log on SUCCESS
  # (sandbox-cli-session.mjs forwards it; see Get-SandboxLaunchSummary).
  Log (Get-SandboxLaunchSummary -AccountName $leasedName -Cwd $sandboxCwd)

  # ---- (f) launch InnerBin AS the leased account, stdio proxied straight
  # through. CreateProcessWithLogonW does the logon itself from the name +
  # password, so there is no separate LogonUser step and no token handle to
  # own: it needs no privilege in THIS process (see the WHY at the top). ----
  # ---- LAST GATE BEFORE THE LAUNCH, and it still asks about $TargetFolder and
  # not about the mount: the ACE lives on the Room, a junction is only a name,
  # and a mount onto a folder the account cannot reach fails exactly as before.
  # It is deliberately a SECOND read rather than a repeat of (d1). Real work
  # happens between them - every -SharePath ACE, the private desktop, and a
  # whole CreateProcessWithLogonW round trip for the profile scrub, which is
  # seconds - and an ACE that was there at (d1) can be gone by here: a
  # concurrent reclaim or revoke purges by SID over a path, and the lease lock
  # is what keeps two turns off one ACCOUNT, not off one FOLDER. So the question
  # is asked again at the last moment it can still be acted on.
  # The scrub above launches with cwd=%SystemRoot%, which every account can
  # enter, so it is not gated; THIS is the call whose cwd is the conversation
  # folder. ----
  Assert-SandboxPathReachable -Path $TargetFolder -Sid $leasedSid -AccountName $leasedName -Stage 'step (f), the last check before launching InnerBin with the conversation folder as its cwd' | Out-Null
  # ---- (g, part 1) ...and wait for it, capturing its real exit code. Both the
  # launch and the wait live in Invoke-AsLeasedAccount, shared with the scrub
  # pass above. ----
  $finalExit = Invoke-AsLeasedAccount -AccountName $leasedName -Password $plainPwd `
    -Bin $InnerBin -BinArgs $InnerArgsList `
    -WorkingDirectory $sandboxCwd -LpDesktop $sandboxDesk.LpDesktop -Label 'launching' `
    -SetEnv $SetEnvList `
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
  # NOTE: of the ACEs, only the per-turn FILESYSTEM ones are revoked here - the
  # ones this turn recorded in $acesGranted, i.e. TargetFolder from step (d) and
  # every shared path step (d2) reached, of EITHER class - the revoke purges by
  # SID, so a ReadAndExecute ACE comes off exactly like a Modify one. The WINDOW
  # STATION ACE from step (e) is deliberately LEFT IN PLACE: it is granted to
  # the pool GROUP (not per-turn, not per-account) and is shared by every
  # concurrent turn, so revoking it here would race sessions still running. It
  # is volatile anyway  - winsta DACLs die with the logon session.
  # ---- (g, part 2) best-effort revoke every ACE this turn granted  - never let
  # cleanup failure mask the inner process's own result. ----
  # THE SAME FUNCTION THE RECLAIM USES, deliberately: the normal path and the
  # hard-kill path must not be able to drift into disagreeing about what
  # "revoked" means, and a second copy of a purge loop here is exactly how that
  # would happen. It keeps one try EACH internally, for the reason the grant
  # loop has one each - a path that cannot be purged now (someone re-ACL'd it
  # mid-turn, a drive went away) must not leave the ACEs on every path after it
  # in the list behind - and it looks before it writes, so a path whose grant
  # threw is reported 'clean' rather than re-ACLed.
  #
  # THE RECLAIM IS A BACKSTOP, NOT A REPLACEMENT. This still runs on every
  # ordinary turn, and it runs BEFORE the lease is released below, so no other
  # turn can claim this account while its ACEs from THIS turn are still being
  # cleaned up. What the reclaim adds is the case this block cannot reach at
  # all: the one where this process is killed and never gets here.
  #
  # ...AND A FAILED REVOKE IS CARRIED, NOT FORGOTTEN (2026-09-20). The revoke
  # message below has always said "the next reclaim of this lease will retry it",
  # and until now that was not true on THIS path: part 3 deleted the lock file
  # unconditionally, ledger and all, so a path the purge could not clear had
  # nothing left naming it and no reclaim could ever find it again. The reclaim
  # path got this right from the start - Clear-SandboxStaleLease rewrites the
  # ledger with exactly what it could not revoke - so this is that same carry-over
  # discipline applied to the clean path, not a second idea about it.
  $stillGranted = New-Object System.Collections.Generic.List[string]
  if ($acesGranted -and $acesGranted.Count -gt 0) {
    foreach ($rec in @(Revoke-SandboxLeaseAces -AccountName $leasedName -Paths $acesGranted.ToArray())) {
      if ($rec.Status -eq 'revoked') {
        Log "revoked ACE for $($rec.Sid) ($leasedName) on $($rec.Path)  - $($rec.Message)"
      } elseif ($rec.Status -eq 'failed') {
        [void]$stillGranted.Add($rec.Path)
        Log "WARNING: could not revoke the ACE for '$leasedName' on $($rec.Path)  - $($rec.Message). That account STILL has an explicit ACE there; the next reclaim of this lease will retry it."
      } else {
        Log "nothing to revoke for '$leasedName' on $($rec.Path)  - $($rec.Status): $($rec.Message)"
      }
    }
  }
  # ---- (g, part 3) release the lease  - ACE revoke happens first (above),
  # so no other turn can claim this account while its ACE from THIS turn
  # might still be getting cleaned up. ----
  #
  # UNLESS SOMETHING IS STILL GRANTED, in which case the lock file STAYS, holding
  # only the paths that are still leaking. That does not starve the account: a
  # lock no process holds is exactly what step (a)'s reclaim takes in place, and
  # the reclaim is what will retry the revoke. Deleting it would be the one move
  # that makes the leak unfindable.
  if ($lockStream) {
    $keepLock = $stillGranted.Count -gt 0
    if ($keepLock) {
      try {
        Write-SandboxLeaseLedger -Stream $lockStream -Paths $stillGranted.ToArray()
      } catch {
        $keepLock = $false
        Log "WARNING: could not write the unrevoked paths back into the ACE ledger at $lockPath  - $($_.Exception.Message). Releasing the lease anyway; '$leasedName' keeps $($stillGranted.Count) ACE(s) that nothing now names."
      }
    }
    try {
      $lockStream.Close()
    } catch {
      Log "WARNING: could not close lease lock stream for '$leasedName'  - $($_.Exception.Message)"
    }
    if ($keepLock) {
      Log "KEEPING lease lock $lockPath for '$leasedName'  - $($stillGranted.Count) ACE(s) could not be revoked and stay on its ledger. Nothing holds the lock, so the next lease of this account reclaims it and retries: $($stillGranted -join ', ')"
    } else {
      try {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
      } catch {
        Log "WARNING: could not remove lease lock file $lockPath for '$leasedName'  - $($_.Exception.Message)"
      }
    }
  }
}

exit $finalExit
