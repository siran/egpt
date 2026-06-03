// stay-awake.mjs — keep the Windows host awake while there is pending work.
//
// For the scheduled-wake model (Task Scheduler "Wake the computer to run this
// task") to be useful, a resumed daemon must be able to finish reconnecting +
// transcribing + replying BEFORE the machine idle-sleeps again. This asserts
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) for as long as
// any job holds it — the system stays in the working state (it does NOT block a
// user-initiated sleep, only auto/idle sleep). Reference-counted so overlapping
// jobs (a transcription + a brain turn + the post-wake burst) nest correctly;
// the last release lets normal idle-sleep resume.
//
// Held by a tiny helper powershell process (Node has no built-in for the
// kernel32 call). The helper also self-terminates if THIS process dies, so a
// crash can never strand a zombie that pins the machine awake forever. A short
// linger after the last release avoids spawn/kill churn on rapid job toggles.
// No-op on non-Windows; every failure is swallowed (never throws into a job).

import { spawn } from 'node:child_process';

const STOP_LINGER_MS = 30_000;

let _child = null;
let _refs = 0;
let _stopTimer = null;
let _log = () => {};

export function setStayAwakeLogger(fn) { if (typeof fn === 'function') _log = fn; }

function _start() {
  if (_child || process.platform !== 'win32') return;
  // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001.
  // The helper sets the continuous state, then loops watching OUR pid — if we
  // vanish (crash/kill) it breaks and exits, clearing the assertion. We also
  // kill it explicitly on release.
  const ppid = process.pid;
  const ps =
    "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);';" +
    "$t=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru;" +
    "[void]$t::SetThreadExecutionState(0x80000001);" +
    `while($true){Start-Sleep -Seconds 5; if(-not(Get-Process -Id ${ppid} -ErrorAction SilentlyContinue)){break}}`;
  try {
    _child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { stdio: 'ignore', windowsHide: true });
    _child.on('exit', () => { _child = null; });
    _child.unref?.();
    _log('stay-awake: ES_SYSTEM_REQUIRED asserted (no idle-sleep while busy)');
  } catch (e) { _child = null; _log(`stay-awake: assert failed — ${e?.message ?? e}`); }
}

function _stopNow() {
  if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }
  if (_child) { try { _child.kill(); } catch { /* ignore */ } _child = null; _log('stay-awake: released'); }
}

function _scheduleStop() {
  if (_stopTimer || !_child) return;
  _stopTimer = setTimeout(() => { _stopTimer = null; if (_refs === 0) _stopNow(); }, STOP_LINGER_MS);
  _stopTimer.unref?.();
}

// Acquire a hold; returns an idempotent release function. Nestable.
export function acquireStayAwake() {
  _refs++;
  if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }   // cancel a pending linger-stop
  if (_refs === 1) _start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _refs = Math.max(0, _refs - 1);
    if (_refs === 0) _scheduleStop();
  };
}

// Hold for AT MOST `ms`, then auto-release. Returns an idempotent release for
// early cancellation. Used for the post-wake processing burst.
export function holdStayAwake(ms) {
  const release = acquireStayAwake();
  const t = setTimeout(release, Math.max(0, Number(ms) || 0));
  t.unref?.();
  return () => { clearTimeout(t); release(); };
}

export function stayAwakeActive() { return _refs > 0; }
