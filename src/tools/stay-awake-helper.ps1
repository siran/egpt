# stay-awake-helper.ps1 — kernel power-request holder for the egpt work-lock.
#
# WHY THIS EXISTS (operator 2026-06-07, deep-sleep forensics):
# This machine is Modern Standby only (S0 Low Power Idle; powercfg /a shows
# no S3). In Modern Standby the old SetThreadExecutionState(ES_SYSTEM_REQUIRED)
# approach only prevents *entering* idle-sleep — once the system IS in standby
# (lid close / idle timeout) the Desktop Activity Moderator virtualizes timers
# and freezes user processes. Overnight 2026-06-06→07: 480 DRIPS transitions in
# 4.5 h, zero node scheduling, 27 missed WakeToRun batteries; a held-awake
# ffmpeg once took 54 min wall-clock for a ~30 s job.
#
# The documented Modern-Standby primitive for "keep my process RUNNING through
# standby, regardless of lid state" is a kernel power request of type
# PowerRequestExecutionRequired (an "activator"). While one is active the SoC
# stays in the active sub-state of standby and the holder keeps executing; on
# release the system descends to DRIPS normally. We assert ExecutionRequired
# (keep running through standby) AND SystemRequired (don't idle-enter standby
# while awake) on one request handle. Shows up in `powercfg /requests` under
# EXECUTION/SYSTEM with the reason string below — that's the live diagnostic.
#
# TWO MODES:
#   resident (default) — spawned by src/tools/stay-awake.mjs, stdin-driven:
#       "on\n"  -> assert both requests   (ack: "ack on exec=True sys=True")
#       "off\n" -> clear both             (ack: "ack off")
#       EOF     -> clear + exit           (node died; nothing can strand a
#                                          zombie that pins the machine awake)
#   one-shot (-OneShotSeconds N) — assert, sleep N seconds, clear, exit.
#       Used by the wake-probe scheduled task to keep the wake window open
#       long enough for the bridge's conn-tick to claim its own lock.
#
# If PowerCreateRequest is unavailable/fails we fall back to
# SetThreadExecutionState (the old behavior — better than nothing when awake).
param([int]$OneShotSeconds = 0)
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;
public static class EgptPower {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct REASON_CONTEXT {
    public uint Version;                                   // POWER_REQUEST_CONTEXT_VERSION = 0
    public uint Flags;                                     // POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1
    [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString;
  }
  public const int PowerRequestSystemRequired    = 1;
  public const int PowerRequestExecutionRequired = 3;
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT ctx);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool PowerSetRequest(IntPtr h, int type);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool PowerClearRequest(IntPtr h, int type);
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
  [StructLayout(LayoutKind.Sequential)]
  public struct SYSTEM_POWER_STATUS {
    public byte ACLineStatus;        // 0 = battery, 1 = AC, 255 = unknown
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public uint BatteryLifeTime;
    public uint BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll")]
  public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
}
'@
Add-Type -TypeDefinition $src

$ctx = New-Object EgptPower+REASON_CONTEXT
$ctx.Version = 0
$ctx.Flags   = 1
$ctx.SimpleReasonString = 'egpt work-lock: pending work (recover / transcribe / brain-turn / reply)'

$h = [IntPtr]::Zero
$mode = 'power-request'
try { $h = [EgptPower]::PowerCreateRequest([ref]$ctx) } catch { $h = [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
  $mode = 'es-fallback'   # old SetThreadExecutionState path; still useful awake
}

function Set-Lock {
  if ($script:mode -eq 'power-request') {
    $e = [EgptPower]::PowerSetRequest($script:h, [EgptPower]::PowerRequestExecutionRequired)
    $s = [EgptPower]::PowerSetRequest($script:h, [EgptPower]::PowerRequestSystemRequired)
    return "exec=$e sys=$s"
  } else {
    [void][EgptPower]::SetThreadExecutionState(0x80000001)   # ES_CONTINUOUS|ES_SYSTEM_REQUIRED
    return 'es=set'
  }
}
function Clear-Lock {
  if ($script:mode -eq 'power-request') {
    [void][EgptPower]::PowerClearRequest($script:h, [EgptPower]::PowerRequestExecutionRequired)
    [void][EgptPower]::PowerClearRequest($script:h, [EgptPower]::PowerRequestSystemRequired)
  } else {
    [void][EgptPower]::SetThreadExecutionState(0x80000000)   # ES_CONTINUOUS (clears)
  }
}

if ($OneShotSeconds -gt 0) {
  [Console]::Out.WriteLine("one-shot mode=$mode hold=${OneShotSeconds}s " + (Set-Lock))
  Start-Sleep -Seconds $OneShotSeconds
  Clear-Lock
  exit 0
}

# Resident mode: serve on/off over stdin until EOF.
[Console]::Out.WriteLine("ready mode=$mode")
[Console]::Out.Flush()
$on = $false
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }                 # EOF — parent node process died
  $line = $line.Trim()
  if ($line -eq 'on' -and -not $on) {
    $detail = Set-Lock
    $on = $true
    [Console]::Out.WriteLine("ack on $detail")
    [Console]::Out.Flush()
  } elseif ($line -eq 'off' -and $on) {
    Clear-Lock
    $on = $false
    [Console]::Out.WriteLine('ack off')
    [Console]::Out.Flush()
  } elseif ($line -eq 'ac') {
    # AC/DC probe — node polls this to drive the plugged-in continuous
    # hold (operator 2026-06-07: lid-closed standby is a coma the lock
    # cannot reverse, only prevent — so on AC the lock is held BEFORE
    # any lid-close; on battery it's released and deep standby wins).
    $sps = New-Object EgptPower+SYSTEM_POWER_STATUS
    [void][EgptPower]::GetSystemPowerStatus([ref]$sps)
    [Console]::Out.WriteLine('ac ' + $(if ($sps.ACLineStatus -eq 1) { '1' } else { '0' }))
    [Console]::Out.Flush()
  } elseif ($line -eq 'exit') {
    break
  }
}
if ($on) { Clear-Lock }
exit 0
