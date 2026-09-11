// THE SPINE LOG HAD NO CLOCK (operator 2026-09-11).
//
// `~/.egpt/config/logs/service-stderr.log` carried 112,000 bare lines:
//
//     [heartbeat] alive: ok in 18ms
//     [bridge] beeper: incoming [chat] sender: "text" (atE=false)
//
// Not one of them could be placed on a clock. The operator reported that "E stops responding when
// the screensaver is on" and it could not be investigated AT ALL — nothing in the file could be
// lined up against a Windows wake timer, an event-log entry, or his own recollection of when he
// had written. A diagnostic hole, not a nicety.
//
// THE FIX IS AT THE ONE PLACE LINES ARE WRITTEN: boot.mjs builds ONE `log` object and threads
// `log.line` into every service's onLog, so every line in that file passes through the default
// sink — which now stamps. No call site stamps, and no second logger exists: a caller that
// injects its own `log` (every test, the shell) gets exactly what it asked for, unstamped. This
// file drives the REAL sink, and drives it through a REAL boot(), so "the default is the stamping
// one" is asserted rather than assumed.
//
// NOTHING PARSES THIS FILE. setup/verify-install.mjs checks the NSSM AppStdout/AppStderr PATHS
// (never the contents), setup/start-egpt.ps1 and setup/upgrade.ps1 only print the path for the
// operator to `Get-Content`, and setup/install-nssm-service.ps1 configures rotation. The single
// occurrence in the suite (tests/spine-pipe.test.mjs) quotes a line inside a COMMENT.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// EGPT_HOME is frozen from process.env ONCE at module load (egpt-home.mjs), and stop-guard's
// STOP_FILE with it — so the fixture profile is laid down and the env set BEFORE boot.mjs is
// imported, dynamically, below. Same mechanism tests/boot-profile-contract.test.mjs uses.
const HOME = mkdtempSync(join(tmpdir(), 'egpt-log-stamp-'));
process.env.EGPT_HOME = HOME;
// THE KILL SWITCH is the FIRST thing boot() does and it emits exactly ONE line before returning
// null through the `exit` seam — which makes it the cheapest honest way to observe a line that
// the REAL default sink wrote, with no bridge dialled, no pid file, no heartbeat.
writeFileSync(join(HOME, 'STOP'), 'so boot refuses, and says so in one line\n', 'utf8');

// `2026-09-11 13:25:07-04:00 ` — first on the line, fixed width, one space, then the line.
const STAMP = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) /;

let boot, logStamp, stderrLine;
beforeAll(async () => { ({ boot, logStamp, stderrLine } = await import('../src/spine/boot.mjs')); });
afterAll(() => { delete process.env.EGPT_HOME; try { rmSync(HOME, { recursive: true, force: true }); } catch { /* tmp */ } });

// Capture what actually reaches stderr. console.error is where the sink writes and where NSSM
// picks the file up, so this is the real byte stream, not a shim around it.
function captureStderr(fn) {
  const seen = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { seen.push(a.join(' ')); });
  try { return { seen, value: fn() }; } finally { spy.mockRestore(); }
}
async function captureStderrAsync(fn) {
  const seen = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { seen.push(a.join(' ')); });
  try { return { seen, value: await fn() }; } finally { spy.mockRestore(); }
}

describe('REPRODUCE — an emitted line carries a parseable timestamp', () => {
  it('a line boot() emits through its OWN default sink is stamped', async () => {
    let exited = null;
    const { seen, value } = await captureStderrAsync(() => boot({ exit: (c) => { exited = c; } }));

    expect(value).toBeNull();                       // the STOP file: boot refused to start
    expect(exited).toBe(0);                         // …and left through the clean-exit seam
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('egpt refuses to start');

    const m = seen[0].match(STAMP);                 // ← was null: the line was bare `[boot] …`
    expect(m).not.toBeNull();
    expect(seen[0].replace(STAMP, '')).toMatch(/^\[boot] /);   // the line itself is untouched after it
    // It is the WALL clock, not a frozen or invented one.
    expect(Math.abs(Date.parse(m[1]) - Date.now())).toBeLessThan(60_000);
  });

  it('the live log texture: `[heartbeat] alive: ok in 18ms` keeps its own text, with the clock in front', () => {
    const { seen } = captureStderr(() => stderrLine('[heartbeat] alive: ok in 18ms'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(STAMP);
    expect(seen[0].replace(STAMP, '')).toBe('[heartbeat] alive: ok in 18ms');
  });
});

describe('the stamp itself', () => {
  // Local, because the operator reads this beside Windows Event Viewer. With the offset, because
  // local alone repeats an hour every autumn and never says whose zone it was — and because
  // egpt-daemon.mjs stamps the STDOUT log in UTC, so the two files only correlate if the offset
  // is in the file. With the date, because the file spans days across restarts and rotations.
  it('is local wall time, to the second, carrying its UTC offset', () => {
    const d = new Date(2026, 8, 11, 3, 7, 5);       // 03:07 — the part of the night under investigation
    expect(logStamp(d)).toMatch(/^2026-09-11 03:07:05[+-]\d{2}:\d{2}$/);
  });

  it('round-trips: Date.parse reads back the very instant that was stamped', () => {
    for (const d of [new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 8, 11, 3, 7, 5), new Date(2026, 11, 31, 23, 59, 59)]) {
      expect([d.toISOString(), Date.parse(logStamp(d))]).toEqual([d.toISOString(), d.getTime()]);
    }
  });

  it('is fixed width and zero-padded, so `sort` orders the file and the eye reads a column', () => {
    const a = logStamp(new Date(2026, 8, 1, 9, 5, 3));
    const b = logStamp(new Date(2026, 8, 11, 10, 5, 3));
    expect(a).toHaveLength(25);
    expect(b).toHaveLength(25);
    expect(a).toContain('2026-09-01 09:05:03');      // padded — not `2026-9-1 9:5:3`
    expect([a, b].sort()).toEqual([a, b]);           // …which is what makes a plain string sort chronological
  });
});

describe('LOCKS — what must NOT move', () => {
  it('a caller that injects its OWN log is untouched — there is no second logger and no per-caller stamping', async () => {
    const lines = [];
    let exited = null;
    const { seen } = await captureStderrAsync(() => boot({ exit: (c) => { exited = c; }, log: { line: (s) => lines.push(s) } }));

    expect(exited).toBe(0);
    expect(seen).toEqual([]);                        // nothing reached stderr at all
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(STAMP);             // …and the injected sink got the bare line
    expect(lines[0]).toMatch(/^\[boot] /);
  });
});
