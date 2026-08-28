// The declarative heartbeat loader (src/spine/heartbeat-loader.mjs): the pure
// frequency parser + entity-block parser, the two-phase collect()/activate() API
// (default-alive injection / override / disable, namespacing, finestMs math), the
// readonly.yaml materialization, and the command action (shell spawn with entity
// cwd + pump-stats env, overlap guard, non-zero exit only logs). All fakes — the
// loader never touches the real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHeartbeatLoader, parseFrequency, parseWhen, resolveTimeZone, zonedWallClockToEpoch } from '../src/spine/heartbeat-loader.mjs';
import { createConfigResolver, parseEntityConfig, NODE_FILE } from '../src/spine/config-resolver.mjs';
import { createHeartbeats } from '../src/spine/heartbeats.mjs';   // the REAL cadence registry, for the no-per-tick-spam lock
import { framePrompt } from '../src/tools/textecute.mjs';

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
  return {
    register: (name, everyMs, fn) => registered.push({ name, everyMs, fn }),
    clear: () => { registered.length = 0; },
    runDue: () => {},   // the spine's tick calls this directly now (wrapRegistry no longer decorates it)
    registered,
  };
}
// every beat the loader registered (there is no internal reload row anymore)
const beatsOf = (registry) => registry.registered;
const noopIo = () => ({ writeFile: async () => {}, mkdir: async () => {} });

// The loader no longer walks anything — it consumes the config RESOLVER's scan
// (src/spine/config-resolver.mjs). So every construction here builds a REAL resolver over
// the same fakes: what's under test is the walk the spine actually runs. The resolver's own
// two aggregates go to a THROWAWAY io by default so the write assertions below stay about
// heartbeats.readonly.yaml; pass `resolverIo` to observe all three together.
function makeLoader({ getConfig = () => ({}), listEntityDirs, readEntityConfig, egptHome = '/home', resolverIo, ...rest } = {}) {
  const resolver = createConfigResolver({
    getConfig, listEntityDirs, readEntityConfig, egptHome,
    io: resolverIo ?? noopIo(),
  });
  return createHeartbeatLoader({ resolver, egptHome, ...rest });
}

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

// ── parseEntityConfig (the ONE tolerant entity-file parse; it replaced the
//    per-block text parsers, this module's old parseHeartbeatsBlock included) ──
describe('parseEntityConfig', () => {
  it('absent / empty / malformed / non-map → {}; a real doc keeps EVERY block, not just one', () => {
    expect(parseEntityConfig(null)).toEqual({});
    expect(parseEntityConfig('')).toEqual({});
    expect(parseEntityConfig(': : not yaml : :')).toEqual({});
    expect(parseEntityConfig('- a\n- b\n')).toEqual({});
    expect(parseEntityConfig('transcription_service:\n  enabled: false\n')).toEqual({ transcription_service: { enabled: false } });
    expect(parseEntityConfig('heartbeats:\n  cleanup:\n    frequency: 5m\n    command: node x.js\n'))
      .toEqual({ heartbeats: { cleanup: { frequency: '5m', command: 'node x.js' } } });
  });
});

// ── collect() ─────────────────────────────────────────────────────────────
describe('createHeartbeatLoader.collect', () => {
  it('collects node-level command entries with source = the node FILE + the node cwd', async () => {
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { cleanup: { frequency: '5m', command: 'node cleanup.js' } } }),
      aliveMs: 0, procCwd: '/checkout',
    });
    const { entries } = await loader.collect();
    const c = entries.find((e) => e.name === 'cleanup');
    expect(c).toBeTruthy();
    expect(c.source).toBe(NODE_FILE);
    expect(c.everyMs).toBe(300000);
    expect(c.action).toEqual({ kind: 'command', command: 'node cleanup.js', cwd: '/checkout' });
  });

  it('injects the default alive command (echo one-liner, cwd = EGPT_HOME) when the node config declares none (aliveMs>0)', async () => {
    const loader = makeLoader({ getConfig: () => ({}), aliveMs: 60_000, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home', procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries).toHaveLength(1);
    // cwd is the PROFILE, not the checkout — the relative state/ must resolve into ~/.egpt
    expect(entries[0]).toMatchObject({ name: 'alive', source: NODE_FILE, everyMs: 60_000, action: { kind: 'command', command: 'echo beat > state/alive.txt', cwd: '/home' } });
  });

  it('does NOT inject the default alive when aliveMs=0 (test contract)', async () => {
    const loader = makeLoader({ getConfig: () => ({}), aliveMs: 0 });
    expect((await loader.collect()).entries).toEqual([]);
  });

  it('an explicit config alive with no command falls back to the default alive command + EGPT_HOME cwd (even at aliveMs=0)', async () => {
    const loader = makeLoader({ getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }), aliveMs: 0, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home', procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'alive', everyMs: 1000, action: { kind: 'command', command: 'echo beat > state/alive.txt', cwd: '/home' } });
  });

  it('an explicit config alive command REPLACES the default alive script (no double-inject)', async () => {
    const loader = makeLoader({ getConfig: () => ({ heartbeats: { alive: { frequency: '2s', command: 'node alive.js' } } }), aliveMs: 60_000, procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries.filter((e) => e.name === 'alive')).toHaveLength(1);
    const a = entries.find((e) => e.name === 'alive');
    expect(a.everyMs).toBe(2000);
    expect(a.action).toEqual({ kind: 'command', command: 'node alive.js', cwd: '/co' });
  });

  it('alive: false disables the deadman — no entry, logged', async () => {
    const logs = [];
    const loader = makeLoader({ getConfig: () => ({ heartbeats: { alive: false } }), aliveMs: 60_000, onLog: (m) => logs.push(m) });
    const { entries } = await loader.collect();
    expect(entries.find((e) => e.name === 'alive')).toBeUndefined();
    expect(logs.some((l) => l.includes('alive disabled'))).toBe(true);
  });

  it('namespaces entity heartbeats and points source + cwd at the entity folder', async () => {
    const loader = makeLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [
        { dir: '/home/conversations/whatsapp/diego-123', ns: 'whatsapp/diego-123' },
        { dir: '/home/rooms/standup', ns: 'room/standup' },
      ],
      readEntityConfig: async (dir) => dir.includes('diego')
        ? { heartbeats: { reminder: { frequency: '10m', command: 'node remind.js' } } }
        : { heartbeats: { sweep: { frequency: '1h', command: 'node sweep.js' } } },
    });
    const { entries } = await loader.collect();
    expect(entries.find((e) => e.name === 'whatsapp/diego-123:reminder')).toMatchObject({
      source: 'config/rooms.yaml', everyMs: 600000,
      action: { kind: 'command', command: 'node remind.js', cwd: '/home/conversations/whatsapp/diego-123' },
    });
    expect(entries.find((e) => e.name === 'room/standup:sweep')).toMatchObject({ source: 'config/rooms.yaml', everyMs: 3600000 });
  });

  it('skips a non-alive entry with an invalid frequency (logged, never fatal)', async () => {
    const logs = [];
    const loader = makeLoader({ getConfig: () => ({ heartbeats: { bad: { frequency: 'nope', command: 'x' } } }), aliveMs: 0, onLog: (m) => logs.push(m) });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('bad') && l.includes('invalid frequency'))).toBe(true);
  });

  it('finestMs is the min cadence across every entry; null when there are none', async () => {
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { a: { frequency: '30s', command: 'x' }, b: { frequency: '5s', command: 'y' } } }),
      aliveMs: 60_000,
    });
    expect((await loader.collect()).finestMs).toBe(5000);   // b(5s) < a(30s) < alive(60s)
    const empty = makeLoader({ getConfig: () => ({}), aliveMs: 0 });
    expect((await empty.collect()).finestMs).toBeNull();
  });
});

// ── activate() ────────────────────────────────────────────────────────────
describe('createHeartbeatLoader.activate', () => {
  it('registers every entry as a command beat and writes the readonly.yaml showing the REAL alive command + cwd (nothing hidden)', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home', procCwd: '/co',
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({ queueDepth: 0, oldestMs: 0 }) });

    const beats = beatsOf(registry);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ name: 'alive', everyMs: 1000 });
    expect(beats[0].fn).toBeTypeOf('function');   // the command beat, not an opaque builtin

    expect(writes).toHaveLength(1);
    expect(writes[0].p).toBe(join('/home', 'heartbeats.readonly.yaml'));   // the PROFILE ROOT — state/ hides too much
    expect(writes[0].c).toContain('DO NOT EDIT');
    expect(writes[0].c).toContain('name: alive');
    expect(writes[0].c).toContain('source: config');
    expect(writes[0].c).toContain('command: echo beat > state/alive.txt');   // the real command, visible
    expect(writes[0].c).toContain('cwd: /home');   // the profile (EGPT_HOME), where state/ resolves
    expect(writes[0].c).not.toContain('builtin');
  });

  it('a command beat spawns a shell line with entity cwd + pump-stats env; overlap guard skips while running; non-zero exit only logs', async () => {
    const logs = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [{ dir: '/ent', ns: 'whatsapp/x' }],
      readEntityConfig: async () => ({ heartbeats: { job: { frequency: '5s', command: 'node job.js' } } }),
      spawn, env: { PATH: '/bin' }, egptHome: '/home',
      io: noopIo(), onLog: (m) => logs.push(m),
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({ queueDepth: 3, oldestMs: 12000 }) });
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

// ── time zone resolution + wall-clock → epoch (pure) ────────────────────────
describe('resolveTimeZone', () => {
  it('canonical IANA names pass; aliases map (case-insensitive); invalid/absent → machine local (invalid logged)', () => {
    expect(resolveTimeZone('America/Chicago')).toBe('America/Chicago');
    expect(resolveTimeZone('New York')).toBe('America/New_York');
    expect(resolveTimeZone('et')).toBe('America/New_York');
    expect(resolveTimeZone('EST')).toBe('America/New_York');
    expect(resolveTimeZone('EDT')).toBe('America/New_York');
    expect(resolveTimeZone('CST')).toBe('America/Chicago');
    expect(resolveTimeZone('MST')).toBe('America/Denver');
    expect(resolveTimeZone('PST')).toBe('America/Los_Angeles');
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(resolveTimeZone('gmt')).toBe('UTC');
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveTimeZone(null)).toBe(local);   // absent → machine local, silently
    expect(resolveTimeZone('')).toBe(local);
    const logs = [];
    expect(resolveTimeZone('Nowhere/Bogus', { onLog: (m) => logs.push(m) })).toBe(local);
    expect(logs.some((l) => l.includes('invalid zone'))).toBe(true);
  });
});

describe('zonedWallClockToEpoch — DST-correct, deterministic fixed cases', () => {
  it('January noon in New York is EST (−5) → 17:00Z; July 8:20 is EDT (−4) → 12:20Z', () => {
    expect(zonedWallClockToEpoch({ year: 2026, month: 1, day: 15, hour: 12, minute: 0 }, 'America/New_York'))
      .toBe(Date.UTC(2026, 0, 15, 17, 0));   // EST, −5
    expect(zonedWallClockToEpoch({ year: 2026, month: 7, day: 2, hour: 8, minute: 20 }, 'America/New_York'))
      .toBe(Date.UTC(2026, 6, 2, 12, 20));   // EDT, −4
    // UTC is a no-op
    expect(zonedWallClockToEpoch({ year: 2026, month: 7, day: 2, hour: 8, minute: 20 }, 'UTC'))
      .toBe(Date.UTC(2026, 6, 2, 8, 20));
  });
});

// ── parseWhen (pure) ────────────────────────────────────────────────────────
describe('parseWhen', () => {
  const NY = { timeZone: 'America/New_York' };
  const UTC = { timeZone: 'UTC' };
  it('the two anchor cases: 12h am → EDT 12:20Z, 24h noon Jan → EST 17:00Z', () => {
    expect(parseWhen('7/2/2026 8:20a', NY)).toBe(Date.UTC(2026, 6, 2, 12, 20));
    expect(parseWhen('1/15/2026 12:00', NY)).toBe(Date.UTC(2026, 0, 15, 17, 0));
  });
  it('12-hour am/pm accepts a/p/am/pm with or without a space; noon/midnight edges', () => {
    const morning = Date.UTC(2026, 6, 2, 12, 20);
    for (const s of ['7/2/2026 8:20a', '7/2/2026 8:20 a', '7/2/2026 8:20am', '7/2/2026 8:20 AM', '7/2/2026 8:20A']) {
      expect(parseWhen(s, NY), s).toBe(morning);
    }
    // pm is exactly 12h later than am
    expect(parseWhen('7/2/2026 8:20p', NY) - parseWhen('7/2/2026 8:20a', NY)).toBe(12 * 3_600_000);
    // 12:00a = midnight, 12:00p = noon
    expect(parseWhen('7/2/2026 12:00a', UTC)).toBe(Date.UTC(2026, 6, 2, 0, 0));
    expect(parseWhen('7/2/2026 12:00p', UTC)).toBe(Date.UTC(2026, 6, 2, 12, 0));
  });
  it('24-hour and ISO (optional seconds) resolve the same wall-clock', () => {
    expect(parseWhen('7/2/2026 20:20', NY)).toBe(parseWhen('7/2/2026 8:20p', NY));
    expect(parseWhen('2026-07-02T08:20', NY)).toBe(parseWhen('7/2/2026 8:20a', NY));
    expect(parseWhen('2026-07-02T08:20:30', UTC)).toBe(Date.UTC(2026, 6, 2, 8, 20, 30));
  });
  it('garbage / out-of-range / non-string → null', () => {
    for (const g of ['', 'nope', '7/2/2026 8:20x', '7/2/26 8:20a', '2026-13-02T08:20', '7/2/2026 25:00',
                     '7/2/2026 8:70', '13/40/2026 10:00', '2026-07-02', null, undefined, 42, {}]) {
      expect(parseWhen(g, UTC), `${JSON.stringify(g)} should be null`).toBeNull();
    }
  });
});

// ── when: one-shot entries ──────────────────────────────────────────────────
describe('createHeartbeatLoader — when: one-shots', () => {
  it('a when entry rides the tick (everyMs 0), fires ONCE at/after the time, never twice', async () => {
    const whenMs = Date.UTC(2026, 6, 2, 12, 20);   // 7/2/2026 8:20a America/New_York
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({ default_time_zone: 'America/New_York', heartbeats: { report: { when: '7/2/2026 8:20a', command: 'node report.js' } } }),
      aliveMs: 0, spawn, egptHome: '/home', io: noopIo(),
      now: () => whenMs - 5 * 60_000,   // 5 min BEFORE the time → armed (future)
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });

    const beat = beatsOf(registry).find((r) => r.name === 'report');
    expect(beat.everyMs).toBe(0);           // one-shots ride the tick, never tighten it

    beat.fn(whenMs - 1000);                 // not due yet
    expect(calls).toHaveLength(0);
    beat.fn(whenMs);                        // due → fires once
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('node report.js');
    beat.fn(whenMs + 60_000);               // already fired → never again
    expect(calls).toHaveLength(1);
  });

  it('a when >2 min in the past is stale — skipped + logged; within the 2-min grace is armed', async () => {
    const logs = [];
    const stale = makeLoader({
      getConfig: () => ({ default_time_zone: 'UTC', heartbeats: { old: { when: '7/2/2026 08:20', command: 'x' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m),
      now: () => Date.UTC(2026, 6, 2, 8, 23),   // 3 min after → stale
    });
    expect((await stale.collect()).entries.find((e) => e.name === 'old')).toBeUndefined();
    expect(logs.some((l) => l.includes('stale when'))).toBe(true);

    const grace = makeLoader({
      getConfig: () => ({ default_time_zone: 'UTC', heartbeats: { recent: { when: '7/2/2026 08:20', command: 'x' } } }),
      aliveMs: 0, io: noopIo(),
      now: () => Date.UTC(2026, 6, 2, 8, 21),   // 1 min after → within grace
    });
    expect((await grace.collect()).entries.find((e) => e.name === 'recent'))
      .toMatchObject({ whenMs: Date.UTC(2026, 6, 2, 8, 20), fired: false });
  });

  it('an entry with BOTH when and frequency is invalid — skipped + logged', async () => {
    const logs = [];
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { bad: { when: '7/2/2026 08:20', frequency: '5m', command: 'x' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m), now: () => 0,
    });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('both frequency and when'))).toBe(true);
  });

  it('when entries do NOT influence finestMs (only recurring cadences do)', async () => {
    const loader = makeLoader({
      getConfig: () => ({ default_time_zone: 'UTC', heartbeats: {
        soon: { when: '7/2/2026 08:20', command: 'x' },
        sweep: { frequency: '30s', command: 'y' },
      } }),
      aliveMs: 0, io: noopIo(), now: () => Date.UTC(2026, 6, 2, 8, 19),
    });
    expect((await loader.collect()).finestMs).toBe(30_000);   // the frequency entry, not the when one
  });
});

// ── script_path: textecutable sugar ──────────────────────────────────────────────
describe('createHeartbeatLoader — script_path:', () => {
  it('expands script_path to a node textecute.mjs command (script relative → entry cwd); readonly shows BOTH forms', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { daily: { frequency: '24h', script_path: 'reports/daily.x.md' } } }),
      aliveMs: 0, procCwd: '/checkout', egptHome: '/home',
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    const { entries } = await loader.collect();
    const e = entries.find((x) => x.name === 'daily');
    expect(e.action.scriptPath).toBe('reports/daily.x.md');
    expect(e.action.command).toContain('textecute.mjs');
    expect(e.action.command).toContain('reports/daily.x.md');
    expect(e.action.cwd).toBe('/checkout');            // relative script resolves against this cwd

    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    const readonly = writes.at(-1).c;
    expect(readonly).toContain('script_path: reports/daily.x.md');   // the sugar
    expect(readonly).toContain('textecute.mjs');                // AND the resolved command
    expect(readonly).toContain('command:');
  });

  it('an entry with BOTH command and script_path is invalid — skipped + logged', async () => {
    const logs = [];
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { dbl: { frequency: '5m', command: 'x', script_path: 'y.x.md' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m),
    });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('both command and script_path'))).toBe(true);
  });

  // The 2026-08-22 rename is HARD — no alias, no deprecation window. The point of making the
  // old key INVALID rather than merely unknown: an entry still carrying ai_run: would
  // otherwise fall through to "no action" and become a silent no-op on a cadence the
  // operator still sees armed. It is skipped like any malformed entry, and the log carries
  // the fix.
  it('the OLD ai_run: key is invalid — skipped + logged naming script_path:, and fires NOTHING', async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    for (const raw of [
      { frequency: '5m', ai_run: 'y.x.md' },
      { frequency: '5m', agent: 'pi', ai_run: 'y.x.md' },
      { when: '7/2/2026 08:20', ai_run: 'y.x.md' },
    ]) {
      const logs = [];
      const turns = [];
      const { spawn, calls } = makeSpawn();
      const registry = makeRegistry();
      const loader = makeLoader({
        getConfig: () => ({ default_time_zone: 'UTC', agents: { pi: {} }, heartbeats: { legacy: raw } }),
        aliveMs: 0, spawn, dispatchTurn: async (t) => { turns.push(t); },
        io: noopIo(), onLog: (m) => logs.push(m), now: () => Date.UTC(2026, 6, 2, 8, 19),
      });
      loader.wrapRegistry(registry);
      expect((await loader.collect()).entries, JSON.stringify(raw)).toEqual([]);
      expect(logs.some((l) => l.includes('legacy') && l.includes('ai_run: was renamed to script_path:')), JSON.stringify(raw)).toBe(true);

      await loader.activate({ stats: () => ({}) });
      expect(beatsOf(registry)).toHaveLength(0);   // nothing registered → nothing can ever fire
      await flush();
      expect(calls).toHaveLength(0);               // no textecute spawn
      expect(turns).toHaveLength(0);               // no being turn either
    }
  });
});

// ── agent: — a script_path that runs as a BEING (operator 2026-08-22) ───────────
// A bare script_path spawns textecute.mjs, whose own CLI session bypasses the being system
// entirely (no access_level, no allowed_users, no sandboxed). `agent: <being-id>` dispatches
// the SAME framed prompt as a TURN through boot's injected dispatcher (brainpool.turn), so
// every confinement gate applies. All fakes here — no session opens, no process spawns.
describe('createHeartbeatLoader — agent: (a heartbeat that runs as a being)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const CONFIG = { agents: { egpt: { default: true }, pi: { mode: 'mention' } } };

  // One room entity, one beat, everything injectable. `raw` is the beat's declaration.
  function build(raw, { dispatchTurn, script = 'This is the DJ script.\n', config = CONFIG } = {}) {
    const logs = [];
    const turns = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    const reads = [];
    const loader = makeLoader({
      getConfig: () => config,
      aliveMs: 0, procCwd: '/checkout', egptHome: '/home', spawn,
      listEntityDirs: async () => [{ dir: '/home/conversations/room/dj-son', ns: 'room/dj-son' }],
      readEntityConfig: async () => ({ heartbeats: { dj: raw } }),
      dispatchTurn: dispatchTurn ?? (async (t) => { turns.push(t); }),
      io: { writeFile: async () => {}, mkdir: async () => {}, readFile: async (p) => { reads.push(p); return script; } },
      onLog: (m) => logs.push(m),
    });
    return { loader, registry, logs, turns, calls, reads };
  }

  it('dispatches a brainpool TURN for the named being with textecute\'s framed prompt — and spawns NOTHING', async () => {
    const { loader, registry, turns, calls, reads } = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' });
    const { entries } = await loader.collect();
    const e = entries.find((x) => x.name === 'room/dj-son:dj');
    expect(e.action).toMatchObject({ kind: 'turn', being: 'pi', script: 'dj.x.md', ns: 'room/dj-son', cwd: '/home/conversations/room/dj-son' });
    expect(e.action.command).toBeUndefined();   // no shell line was built at all

    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    beatsOf(registry).find((r) => r.name === 'room/dj-son:dj').fn();
    await flush();

    expect(calls).toHaveLength(0);                      // no process, ever
    expect(reads[0]).toContain('dj.x.md');              // the script is read FRESH, at the entity cwd
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ being: 'pi', ns: 'room/dj-son', name: 'room/dj-son:dj' });
    // the prompt contract is textecute's own, byte for byte
    expect(turns[0].prompt).toBe(framePrompt('dj.x.md', 'This is the DJ script.\n'));
  });

  it('the SAME entry WITHOUT agent: still expands to the textecute shell command (regression lock)', async () => {
    const { loader, registry, turns, calls } = build({ frequency: '30m', script_path: 'dj.x.md' });
    const { entries } = await loader.collect();
    const e = entries.find((x) => x.name === 'room/dj-son:dj');
    expect(e.action.kind).toBe('command');
    expect(e.action.command).toContain('textecute.mjs');
    expect(e.action.command).toContain('dj.x.md');

    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    beatsOf(registry).find((r) => r.name === 'room/dj-son:dj').fn();
    await flush();

    expect(calls).toHaveLength(1);                      // the shell line, exactly as before
    expect(calls[0].opts).toMatchObject({ shell: true, cwd: '/home/conversations/room/dj-son' });
    expect(turns).toHaveLength(0);                      // no turn dispatched
  });

  it('an unknown agent is skipped + logged — nothing registered, nothing fired', async () => {
    const { loader, registry, logs, turns, calls } = build({ frequency: '30m', agent: 'nobody', script_path: 'dj.x.md' });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('unknown agent') && l.includes('nobody'))).toBe(true);
    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    expect(beatsOf(registry)).toHaveLength(0);
    await flush();
    expect(turns).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('a token no agent declares is unknown: agent: "@p" is skipped + logged', async () => {
    const { loader, logs } = build({ frequency: '30m', agent: '@p', script_path: 'dj.x.md' });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('unknown agent'))).toBe(true);
  });

  // THE HANDLE, NOT THE KEY (operator 2026-08-28: "on dolly we use pd from egpt. that is that
  // agents.yaml should say. also, use the handle, not the key. it's a person, not an object haha").
  // DOLLY's pi agent is KEYED `pi` and declares `handles: [pd]`; nobody there ever types `pi`.
  // Resolution rides THE wake vocabulary (router.mjs addressed/wakeTokens) — the same scan an
  // @mention goes through — so a beat and a mention can never disagree about who `pd` is. The
  // RESOLVED value is still the map KEY: it keys warm sessions and the entry[<being>] threads.
  const DOLLY = { agents: { egpt: { default: true }, pi: { handles: ['pd'] } } };

  it('agent: names the HANDLE and resolves to the map KEY — agent: pd on a pi-keyed agent runs as being pi', async () => {
    const { loader, registry, turns } = build({ frequency: '30m', agent: 'pd', script_path: 'dj.x.md' }, { config: DOLLY });
    const { entries } = await loader.collect();
    const e = entries.find((x) => x.name === 'room/dj-son:dj');
    expect(e.action).toMatchObject({ kind: 'turn', being: 'pi', script: 'dj.x.md', ns: 'room/dj-son' });

    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    beatsOf(registry).find((r) => r.name === 'room/dj-son:dj').fn();
    await flush();
    expect(turns[0]).toMatchObject({ being: 'pi', ns: 'room/dj-son' });   // handle in, KEY out
  });

  it('a declared handles: list is COMPLETE — the KEY is not a wake token, so agent: pi is skipped + logged with the handles to use', async () => {
    const { loader, registry, logs, turns, calls } = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' }, { config: DOLLY });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('unknown agent') && l.includes('pd'))).toBe(true);
    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    expect(beatsOf(registry)).toHaveLength(0);
    await flush();
    expect(turns).toHaveLength(0);
    expect(calls).toHaveLength(0);       // never falls through to the unconfined textecute spawn
  });

  it('an agent declaring NO handles: is still addressed by its map key (wakeTokens\' other arm)', async () => {
    const { loader } = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' });   // CONFIG's pi declares no handles
    const e = (await loader.collect()).entries.find((x) => x.name === 'room/dj-son:dj');
    expect(e.action).toMatchObject({ kind: 'turn', being: 'pi' });
  });

  it('a declared-but-unusable agent: (empty, or not a string) is invalid — it NEVER falls through to the unconfined textecute spawn', async () => {
    for (const bad of ['', '   ', 42, true, ['pi'], { name: 'pi' }]) {
      const { loader, logs, calls } = build({ frequency: '30m', agent: bad, script_path: 'dj.x.md' });
      expect((await loader.collect()).entries, JSON.stringify(bad)).toEqual([]);
      expect(logs.some((l) => l.includes('not a being-id')), JSON.stringify(bad)).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it('agent: + command: is invalid — skipped + logged (a shell line has no being)', async () => {
    const { loader, logs } = build({ frequency: '30m', agent: 'pi', command: 'node dj.js' });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('both agent and command'))).toBe(true);
  });

  it('agent: without script_path:, a non-.x.md script_path, and agent: on a NODE-level beat are all invalid', async () => {
    const noScript = build({ frequency: '30m', agent: 'pi' });
    expect((await noScript.loader.collect()).entries).toEqual([]);
    expect(noScript.logs.some((l) => l.includes('without script_path'))).toBe(true);

    const plainMd = build({ frequency: '30m', agent: 'pi', script_path: 'dj.md' });
    expect((await plainMd.loader.collect()).entries).toEqual([]);
    expect(plainMd.logs.some((l) => l.includes('not a textecutable'))).toBe(true);

    const logs = [];
    const nodeLevel = makeLoader({
      getConfig: () => ({ ...CONFIG, heartbeats: { dj: { frequency: '30m', agent: 'pi', script_path: 'dj.x.md' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m),
    });
    expect((await nodeLevel.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('node-level beat'))).toBe(true);
  });

  it('the overlap guard holds for a turn: a still-running turn skips the tick, and the next one runs once it settles', async () => {
    let release;
    const turns = [];
    const inflight = async (t) => { turns.push(t); await new Promise((r) => { release = r; }); };
    const { loader, registry, logs } = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' }, { dispatchTurn: inflight });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    const beat = beatsOf(registry).find((r) => r.name === 'room/dj-son:dj').fn;

    beat(); await flush();
    expect(turns).toHaveLength(1);
    beat(); await flush();
    expect(turns).toHaveLength(1);                       // still running → skipped
    expect(logs.some((l) => l.includes('still active'))).toBe(true);

    release(); await flush();
    beat(); await flush();
    expect(turns).toHaveLength(2);                       // settled → free again
  });

  it('a failing turn logs and RELEASES the guard (a broken beat never wedges its own cadence)', async () => {
    const { loader, registry, logs, turns } = build(
      { frequency: '30m', agent: 'pi', script_path: 'dj.x.md' },
      { dispatchTurn: async () => { throw new Error('no conversation for room/dj-son'); } },
    );
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    const beat = beatsOf(registry).find((r) => r.name === 'room/dj-son:dj').fn;

    beat(); await flush();
    expect(logs.some((l) => l.includes('room/dj-son:dj') && l.includes('no conversation'))).toBe(true);
    beat(); await flush();                               // not wedged: it tries again
    expect(logs.filter((l) => l.includes('no conversation'))).toHaveLength(2);
    expect(turns).toHaveLength(0);
  });

  it('the readonly view shows the sugar AND who runs it — and no command line', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => CONFIG, aliveMs: 0, egptHome: '/home',
      listEntityDirs: async () => [{ dir: '/home/conversations/room/dj-son', ns: 'room/dj-son' }],
      readEntityConfig: async () => ({ heartbeats: { dj: { frequency: '30m', agent: 'pi', script_path: 'dj.x.md' } } }),
      dispatchTurn: async () => {},
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    const readonly = writes.at(-1).c;
    expect(readonly).toContain('script_path: dj.x.md');
    expect(readonly).toContain('agent: pi');
    expect(readonly).not.toContain('textecute.mjs');
  });
});

// ── reload() — config refresh on message arrival (2026-08, replacing the tick-based hot
//    reload): spine.mjs calls this (via boot.mjs's refreshConfig) at the top of handleFast,
//    on EVERY inbound message — no tick, no timer, no readonly-file-presence probe. wrapRegistry
//    no longer decorates runDue; it only hands the loader the real registry to register/clear
//    onto. ──────────────────────────────────────────────────────────────────────────────────
describe('createHeartbeatLoader.reload', () => {
  it('re-collects, replaces beats, picks up a new entity, rewrites the file — and NO internal row anywhere', async () => {
    let dirs = [];
    const writes = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home',
      listEntityDirs: async () => dirs,
      readEntityConfig: async () => ({ heartbeats: { ping: { frequency: '30s', command: 'node ping.js' } } }),
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
      now: () => 0,
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });

    // no internal beat is registered, and no internal row is in the readonly view
    expect(registry.registered.some((r) => r.name === 'heartbeats-reload')).toBe(false);
    expect(writes.at(-1).c).not.toContain('heartbeats-reload');
    expect(writes.at(-1).c).not.toContain('spine (internal)');

    // a NEW conversation appears on disk — reload() (as spine.mjs's handleFast would call
    // it on the next inbound message) picks it up, no tick/timer involved
    dirs = [{ dir: '/home/conversations/whatsapp/new-chat', ns: 'whatsapp/new-chat' }];
    await loader.reload();

    const names = registry.registered.map((r) => r.name);
    expect(names).toContain('alive');                              // re-registered
    expect(names).toContain('whatsapp/new-chat:ping');             // new entity picked up
    expect(names).not.toContain('heartbeats-reload');              // still no internal row
    expect(writes.at(-1).c).toContain('whatsapp/new-chat:ping');   // readonly rewritten
  });

  it('is a no-op before activate() — nothing is loaded yet, so there is nothing to reload', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat', egptHome: '/home',
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
      now: () => 0,
    });
    loader.wrapRegistry(registry);
    await loader.collect();   // NOT activated

    await loader.reload();
    expect(writes).toHaveLength(0);
    expect(registry.registered).toHaveLength(0);
  });

  it('guards reentrancy: a reload already in flight blocks a concurrent one (a burst of messages does not pile up re-collects)', async () => {
    const writes = [];
    const registry = makeRegistry();
    let calls = 0;
    const io = { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} };
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat', egptHome: '/home',
      listEntityDirs: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return []; },
      io, resolverIo: io,
      now: () => 0,
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });
    writes.length = 0;
    calls = 0;

    const first = loader.reload();    // in flight (listEntityDirs takes 5ms)
    const second = loader.reload();   // reentrancy guard → short-circuits immediately
    await Promise.all([first, second]);
    expect(calls).toBe(1);            // only ONE reload actually walked the entity dirs
    expect(writes).toHaveLength(3);   // exactly one reload wrote all three aggregates
  });

  it('warns when a reloaded finest cadence is finer than the fixed boot tick', async () => {
    let entBlock = { slow: { frequency: '30s', command: 'x' } };
    const logs = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [{ dir: '/ent', ns: 'whatsapp/x' }],
      readEntityConfig: async () => ({ heartbeats: entBlock }),
      io: noopIo(), onLog: (m) => logs.push(m), now: () => 0,
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });   // boot tick 30s; 30s cadence is NOT finer
    expect(logs.some((l) => l.includes('finer than the boot tick'))).toBe(false);

    entBlock = { fast: { frequency: '1s', command: 'y' } };   // a finer cadence appears
    await loader.reload();
    expect(logs.some((l) => l.includes('finer than the boot tick'))).toBe(true);
  });
});

// ── the THREE aggregates move together (operator 2026-07-26: "state/ hides too much") ──
// activate() writes ALL THREE at the PROFILE ROOT, and reload() — driven by refreshConfig on
// message arrival, not a tick or a file-presence probe — brings all three back together too.
describe('createHeartbeatLoader — the three profile-root aggregates', () => {
  const build = () => {
    const writes = [];
    const registry = makeRegistry();
    const io = { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} };
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat', egptHome: '/home',
      listEntityDirs: async () => [{ dir: '/home/rooms/lab', ns: 'room/lab' }],
      readEntityConfig: async () => ({ warm: { idle_ttl: '5m' } }),
      io, resolverIo: io, now: () => 0,
    });
    return { loader, registry, writes };
  };

  it('activate writes all three, at the profile root, none under state/', async () => {
    const { loader, registry, writes } = build();
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });
    const paths = writes.map((w) => w.p).sort();
    expect(paths).toEqual([
      join('/home', 'config.readonly.yaml'),
      join('/home', 'conversations.readonly.yaml'),
      join('/home', 'heartbeats.readonly.yaml'),
    ]);
    expect(paths.some((p) => p.includes(join('state', '')))).toBe(false);
  });

  it('reload() re-scans every rung and rewrites all three together', async () => {
    const { loader, registry, writes } = build();
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });
    writes.length = 0;

    await loader.reload();
    const paths = writes.map((w) => w.p).sort();
    expect(paths).toEqual([
      join('/home', 'config.readonly.yaml'),
      join('/home', 'conversations.readonly.yaml'),
      join('/home', 'heartbeats.readonly.yaml'),
    ]);
  });
});

// ── run observability (operator 2026-08-23: "when a heartbeat runs the agent does whatever.
//    so log errors and triggers? as to know if it ran successfully"). A beat is unattended, so
//    every RUN logs exactly TWO lines: one at FIRE time naming what is about to run, one
//    OUTCOME carrying ok/FAILED, the ELAPSED time, and on failure the real reason. Both action
//    kinds. Nothing logs per tick. All fakes — no process spawns, no session opens. ──
describe('createHeartbeatLoader — run logging (fire + outcome, both action kinds)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // One room beat, a hand-cranked clock (injected `now`) so elapsed is exact, not wall-clock.
  function build(raw) {
    const logs = [];
    const turns = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    let clockMs = 1_000_000;
    let onTurn = async () => ({ text: 'ok' });
    const loader = makeLoader({
      getConfig: () => ({ default_time_zone: 'UTC', agents: { pi: {} } }),
      aliveMs: 0, egptHome: '/home', procCwd: '/checkout', spawn,
      listEntityDirs: async () => [{ dir: '/home/rooms/dj', ns: 'room/dj' }],
      readEntityConfig: async () => ({ heartbeats: { dj: raw } }),
      dispatchTurn: async (t) => { turns.push(t); return onTurn(t); },
      io: { writeFile: async () => {}, mkdir: async () => {}, readFile: async () => 'script body\n' },
      onLog: (m) => logs.push(m), now: () => clockMs,
    });
    return {
      logs, turns, calls,
      advance: (ms) => { clockMs += ms; },
      setTurn: (f) => { onTurn = f; },
      async start() {
        loader.wrapRegistry(registry);
        await loader.collect();
        await loader.activate({ stats: () => ({}) });
        logs.length = 0;   // load-time lines are not RUN lines
        return beatsOf(registry).find((r) => r.name === 'room/dj:dj').fn;
      },
    };
  }

  it('a command beat logs ONE fire line naming the command, then ONE ok outcome with elapsed', async () => {
    const h = build({ frequency: '5s', command: 'node job.js' });
    const beat = await h.start();

    beat();
    expect(h.logs).toEqual(['room/dj:dj: fire command — node job.js']);   // fired, before the work

    h.advance(2500);
    h.calls[0].child.emit('exit', 0);
    expect(h.logs).toEqual([
      'room/dj:dj: fire command — node job.js',
      'room/dj:dj: ok in 2.5s',
    ]);
  });

  it('a command beat that exits NON-ZERO logs FAILED with the exit code + elapsed — and still releases the guard', async () => {
    const h = build({ frequency: '5s', command: 'node job.js' });
    const beat = await h.start();

    beat();
    h.advance(900);
    h.calls[0].child.emit('exit', 3);
    expect(h.logs).toEqual([
      'room/dj:dj: fire command — node job.js',
      'room/dj:dj: FAILED in 900ms — exited 3',   // the REASON, not a bare error line
    ]);

    beat();   // non-fatal, exactly as before: the cadence keeps going
    expect(h.calls).toHaveLength(2);
    expect(h.logs.filter((l) => l.includes('fire command'))).toHaveLength(2);
  });

  it('a child that emits BOTH error and exit still logs ONE outcome (a run is one pair, never two)', async () => {
    const h = build({ frequency: '5s', command: 'node job.js' });
    const beat = await h.start();

    beat();
    h.advance(120);
    h.calls[0].child.emit('error', new Error('ENOENT node'));
    h.calls[0].child.emit('exit', null, 'SIGTERM');
    expect(h.logs).toEqual([
      'room/dj:dj: fire command — node job.js',
      'room/dj:dj: FAILED in 120ms — ENOENT node',
    ]);
  });

  it('a turn beat logs fire (being + script) and an ok outcome with elapsed + a one-line prefix of the reply', async () => {
    const h = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' });
    h.setTurn(async () => { h.advance(12_400); return { text: '  Queued three tracks\nand posted the set list.  ' }; });
    const beat = await h.start();

    beat();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.logs).toEqual([
      'room/dj:dj: fire turn — pi dj.x.md',
      'room/dj:dj: ok in 12.4s — Queued three tracks and posted the set list.',   // one line, always
    ]);
  });

  it('a long turn reply is truncated in the outcome line (one greppable line, not a transcript)', async () => {
    const h = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' });
    h.setTurn(async () => ({ text: 'x'.repeat(500) }));
    const beat = await h.start();

    beat();
    await flush();
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toBe(`room/dj:dj: ok in 0ms — ${'x'.repeat(200)}…`);
  });

  it('a turn beat whose dispatcher THROWS logs fire + FAILED with the thrown message and elapsed', async () => {
    const h = build({ frequency: '30m', agent: 'pi', script_path: 'dj.x.md' });
    h.setTurn(async () => { h.advance(1500); throw new Error('no conversation for room/dj'); });
    const beat = await h.start();

    beat();
    await flush();
    expect(h.logs).toEqual([
      'room/dj:dj: fire turn — pi dj.x.md',
      'room/dj:dj: FAILED in 1.5s — no conversation for room/dj',
    ]);
  });

  it('a tick that fires NOTHING logs NOTHING — no per-tick spam (regression lock, on the REAL registry)', async () => {
    const logs = [];
    const { spawn, calls } = makeSpawn();
    const registry = createHeartbeats({ onLog: (m) => logs.push(m) });
    let clockMs = Date.UTC(2026, 6, 2, 8, 0);
    const loader = makeLoader({
      getConfig: () => ({
        default_time_zone: 'UTC',
        heartbeats: {
          slow: { frequency: '5m', command: 'node slow.js' },
          later: { when: '7/2/2026 09:00', command: 'node later.js' },
        },
      }),
      aliveMs: 0, spawn, procCwd: '/checkout', io: noopIo(),
      onLog: (m) => logs.push(m), now: () => clockMs,
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    logs.length = 0;

    registry.runDue(clockMs);            // first tick: the recurring beat is due (lastRun 0)
    expect(calls).toHaveLength(1);
    calls[0].child.emit('exit', 0);
    expect(logs).toEqual(['slow: fire command — node slow.js', 'slow: ok in 0ms']);

    logs.length = 0;
    for (let i = 0; i < 100; i++) { clockMs += 2000; registry.runDue(clockMs); }   // ~3min of ticks, nothing due
    expect(calls).toHaveLength(1);       // the one-shot is not due, the cadence has not elapsed
    expect(logs).toEqual([]);            // not one line per tick, not one line at all

    clockMs = Date.UTC(2026, 6, 2, 9, 1);   // past the cadence AND the one-shot
    registry.runDue(clockMs);
    expect(calls).toHaveLength(3);
    expect(logs.filter((l) => l.includes('fire command'))).toHaveLength(2);
  });
});
