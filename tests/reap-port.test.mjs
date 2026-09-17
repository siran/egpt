import { describe, it, expect } from 'vitest';
import { reapPort, isOwnSpine, OWN_SPINE_LABEL, pidAlive } from '../src/tools/reap-port.mjs';

// reapPort kills real processes, so the only safe deterministic assertions against the REAL
// scanner are the no-op paths: a free port (nothing to kill) and invalid input (no scan).
// It must NEVER throw — a supervisor calls it on the spawn hot-path.
describe('reapPort', () => {
  it('returns 0 and does not throw when nothing listens on the port', () => {
    expect(reapPort(59997)).toBe(0);   // arbitrary high port nothing binds in CI
  });

  it('returns 0 for falsy / invalid ports without scanning', () => {
    expect(reapPort(0)).toBe(0);
    expect(reapPort(undefined)).toBe(0);
    expect(reapPort(null)).toBe(0);
    expect(reapPort('not-a-port')).toBe(0);
  });
});

// ── IT MUST NEVER KILL SOMETHING THAT IS NOT OURS ─────────────────────────────────────────
// (operator, 2026-09-11 night.) The console limb calls this before its first bind, and the
// comment at the top of reap-port.mjs used to justify killing WHATEVER listens: "a SQUATTER
// holding it is exactly the attack this limb's whole shape exists to close, so evicting it is
// the correct response". On this machine the squatter is Beeper Desktop — it claims upward
// from 23373 and was holding 23373/23374/23375 at the moment this was written — so that reap
// would terminate the process that delivers every message, to reclaim a port the daemon has
// just been told the spine does not need in order to serve. It survived that night only
// because the reap ran at 17:55 and Beeper took the port at 17:57.
//
// The legitimate case the comment describes — a stale prior spine orphaning THIS port on
// Windows — is real and still gets reaped. Everything else is named and left alone.
//
// `holders` and `kill` are injected here so no real netstat, tasklist or taskkill runs.
// THE PORT NUMBER HERE IS DELIBERATELY ONE NOTHING BINDS. The seams above mean no real
// netstat or taskkill should run — but an implementation that IGNORED them falls straight
// through to the real ones, and the first draft of this file used 23475, which is a live
// node's console port on this machine. It terminated that spine (pid 468; its daemon
// respawned it as 16816 within seconds). A destructive function under test gets a port that
// cannot possibly be held, so a seam that is not honoured shows up as a failing assertion
// instead of as a dead process.
const REAP_TEST_PORT = 59998;

describe('reapPort only kills a holder its caller vouches for', () => {
  function world(holders) {
    const killed = [];
    const logs = [];
    return {
      killed, logs, said: () => logs.join('\n'),
      reap: (opts = {}) => reapPort(REAP_TEST_PORT, (m) => logs.push(m), {
        holders: () => holders,
        kill: (pid) => { killed.push(pid); return true; },
        alive: (pid) => !killed.includes(pid),   // a kill that returned took the process with it
        ...opts,
      }),
    };
  }

  const BEEPER = { pid: '6764', name: 'Beeper.exe', cmdline: 'C:\\Users\\an\\AppData\\Local\\Beeper\\Beeper.exe' };
  const OUR_SPINE = { pid: '468', name: 'node.exe', cmdline: 'node C:\\Users\\an\\bin\\egpt\\egpt-spine.mjs' };
  const OTHER_NODE = { pid: '9001', name: 'node.exe', cmdline: 'node C:\\Users\\an\\src\\something-else\\server.mjs' };

  it('leaves Beeper alone, names it, and says what it did instead', () => {
    const w = world([BEEPER]);
    expect(w.reap({ mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL })).toBe(0);
    expect(w.killed).toEqual([]);
    expect(w.said()).toContain('6764');
    expect(w.said()).toContain('Beeper.exe');
    expect(w.said()).toContain('NOT killing it');
    expect(w.said()).toContain(OWN_SPINE_LABEL);
  });

  it('still reaps a stale spine of ours — the case the reap exists for', () => {
    const w = world([OUR_SPINE]);
    expect(w.reap({ mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL })).toBe(1);
    expect(w.killed).toEqual(['468']);
    expect(w.said()).toContain('killing stale pid 468');
  });

  it('a node process that is NOT our spine is left alone too — the image name is not enough', () => {
    const w = world([OTHER_NODE]);
    expect(w.reap({ mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL })).toBe(0);
    expect(w.killed).toEqual([]);
    expect(w.said()).toContain('9001');
  });

  // "I would rather not kill than kill blind" — the operator, and the code agrees: an
  // unidentifiable holder is the one case where doing nothing is strictly recoverable (no
  // console) and doing something is not (a terminated stranger).
  it('an UNIDENTIFIABLE holder is not killed, and the line says it could not be identified', () => {
    const w = world([{ pid: '7777', name: null, cmdline: null }]);
    expect(w.reap({ mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL })).toBe(0);
    expect(w.killed).toEqual([]);
    expect(w.said()).toContain('7777');
    expect(w.said()).toMatch(/could not (be )?identif/i);
  });

  it('sorts a mixed field: ours dies, the stranger lives, both are named', () => {
    const w = world([BEEPER, OUR_SPINE]);
    expect(w.reap({ mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL })).toBe(1);
    expect(w.killed).toEqual(['468']);
    expect(w.said()).toContain('Beeper.exe');
    expect(w.said()).toContain('killing stale pid 468');
  });

  // BACK-COMPAT for the OTHER call site. src/spine/boot.mjs reaps a stray whisper-server on
  // the WHISPER port, which is a different question with a different owner (and its own
  // config-level gate, shouldReapStrayWhisper). It passes no `mine`, and for it nothing
  // changes: whatever listens is still killed.
  it('with no `mine`, it kills whatever listens — unchanged for the whisper-server reap', () => {
    const w = world([BEEPER]);
    expect(w.reap()).toBe(1);
    expect(w.killed).toEqual(['6764']);
  });

  it('a kill that fails is reported, not counted and not swallowed', () => {
    const logs = [];
    const n = reapPort(REAP_TEST_PORT, (m) => logs.push(m), {
      holders: () => [OUR_SPINE],
      kill: () => { throw new Error('Access is denied'); },
      alive: () => true,
      mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL,
    });
    expect(n).toBe(0);
    expect(logs.join('\n')).toContain('Access is denied');
  });
});

// ── A KILL IS COUNTED ONLY WHEN THE PROCESS IS GONE (dolly, 2026-09-15/16) ─────────────────
// The session-1 spine "killed" the WhisperServer service's whisper-server on every boot and
// logged `killed 1` each time, while the process stayed alive: the same pid 12712 was
// "killed" at 15:04:18 and again at 20:03:36 on 09-15, and pid 6716 six times on 09-16. The
// old killer ran taskkill and never looked at the result, so a refusal (a user-session process
// cannot terminate a LocalSystem one) came back as success.
describe('reapPort counts a kill only after the process is verified gone', () => {
  const STRAY = { pid: '12712', name: 'whisper-server.exe', cmdline: 'whisper-server.exe --port 8089', service: false };

  it('a kill that RETURNS but leaves the process running is not counted, and the log says so loudly', () => {
    const logs = [];
    const n = reapPort(REAP_TEST_PORT, (m) => logs.push(m), {
      holders: () => [STRAY],
      kill: () => true,            // taskkill "succeeded" as far as the caller could tell
      alive: () => true,           // ...and the process is still there
      settleMs: 0,
    });
    expect(n).toBe(0);
    const said = logs.join('\n');
    expect(said).toContain('12712');
    expect(said).toMatch(/STILL RUNNING/);
    expect(said).not.toMatch(/killed 1/);
  });

  it('a kill that returns and the process is gone is counted', () => {
    let dead = false;
    const n = reapPort(REAP_TEST_PORT, () => {}, {
      holders: () => [STRAY],
      kill: () => { dead = true; },
      alive: () => !dead,
      settleMs: 0,
    });
    expect(n).toBe(1);
  });
});

// ── ownership facts ride on each holder when a guard asks (the whisper reap's guard needs to
// know whether a SERVICE owns the process; the console guard never did). ───────────────────
describe('reapPort passes each holder\'s owner facts to the guard and names them in the refusal', () => {
  it('the guard sees `service`, the refusal line names the service, and `explain` replaces the console-limb wording', () => {
    const logs = []; const seen = [];
    const n = reapPort(REAP_TEST_PORT, (m) => logs.push(m), {
      holders: () => [{ pid: '6716', name: 'whisper-server.exe', cmdline: null, service: 'WhisperServer' }],
      kill: () => { throw new Error('must not be called'); },
      alive: () => true,
      mine: (h) => { seen.push(h); return false; },
      mineLabel: 'a stray whisper-server',
      explain: () => 'the WhisperServer service owns it and restarts it on exit',
    });
    expect(n).toBe(0);
    expect(seen[0]).toMatchObject({ pid: '6716', service: 'WhisperServer' });
    const said = logs.join('\n');
    expect(said).toContain('service WhisperServer');
    expect(said).toContain('the WhisperServer service owns it');
    expect(said).not.toMatch(/operator console/);
  });
});

describe('pidAlive', () => {
  it('is true for this process and false for a pid nothing runs as', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(987654321)).toBe(false);
    expect(pidAlive(null)).toBe(false);
  });
});

describe('isOwnSpine', () => {
  it('is true only for a node process whose command line runs egpt-spine.mjs', () => {
    expect(isOwnSpine({ name: 'node.exe', cmdline: 'node C:\\Users\\an\\bin\\egpt\\egpt-spine.mjs' })).toBe(true);
    expect(isOwnSpine({ name: 'node', cmdline: '/usr/bin/node /home/an/src/egpt/egpt-spine.mjs' })).toBe(true);
    expect(isOwnSpine({ name: 'node.exe', cmdline: 'node C:\\other\\app.mjs' })).toBe(false);
    expect(isOwnSpine({ name: 'Beeper.exe', cmdline: 'Beeper.exe --egpt-spine.mjs' })).toBe(false);
    expect(isOwnSpine({ name: null, cmdline: null })).toBe(false);
    expect(isOwnSpine({ name: 'node.exe', cmdline: null })).toBe(false);
  });
});
