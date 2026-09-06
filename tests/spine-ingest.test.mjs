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

  // --- /standdown: the Session 0 → Session 1 handover verb (chunk 1 of the handover plan) ---
  // The PORT reaches the daemon by the SAME mechanism /rewind's ref does — an injected writer
  // that drops a sidecar in EGPT_HOME — never a second one.
  it('/standdown returns 45 and writes NOTHING when no port is named', () => {
    const ports = [];
    expect(lifecycleExit('/standdown', { writeStanddownTarget: (p) => ports.push(p) })).toBe(45);
    expect(lifecycleExit('  /standdown \n')).toBe(45);              // trimmed like every other token
    expect(ports).toEqual([]);   // absent sidecar = "the profile's own console port" (daemon-runtime's standdownPort)
  });
  it('/standdown <port> returns 45 and writes the stand-down target', () => {
    const ports = [];
    expect(lifecycleExit('/standdown 23375', { writeStanddownTarget: (p) => ports.push(p) })).toBe(45);
    expect(ports).toEqual(['23375']);
    expect(lifecycleExit('/standdown 1', { writeStanddownTarget: (p) => ports.push(p) })).toBe(45);
    expect(lifecycleExit('/standdown 65535', { writeStanddownTarget: (p) => ports.push(p) })).toBe(45);
    expect(ports).toEqual(['23375', '1', '65535']);
  });
  it('a MALFORMED port is not a stand-down at all — null, and no sidecar is written', () => {
    const ports = [];
    const w = { writeStanddownTarget: (p) => ports.push(p) };
    for (const line of ['/standdown abc', '/standdown 0', '/standdown -1', '/standdown 65536', '/standdown 23375.5', '/standdown 23375 extra', '/standdown 0x5b57']) {
      expect(lifecycleExit(line, w)).toBe(null);     // unknown command — boot logs "ignored", nothing exits
    }
    expect(ports).toEqual([]);
    expect(lifecycleExit('/standdownnow', w)).toBe(null);   // the token is the whole word
    expect(ports).toEqual([]);
  });
  it('the three existing tokens are untouched by the fourth — same codes, and /standdown never writes the rewind target', () => {
    const refs = [], ports = [];
    const w = { writeRewindTarget: (r) => refs.push(r), writeStanddownTarget: (p) => ports.push(p) };
    expect(lifecycleExit('/restart', w)).toBe(43);
    expect(lifecycleExit('/upgrade', w)).toBe(42);
    expect(lifecycleExit('/rewind abc123', w)).toBe(44);
    expect(lifecycleExit('hello', w)).toBe(null);
    expect(lifecycleExit('', w)).toBe(null);
    expect(lifecycleExit(null, w)).toBe(null);
    expect(refs).toEqual(['abc123']);   // only /rewind wrote
    expect(lifecycleExit('/standdown 23375', w)).toBe(45);
    expect(refs).toEqual(['abc123']);   // …and the stand-down did not touch it
    expect(ports).toEqual(['23375']);
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

  it('wires a /standdown <port> file to exit 45 AND the sidecar (the boot handle\'s shape)', async () => {
    const { io } = memDir({ go: '/standdown 23376\n' });
    const exits = [], ports = [];
    const ing = createIngest({ dir: '/ingest', io, handle: async (line) => {
      const c = lifecycleExit(line, { writeStanddownTarget: (p) => ports.push(p) });
      if (c != null) exits.push(c);
    } });
    await ing.sweep();
    expect(exits).toEqual([45]);
    expect(ports).toEqual(['23376']);
    ing.stop();
  });

  it('a missing dir is a no-op (never throws)', async () => {
    const io = { readdir: async () => { throw Object.assign(new Error('nodir'), { code: 'ENOENT' }); }, readFile: async () => '', unlink: async () => {}, mkdir: async () => {} };
    const ing = createIngest({ dir: '/nope', io, handle: async () => { throw new Error('should not run'); } });
    await expect(ing.sweep()).resolves.toBeUndefined();
  });
});
