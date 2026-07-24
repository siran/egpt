// The command ingest box: lifecycle mapping + the consume-on-read sweep, against
// an in-memory dir. No fs, no process.exit.
import { describe, it, expect } from 'vitest';
import { createIngest, lifecycleExit, isShellConnectMarker } from '../src/spine/ingest.mjs';

describe('isShellConnectMarker', () => {
  it('recognizes the shell editor\'s self-announce (trimmed) and nothing else', () => {
    expect(isShellConnectMarker('/shell-connect')).toBe(true);
    expect(isShellConnectMarker('  /shell-connect  \n')).toBe(true);
    expect(isShellConnectMarker('/restart')).toBe(false);
    expect(isShellConnectMarker('')).toBe(false);
  });
});

// src/spine/boot.mjs's ingest `handle` checks isShellConnectMarker FIRST, before
// lifecycleExit, so the shell editor's self-announce pokes the shell-port limb instead of
// falling through to the lifecycle-exit path (or being logged as an unknown command). boot()
// itself wires no override seam for that composition, so this exercises the SAME two real,
// exported pure pieces wired in the exact shape boot.mjs uses, against a fake poke/exit —
// the minimal extraction the branch needs to be unit-tested in isolation.
describe('boot ingest handle — /shell-connect routes to shellPort.poke(), not lifecycleExit', () => {
  function makeHandle({ poke, exitFn }) {
    return async (line) => {
      if (isShellConnectMarker(line)) { poke(); return; }
      const code = lifecycleExit(line);
      if (code != null) await exitFn(code);
    };
  }

  it('/shell-connect pokes the shell-port limb and never reaches the lifecycle-exit path', async () => {
    const pokes = []; const exits = [];
    const handle = makeHandle({ poke: () => pokes.push(true), exitFn: async (c) => exits.push(c) });
    await handle('/shell-connect');
    expect(pokes).toEqual([true]);
    expect(exits).toEqual([]);
  });

  it('a real lifecycle command (/restart) is untouched by the new branch — still exits', async () => {
    const pokes = []; const exits = [];
    const handle = makeHandle({ poke: () => pokes.push(true), exitFn: async (c) => exits.push(c) });
    await handle('/restart');
    expect(exits).toEqual([43]);
    expect(pokes).toEqual([]);
  });
});

describe('lifecycleExit', () => {
  it('maps the lifecycle commands to the daemon exit codes', () => {
    expect(lifecycleExit('/restart')).toBe(43);
    expect(lifecycleExit('/upgrade')).toBe(42);
    expect(lifecycleExit('hello')).toBe(null);
    expect(lifecycleExit('')).toBe(null);
  });
  it('/rewind <ref> returns 44 and writes the rewind target', () => {
    const refs = [];
    expect(lifecycleExit('/rewind abc123', { writeRewindTarget: (r) => refs.push(r) })).toBe(44);
    expect(refs).toEqual(['abc123']);
    expect(lifecycleExit('/rewind')).toBe(44);   // no ref → still rewinds (daemon handles empty)
  });
});

function memDir(files) {
  const store = new Map(Object.entries(files));
  const base = (p) => p.split(/[\\/]/).pop();
  const io = {
    readdir: async () => [...store.keys()],
    readFile: async (p) => { if (!store.has(base(p))) throw new Error('ENOENT'); return store.get(base(p)); },
    unlink: async (p) => { store.delete(base(p)); },
    mkdir: async () => {},
  };
  return { io, store };
}

describe('createIngest sweep', () => {
  it('reads each file, hands its trimmed content to handle, and consumes it', async () => {
    const { io, store } = memDir({ 'a.cmd': '/restart\n', 'b.cmd': '  /upgrade ' });
    const seen = [];
    const ing = createIngest({ dir: '/ingest', io, handle: async (line) => seen.push(line) });
    await ing.sweep();
    expect(seen).toEqual(['/restart', '/upgrade']);   // sorted by name, trimmed
    expect(store.size).toBe(0);                        // both consumed
    ing.stop();
  });

  it('skips dotfiles and *.tmp (half-written files)', async () => {
    const { io, store } = memDir({ '.partial': 'x', 'cmd.tmp': '/restart', 'real': '/restart' });
    const seen = [];
    const ing = createIngest({ dir: '/ingest', io, handle: async (line) => seen.push(line) });
    await ing.sweep();
    expect(seen).toEqual(['/restart']);
    expect(store.has('.partial')).toBe(true);
    expect(store.has('cmd.tmp')).toBe(true);
  });

  it('wires a /restart file to exit 43 via lifecycleExit (no fs / no exit here)', async () => {
    const { io } = memDir({ go: '/restart' });
    const exits = [];
    const ing = createIngest({ dir: '/ingest', io, handle: async (line) => { const c = lifecycleExit(line); if (c != null) exits.push(c); } });
    await ing.sweep();
    expect(exits).toEqual([43]);
    ing.stop();
  });

  it('a missing dir is a no-op (never throws)', async () => {
    const io = { readdir: async () => { throw Object.assign(new Error('nodir'), { code: 'ENOENT' }); }, readFile: async () => '', unlink: async () => {}, mkdir: async () => {} };
    const ing = createIngest({ dir: '/nope', io, handle: async () => { throw new Error('should not run'); } });
    await expect(ing.sweep()).resolves.toBeUndefined();
  });
});
