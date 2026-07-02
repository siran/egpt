// The declarative heartbeat loader (src/spine/heartbeat-loader.mjs): the pure
// frequency parser + entity-block parser, the two-phase collect()/activate() API
// (default-alive injection / override / disable, namespacing, finestMs math), the
// readonly.yaml materialization, and the command action (shell spawn with entity
// cwd + pump-stats env, overlap guard, non-zero exit only logs). All fakes — the
// loader never touches the real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHeartbeatLoader, parseFrequency, parseHeartbeatsBlock } from '../src/spine/heartbeat-loader.mjs';

// ── fakes ───────────────────────────────────────────────────────────────────
function makeFakeChild() {
  const handlers = {};
  return { on(ev, cb) { handlers[ev] = cb; return this; }, emit(ev, ...a) { handlers[ev]?.(...a); } };
}
function makeSpawn() {
  const calls = [];
  const spawn = (cmd, opts) => { const child = makeFakeChild(); calls.push({ cmd, opts, child }); return child; };
  return { spawn, calls };
}
function makeRegistry() {
  const registered = [];
  return { register: (name, everyMs, fn) => registered.push({ name, everyMs, fn }), registered };
}
const noopIo = () => ({ writeFile: async () => {}, mkdir: async () => {} });

// ── parseFrequency ────────────────────────────────────────────────────────
describe('parseFrequency', () => {
  it('numbers pass through as ms; strings carry a ms/s/m/h unit (int or decimal)', () => {
    expect(parseFrequency(60000)).toBe(60000);
    expect(parseFrequency(1000)).toBe(1000);
    expect(parseFrequency('500ms')).toBe(500);
    expect(parseFrequency('1s')).toBe(1000);
    expect(parseFrequency('30s')).toBe(30000);
    expect(parseFrequency('5m')).toBe(300000);
    expect(parseFrequency('1h')).toBe(3600000);
    expect(parseFrequency('1.5s')).toBe(1500);
    expect(parseFrequency('0.5h')).toBe(1800000);
    expect(parseFrequency(' 2s ')).toBe(2000);   // trimmed
  });
  it('garbage / unitless / non-positive → null', () => {
    for (const g of ['', '5', '10x', 'abc', 's', 'ms', '0s', -5, 0, NaN, null, undefined, {}, [], true]) {
      expect(parseFrequency(g), `${JSON.stringify(g)} should be null`).toBeNull();
    }
  });
});

// ── parseHeartbeatsBlock ──────────────────────────────────────────────────
describe('parseHeartbeatsBlock', () => {
  it('extracts the heartbeats: map; absent / empty / malformed / unrelated → {}', () => {
    expect(parseHeartbeatsBlock(null)).toEqual({});
    expect(parseHeartbeatsBlock('')).toEqual({});
    expect(parseHeartbeatsBlock(': : not yaml : :')).toEqual({});
    expect(parseHeartbeatsBlock('transcription:\n  enabled: false\n')).toEqual({});
    expect(parseHeartbeatsBlock('heartbeats:\n  cleanup:\n    frequency: 5m\n    command: node x.js\n'))
      .toEqual({ cleanup: { frequency: '5m', command: 'node x.js' } });
  });
});

// ── collect() ─────────────────────────────────────────────────────────────
describe('createHeartbeatLoader.collect', () => {
  it('collects node-level command entries with source=config + the node cwd', async () => {
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { cleanup: { frequency: '5m', command: 'node cleanup.js' } } }),
      aliveMs: 0, procCwd: '/checkout',
    });
    const { entries } = await loader.collect();
    const c = entries.find((e) => e.name === 'cleanup');
    expect(c).toBeTruthy();
    expect(c.source).toBe('config');
    expect(c.everyMs).toBe(300000);
    expect(c.action).toEqual({ kind: 'command', command: 'node cleanup.js', cwd: '/checkout' });
  });

  it('injects the default alive command when the node config declares none (aliveMs>0)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({}), aliveMs: 60_000, aliveCommand: 'node alive.mjs', procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'alive', source: 'config', everyMs: 60_000, action: { kind: 'command', command: 'node alive.mjs', cwd: '/co' } });
  });

  it('does NOT inject the default alive when aliveMs=0 (test contract)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({}), aliveMs: 0 });
    expect((await loader.collect()).entries).toEqual([]);
  });

  it('an explicit config alive with no command falls back to the default alive command (even at aliveMs=0)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }), aliveMs: 0, aliveCommand: 'node alive.mjs', procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'alive', everyMs: 1000, action: { kind: 'command', command: 'node alive.mjs', cwd: '/co' } });
  });

  it('an explicit config alive command REPLACES the default alive script (no double-inject)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({ heartbeats: { alive: { frequency: '2s', command: 'node alive.js' } } }), aliveMs: 60_000, procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries.filter((e) => e.name === 'alive')).toHaveLength(1);
    const a = entries.find((e) => e.name === 'alive');
    expect(a.everyMs).toBe(2000);
    expect(a.action).toEqual({ kind: 'command', command: 'node alive.js', cwd: '/co' });
  });

  it('alive: false disables the deadman — no entry, logged', async () => {
    const logs = [];
    const loader = createHeartbeatLoader({ getConfig: () => ({ heartbeats: { alive: false } }), aliveMs: 60_000, onLog: (m) => logs.push(m) });
    const { entries } = await loader.collect();
    expect(entries.find((e) => e.name === 'alive')).toBeUndefined();
    expect(logs.some((l) => l.includes('alive disabled'))).toBe(true);
  });

  it('namespaces entity heartbeats and points source + cwd at the entity folder', async () => {
    const loader = createHeartbeatLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [
        { dir: '/home/conversations/whatsapp/diego-123', ns: 'whatsapp/diego-123' },
        { dir: '/home/rooms/standup', ns: 'room/standup' },
      ],
      readEntityConfig: async (dir) => dir.includes('diego')
        ? { reminder: { frequency: '10m', command: 'node remind.js' } }
        : { sweep: { frequency: '1h', command: 'node sweep.js' } },
    });
    const { entries } = await loader.collect();
    expect(entries.find((e) => e.name === 'whatsapp/diego-123:reminder')).toMatchObject({
      source: '/home/conversations/whatsapp/diego-123', everyMs: 600000,
      action: { kind: 'command', command: 'node remind.js', cwd: '/home/conversations/whatsapp/diego-123' },
    });
    expect(entries.find((e) => e.name === 'room/standup:sweep')).toMatchObject({ source: '/home/rooms/standup', everyMs: 3600000 });
  });

  it('skips a non-alive entry with an invalid frequency (logged, never fatal)', async () => {
    const logs = [];
    const loader = createHeartbeatLoader({ getConfig: () => ({ heartbeats: { bad: { frequency: 'nope', command: 'x' } } }), aliveMs: 0, onLog: (m) => logs.push(m) });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('bad') && l.includes('invalid frequency'))).toBe(true);
  });

  it('finestMs is the min cadence across every entry; null when there are none', async () => {
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { a: { frequency: '30s', command: 'x' }, b: { frequency: '5s', command: 'y' } } }),
      aliveMs: 60_000,
    });
    expect((await loader.collect()).finestMs).toBe(5000);   // b(5s) < a(30s) < alive(60s)
    const empty = createHeartbeatLoader({ getConfig: () => ({}), aliveMs: 0 });
    expect((await empty.collect()).finestMs).toBeNull();
  });
});

// ── activate() ────────────────────────────────────────────────────────────
describe('createHeartbeatLoader.activate', () => {
  it('registers every entry as a command beat and writes the readonly.yaml showing the REAL alive command + cwd (nothing hidden)', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'node src/tools/alive.mjs', egptHome: '/home', procCwd: '/co',
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    await loader.collect();
    await loader.activate({ registry, stats: () => ({ queueDepth: 0, oldestMs: 0 }) });

    expect(registry.registered).toHaveLength(1);
    expect(registry.registered[0]).toMatchObject({ name: 'alive', everyMs: 1000 });
    expect(registry.registered[0].fn).toBeTypeOf('function');   // the command beat, not an opaque builtin

    expect(writes).toHaveLength(1);
    expect(writes[0].p).toContain(join('state', 'heartbeats.readonly.yaml'));
    expect(writes[0].c).toContain('DO NOT EDIT');
    expect(writes[0].c).toContain('name: alive');
    expect(writes[0].c).toContain('source: config');
    expect(writes[0].c).toContain('command: node src/tools/alive.mjs');   // the real command, visible
    expect(writes[0].c).toContain('cwd: /co');
    expect(writes[0].c).not.toContain('builtin');
  });

  it('a command beat spawns a shell line with entity cwd + pump-stats env; overlap guard skips while running; non-zero exit only logs', async () => {
    const logs = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [{ dir: '/ent', ns: 'whatsapp/x' }],
      readEntityConfig: async () => ({ job: { frequency: '5s', command: 'node job.js' } }),
      spawn, env: { PATH: '/bin' }, egptHome: '/home',
      io: noopIo(), onLog: (m) => logs.push(m),
    });
    await loader.collect();
    await loader.activate({ registry, stats: () => ({ queueDepth: 3, oldestMs: 12000 }) });
    const beat = registry.registered.find((r) => r.name === 'whatsapp/x:job').fn;

    beat();   // first due tick → spawn the shell line
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('node job.js');
    expect(calls[0].opts).toMatchObject({ shell: true, cwd: '/ent' });
    expect(calls[0].opts.env).toMatchObject({ PATH: '/bin', EGPT_HOME: '/home', EGPT_QUEUE_DEPTH: '3', EGPT_QUEUE_OLDEST_MS: '12000' });

    beat();   // previous spawn still running → overlap guard skips + logs
    expect(calls).toHaveLength(1);
    expect(logs.some((l) => l.includes('still active'))).toBe(true);

    calls[0].child.emit('exit', 2);   // non-zero exit → logs, clears running
    expect(logs.some((l) => l.includes('exited 2'))).toBe(true);

    beat();   // free again → spawns anew
    expect(calls).toHaveLength(2);
  });
});
