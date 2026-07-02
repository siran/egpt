// The declarative heartbeat loader (src/spine/heartbeat-loader.mjs): the pure
// frequency parser + entity-block parser, the two-phase collect()/activate() API
// (default-alive injection / override / disable, namespacing, finestMs math), the
// readonly.yaml materialization, and the command action (shell spawn with entity
// cwd + pump-stats env, overlap guard, non-zero exit only logs). All fakes — the
// loader never touches the real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHeartbeatLoader, parseFrequency, parseHeartbeatsBlock, parseWhen, resolveTimeZone, zonedWallClockToEpoch } from '../src/spine/heartbeat-loader.mjs';

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
    runDue: () => {},   // the decorated wrapper delegates here; firing beats isn't what the reload tests assert
    registered,
  };
}
// every beat the loader registered (there is no internal reload row anymore)
const beatsOf = (registry) => registry.registered;
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

  it('injects the default alive command (echo one-liner, cwd = EGPT_HOME) when the node config declares none (aliveMs>0)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({}), aliveMs: 60_000, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home', procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries).toHaveLength(1);
    // cwd is the PROFILE, not the checkout — the relative state/ must resolve into ~/.egpt
    expect(entries[0]).toMatchObject({ name: 'alive', source: 'config', everyMs: 60_000, action: { kind: 'command', command: 'echo beat > state/alive.txt', cwd: '/home' } });
  });

  it('does NOT inject the default alive when aliveMs=0 (test contract)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({}), aliveMs: 0 });
    expect((await loader.collect()).entries).toEqual([]);
  });

  it('an explicit config alive with no command falls back to the default alive command + EGPT_HOME cwd (even at aliveMs=0)', async () => {
    const loader = createHeartbeatLoader({ getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }), aliveMs: 0, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home', procCwd: '/co' });
    const { entries } = await loader.collect();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'alive', everyMs: 1000, action: { kind: 'command', command: 'echo beat > state/alive.txt', cwd: '/home' } });
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
    expect(writes[0].p).toContain(join('state', 'heartbeats.readonly.yaml'));
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
    const loader = createHeartbeatLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [{ dir: '/ent', ns: 'whatsapp/x' }],
      readEntityConfig: async () => ({ job: { frequency: '5s', command: 'node job.js' } }),
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
    const loader = createHeartbeatLoader({
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
    const stale = createHeartbeatLoader({
      getConfig: () => ({ default_time_zone: 'UTC', heartbeats: { old: { when: '7/2/2026 08:20', command: 'x' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m),
      now: () => Date.UTC(2026, 6, 2, 8, 23),   // 3 min after → stale
    });
    expect((await stale.collect()).entries.find((e) => e.name === 'old')).toBeUndefined();
    expect(logs.some((l) => l.includes('stale when'))).toBe(true);

    const grace = createHeartbeatLoader({
      getConfig: () => ({ default_time_zone: 'UTC', heartbeats: { recent: { when: '7/2/2026 08:20', command: 'x' } } }),
      aliveMs: 0, io: noopIo(),
      now: () => Date.UTC(2026, 6, 2, 8, 21),   // 1 min after → within grace
    });
    expect((await grace.collect()).entries.find((e) => e.name === 'recent'))
      .toMatchObject({ whenMs: Date.UTC(2026, 6, 2, 8, 20), fired: false });
  });

  it('an entry with BOTH when and frequency is invalid — skipped + logged', async () => {
    const logs = [];
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { bad: { when: '7/2/2026 08:20', frequency: '5m', command: 'x' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m), now: () => 0,
    });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('both frequency and when'))).toBe(true);
  });

  it('when entries do NOT influence finestMs (only recurring cadences do)', async () => {
    const loader = createHeartbeatLoader({
      getConfig: () => ({ default_time_zone: 'UTC', heartbeats: {
        soon: { when: '7/2/2026 08:20', command: 'x' },
        sweep: { frequency: '30s', command: 'y' },
      } }),
      aliveMs: 0, io: noopIo(), now: () => Date.UTC(2026, 6, 2, 8, 19),
    });
    expect((await loader.collect()).finestMs).toBe(30_000);   // the frequency entry, not the when one
  });
});

// ── ai_run: textecutable sugar ──────────────────────────────────────────────
describe('createHeartbeatLoader — ai_run:', () => {
  it('expands ai_run to a node textecute.mjs command (script relative → entry cwd); readonly shows BOTH forms', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { daily: { frequency: '24h', ai_run: 'reports/daily.x.md' } } }),
      aliveMs: 0, procCwd: '/checkout', egptHome: '/home',
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    const { entries } = await loader.collect();
    const e = entries.find((x) => x.name === 'daily');
    expect(e.action.aiRun).toBe('reports/daily.x.md');
    expect(e.action.command).toContain('textecute.mjs');
    expect(e.action.command).toContain('reports/daily.x.md');
    expect(e.action.cwd).toBe('/checkout');            // relative script resolves against this cwd

    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    const readonly = writes.at(-1).c;
    expect(readonly).toContain('ai_run: reports/daily.x.md');   // the sugar
    expect(readonly).toContain('textecute.mjs');                // AND the resolved command
    expect(readonly).toContain('command:');
  });

  it('an entry with BOTH command and ai_run is invalid — skipped + logged', async () => {
    const logs = [];
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { dbl: { frequency: '5m', command: 'x', ai_run: 'y.x.md' } } }),
      aliveMs: 0, io: noopIo(), onLog: (m) => logs.push(m),
    });
    expect((await loader.collect()).entries).toEqual([]);
    expect(logs.some((l) => l.includes('both command and ai_run'))).toBe(true);
  });
});

// ── hot reload (readonly file gone → the NEXT runDue reloads) ───────────────
// The trigger rides the decorated runDue now (wrapRegistry), not an internal beat:
// consulting the in-memory set is where the "is the file still there?" check lives.
describe('createHeartbeatLoader — hot reload', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));   // drain a fire-and-forget reload

  it('a runDue with the readonly file MISSING re-collects, replaces beats, picks up new entities, rewrites the file — and NO internal row anywhere', async () => {
    let present = true;
    let dirs = [];
    const writes = [];
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat > state/alive.txt', egptHome: '/home',
      listEntityDirs: async () => dirs,
      readEntityConfig: async () => ({ ping: { frequency: '30s', command: 'node ping.js' } }),
      existsSync: () => present,
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
      now: () => 0,
    });
    const wrapped = loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });

    // no internal beat is registered, and no internal row is in the readonly view
    expect(registry.registered.some((r) => r.name === 'heartbeats-reload')).toBe(false);
    expect(writes.at(-1).c).not.toContain('heartbeats-reload');
    expect(writes.at(-1).c).not.toContain('spine (internal)');
    const writesAfterActivate = writes.length;

    // file still present → runDue is a pure pass-through (no reload, no rewrite)
    wrapped.runDue(0);
    await settle();
    expect(writes.length).toBe(writesAfterActivate);

    // delete the file + a NEW conversation appears → the next runDue triggers reload
    present = false;
    dirs = [{ dir: '/home/conversations/whatsapp/new-chat', ns: 'whatsapp/new-chat' }];
    wrapped.runDue(0);   // THIS tick still ran the old set; the fire-and-forget reload swaps it
    await settle();

    const names = registry.registered.map((r) => r.name);
    expect(names).toContain('alive');                              // re-registered
    expect(names).toContain('whatsapp/new-chat:ping');             // new entity picked up
    expect(names).not.toContain('heartbeats-reload');              // still no internal row
    expect(writes.at(-1).c).toContain('whatsapp/new-chat:ping');   // readonly rewritten
  });

  it('a runDue BEFORE activate is a pure pass-through — it never probes the file', async () => {
    let existsChecks = 0;
    const writes = [];
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat', egptHome: '/home',
      existsSync: () => { existsChecks++; return false; },   // would trigger a reload IF the check were armed
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
      now: () => 0,
    });
    const wrapped = loader.wrapRegistry(registry);
    await loader.collect();   // NOT activated

    wrapped.runDue(0);
    await settle();
    expect(existsChecks).toBe(0);       // the staleness check is inert pre-activate
    expect(writes).toHaveLength(0);     // no reload wrote a readonly
  });

  it('guards reentrancy: a reload in flight blocks a concurrent runDue', async () => {
    let present = false;
    const writes = [];
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({ heartbeats: { alive: { frequency: '1s' } } }),
      aliveMs: 0, aliveCommand: 'echo beat', egptHome: '/home',
      existsSync: () => present,
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
      now: () => 0,
    });
    const wrapped = loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });
    writes.length = 0;

    wrapped.runDue(0);   // file missing → kicks the reload (sets the guard synchronously)
    wrapped.runDue(0);   // guard is set → short-circuits, no second reload
    await settle();
    expect(writes).toHaveLength(1);   // exactly one reload wrote the readonly
  });

  it('warns when a reloaded finest cadence is finer than the fixed boot tick', async () => {
    let present = true;
    let entBlock = { slow: { frequency: '30s', command: 'x' } };
    const logs = [];
    const registry = makeRegistry();
    const loader = createHeartbeatLoader({
      getConfig: () => ({}), aliveMs: 0,
      listEntityDirs: async () => [{ dir: '/ent', ns: 'whatsapp/x' }],
      readEntityConfig: async () => entBlock,
      existsSync: () => present,
      io: noopIo(), onLog: (m) => logs.push(m), now: () => 0,
    });
    const wrapped = loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}), tickMs: 30_000 });   // boot tick 30s; 30s cadence is NOT finer
    expect(logs.some((l) => l.includes('finer than the boot tick'))).toBe(false);

    entBlock = { fast: { frequency: '1s', command: 'y' } };   // a finer cadence appears
    present = false;
    wrapped.runDue(0);
    await settle();
    expect(logs.some((l) => l.includes('finer than the boot tick'))).toBe(true);
  });
});
