// stay-awake.mjs — the egpt WORK-LOCK: keep the Windows host RUNNABLE while
// there is pending work.
//
// v2 (operator 2026-06-07): kernel power requests via a RESIDENT helper.
//
// WHY THE REWRITE — this machine is Modern Standby only (S0 Low Power Idle,
// no S3; `powercfg /a`). The old SetThreadExecutionState(ES_SYSTEM_REQUIRED)
// only prevents *entering* idle-sleep. Once the system IS in standby (lid
// close or idle timeout) the Desktop Activity Moderator virtualizes timers
// and freezes user processes — holding ES_SYSTEM_REQUIRED changes nothing.
// Proof from the 2026-06-06→07 overnight: the event log shows 480 DRIPS
// transitions in one 4.5 h standby stretch while wa-bridge.log shows ZERO
// scheduling between 506/507 events; and an ffmpeg job with the old hold
// asserted once took 54 min wall-clock for ~30 s of work.
//
// The documented Modern-Standby primitive for "keep my process running
// through standby, regardless of lid state" is a kernel POWER REQUEST of
// type PowerRequestExecutionRequired (an "activator"). While held, the SoC
// stays in standby's active sub-state and the holder keeps executing at
// full speed; on release the system descends to DRIPS normally. The helper
// asserts ExecutionRequired + SystemRequired on one handle — visible live
// in `powercfg /requests` (run elevated) under EXECUTION and SYSTEM.
//
// WHY RESIDENT — spawning powershell + Add-Type costs ~1-2 s, far too slow
// to claim a brief wake window. The helper is spawned once (eagerly at
// bridge start via initStayAwake) and toggled with one stdin line ("on" /
// "off", <10 ms). If THIS process dies, the helper's stdin hits EOF and it
// clears + exits — a crash can never strand a zombie that pins the machine
// awake forever. If the helper dies while a hold is active, we respawn and
// re-assert.
//
// Reference-counted so overlapping jobs (recovery + transcription + brain
// turn + post-wake burst) nest correctly. A 30 s linger after the last
// release bridges the event-gaps between job stages (e.g. 'connection OPEN'
// → first offline upsert) so the system can't descend mid-batch. The lock
// is NEVER held continuously — only while jobs hold it (+linger) — so the
// machine still reaches deep standby between work batches.
//
// No-op on non-Windows; every failure is swallowed (never throws into a job).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STOP_LINGER_MS = 30_000;
// Don't respawn a crashing helper more often than this (spawn-storm guard).
const RESPAWN_MIN_GAP_MS = 10_000;

const HELPER_PATH = fileURLToPath(new URL('./stay-awake-helper.ps1', import.meta.url));

let _helper = null;          // resident powershell child (lives for our lifetime)
let _helperMode = null;      // 'power-request' | 'es-fallback' (parsed from its stdout)
let _lastSpawnMs = 0;
let _on = false;             // desired lock state (what we last asked for)
let _refs = 0;
let _stopTimer = null;
let _log = () => {};

export function setStayAwakeLogger(fn) { if (typeof fn === 'function') _log = fn; }

function _send(cmd) {
  try { _helper?.stdin?.write(cmd + '\n'); } catch (e) { _log(`work-lock: send '${cmd}' failed — ${e?.message ?? e}`); }
}

function _ensureHelper() {
  if (_helper || process.platform !== 'win32') return;
  const now = Date.now();
  if (now - _lastSpawnMs < RESPAWN_MIN_GAP_MS) return;   // crashing fast — wait for the next acquire/poke
  _lastSpawnMs = now;
  try {
    _helper = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    _helper = null;
    _log(`work-lock: helper spawn failed — ${e?.message ?? e}`);
    return;
  }
  let buf = '';
  _helper.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('ready')) {
        _helperMode = line.includes('es-fallback') ? 'es-fallback' : 'power-request';
        _log(`work-lock: helper ready (mode=${_helperMode}${_helperMode === 'es-fallback' ? ' — power requests UNAVAILABLE, standby will still freeze us' : ''})`);
      } else {
        _log(`work-lock: ${line}`);
      }
    }
  });
  _helper.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (t) _log(`work-lock: helper stderr — ${t.slice(0, 200)}`);
  });
  _helper.on('exit', (code) => {
    _helper = null;
    _helperMode = null;
    // If a hold is supposed to be active, the lock just evaporated with the
    // process — respawn and re-assert (rate-limited by RESPAWN_MIN_GAP_MS).
    if (_on) {
      _log(`work-lock: helper exited (code=${code}) while HELD — respawning to re-assert`);
      _ensureHelper();
      if (_helper) _send('on');
    }
  });
  _helper.unref?.();
  // If a hold predates the (re)spawn, assert as soon as the helper boots —
  // stdin writes queue in the pipe until its read loop starts.
  if (_on) _send('on');
}

// Eager init — call once at bridge start so the ~1-2 s powershell+Add-Type
// boot cost is paid while idle, not at the moment a wake window opens.
export function initStayAwake() { _ensureHelper(); }

function _assert() {
  if (process.platform !== 'win32') return;
  _on = true;
  _ensureHelper();
  _send('on');
  _log('work-lock: armed (ExecutionRequired+SystemRequired — runnable through Modern Standby until released)');
}

function _release() {
  if (process.platform !== 'win32') return;
  _on = false;
  _send('off');
  _log('work-lock: released (system free to descend to standby)');
}

function _scheduleStop() {
  if (_stopTimer || !_on) return;
  _stopTimer = setTimeout(() => { _stopTimer = null; if (_refs === 0) _release(); }, STOP_LINGER_MS);
  _stopTimer.unref?.();
}

// Acquire a hold; returns an idempotent release function. Nestable.
export function acquireStayAwake() {
  _refs++;
  if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }   // cancel a pending linger-stop
  if (_refs === 1) _assert();
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

// Deterministic cleanup: closing our end of stdin EOFs the helper, which
// clears the requests and exits. (Its own EOF handling also covers crashes.)
process.on('exit', () => { try { _helper?.stdin?.end(); _helper?.kill(); } catch { /* ignore */ } });
