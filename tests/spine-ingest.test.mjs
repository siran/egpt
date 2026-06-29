// The command ingest box: lifecycle mapping + the consume-on-read sweep, against
// an in-memory dir. No fs, no process.exit.
import { describe, it, expect } from 'vitest';
import { createIngest, lifecycleExit } from '../src/spine/ingest.mjs';

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
