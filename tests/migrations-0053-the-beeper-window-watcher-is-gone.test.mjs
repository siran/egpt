// tests/migrations-0053-the-beeper-window-watcher-is-gone.test.mjs — migrations/0053-the-beeper-window-watcher-is-gone.mjs.
//
// HKCU and the process table are fakes the migration's PowerShell scripts are dispatched against.
// Measured 2026-11-15: kg (reve) has the Run value and a watcher running (pid 9188); dolly has the
// Run value, its watcher already exited.
import { describe, it, expect } from 'vitest';
import { plan, elevated, RUN_VALUE } from '../migrations/0053-the-beeper-window-watcher-is-gone.mjs';

const VBS = '"C:\\WINDOWS\\System32\\wscript.exe" //B //Nologo "C:\\Users\\user\\bin\\egpt\\setup\\beeper-window.vbs"';

function fakeNode({ run = VBS, watchers = [] } = {}) {
  const state = { run, watchers: [...watchers] };
  const calls = [];
  const ps = (script) => {
    const head = script.split('\n')[0];
    calls.push(head);
    if (head === '# egpt-0053:probe') return JSON.stringify({ run: state.run, watchers: state.watchers });
    if (head === '# egpt-0053:remove-run') { state.run = null; return ''; }
    const pid = head.match(/^# egpt-0053:stop (\d+)$/)?.[1];
    if (!pid) throw new Error(`unexpected script: ${head}`);
    state.watchers = state.watchers.filter((p) => p !== Number(pid));
    return '';
  };
  return { ctx: { platform: 'win32', ps, log: () => {} }, state, calls };
}

describe('0053 — the egpt-beeper-window Run value and its watcher are gone', () => {
  it('needs no elevation (HKCU and the user\'s own process)', () => {
    expect(elevated).toBe(false);
  });

  it('kg: removes the Run value and stops the running watcher, then reads satisfied', async () => {
    const { ctx, state } = fakeNode({ watchers: [9188] });
    const p = await plan(ctx);
    expect(p.satisfied).toBe(false);
    expect(p.changes.join('\n')).toMatch(new RegExp(`${RUN_VALUE}[\\s\\S]*pid 9188`));
    await p.apply();
    expect(state).toEqual({ run: null, watchers: [] });
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('dolly: the Run value only', async () => {
    const { ctx, calls } = fakeNode();
    await (await plan(ctx)).apply();
    expect(calls.filter((c) => !c.endsWith('probe'))).toEqual(['# egpt-0053:remove-run']);
  });

  it('the probe never counts the daemon\'s own -Once pass as a watcher', async () => {
    const { probeScript } = await import('../migrations/0053-the-beeper-window-watcher-is-gone.mjs');
    expect(probeScript()).toMatch(/-notmatch '-Once'/);
  });

  it('nothing there → satisfied, nothing changed', async () => {
    const { ctx, calls } = fakeNode({ run: null });
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
    expect(calls).toEqual(['# egpt-0053:probe']);
  });

  it('off Windows → satisfied without touching PowerShell', async () => {
    const r = await plan({ platform: 'linux', ps: () => { throw new Error('no ps'); } });
    expect(r.satisfied).toBe(true);
  });
});
