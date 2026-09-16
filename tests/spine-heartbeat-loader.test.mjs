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
import { GIT_BASH_CANDIDATES } from '../src/sandbox-cli-session.mjs';

// ── fakes ───────────────────────────────────────────────────────────────────
function makeFakeChild() {
  const handlers = {};
  const outHandlers = {};
  return {
    stdout: { setEncoding() {}, on(ev, cb) { outHandlers[ev] = cb; return this; }, emit(ev, ...a) { outHandlers[ev]?.(...a); } },
    on(ev, cb) { handlers[ev] = cb; return this; }, emit(ev, ...a) { handlers[ev]?.(...a); },
  };
}
// Both spawn shapes: (command, opts) for `shell: true`, (file, args, opts) for win32's POSIX bash.
function makeSpawn() {
  const calls = [];
  const spawn = (cmd, a, b) => { const child = makeFakeChild(); const [args, opts] = Array.isArray(a) ? [a, b] : [undefined, a]; calls.push({ cmd, args, opts, child }); return child; };
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
// `platform` defaults to linux so every spawn assertion below reads the `shell: true` runner on
// ANY host — the win32 POSIX-bash runner has its own describe block, with the resolver faked.
function makeLoader({ getConfig = () => ({}), listEntityDirs, readEntityConfig, egptHome = '/home', resolverIo, platform = 'linux', ...rest } = {}) {
  const resolver = createConfigResolver({
    getConfig, listEntityDirs, readEntityConfig, egptHome,
    io: resolverIo ?? noopIo(),
  });
  return createHeartbeatLoader({ resolver, egptHome, platform, ...rest });
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

// ── daily: a wall-clock time EVERY day, in a named zone (operator 2026-09-16: "being E runs a
//    script and tells us the prime of the day … post it at 11:00 Tenerife time") ─────────────
// frequency: has no wall-clock anchor (it fires at registration — every boot, every reload) and
// when: is one-shot, so neither can say "11:00 Atlantic/Canary, every day". daily: is the third
// trigger. It mirrors when: on purpose — same grace window, same "stale is skipped" — and keeps a
// durable per-beat ledger (state/heartbeats-daily.json) so a restart or a reload inside the window
// never fires twice. All fakes: the ledger lives on an in-memory disk behind the io seam.
describe('createHeartbeatLoader — daily: every day at HH:MM in a zone', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const LEDGER = join('/home', 'state', 'heartbeats-daily.json');
  const PRIMES = { dir: '/home/conversations/whatsapp/primes', ns: 'whatsapp/primes' };
  const CANARY = { daily: '11:00', time_zone: 'Atlantic/Canary', command: 'node prime.js' };
  const SEP16_1100_CANARY = Date.UTC(2026, 8, 16, 10, 0);   // WEST (+1) → 10:00Z
  const DAY = 24 * 3_600_000;

  // An in-memory disk: a "restart" is a NEW loader over the SAME files, exactly as state/
  // survives a real one. A *.x.md read returns the script (the turn path reads it fresh).
  function makeDisk(files = {}) {
    const f = new Map(Object.entries(files));
    return {
      files: f,
      ledger: () => JSON.parse(f.get(LEDGER)),
      io: {
        writeFile: async (p, c) => { f.set(p, c); },
        mkdir: async () => {},
        readFile: async (p) => {
          if (String(p).endsWith('.x.md')) return 'Post the prime of the day.\n';
          if (!f.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
          return f.get(p);
        },
      },
    };
  }

  // One WhatsApp entity (or several) declaring `prime-of-the-day`; a hand-set clock.
  function build({ raw = CANARY, entities = [PRIMES], config = {}, disk = makeDisk(), clock = SEP16_1100_CANARY - 3_600_000 } = {}) {
    const logs = [];
    const turns = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    let clockMs = clock;
    const loader = makeLoader({
      getConfig: () => ({ default_time_zone: 'UTC', ...config }),
      aliveMs: 0, egptHome: '/home', spawn,
      listEntityDirs: async () => entities,
      readEntityConfig: async () => ({ heartbeats: { 'prime-of-the-day': raw } }),
      dispatchTurn: async (t) => { turns.push(t); return { text: 'The prime of the day is 1009.' }; },
      io: disk.io, onLog: (m) => logs.push(m), now: () => clockMs,
    });
    const beat = (ns = entities[0].ns) => registry.registered.find((r) => r.name === `${ns}:prime-of-the-day`)?.fn;
    return {
      loader, registry, logs, turns, calls, disk, beat,
      setNow: (ms) => { clockMs = ms; },
      async start() {
        loader.wrapRegistry(registry);
        await loader.collect();
        await loader.activate({ stats: () => ({}) });
        return beat();
      },
    };
  }

  // WHY THIS EXISTS: a 24h cadence is anchored to REGISTRATION, not to the clock. It fires the
  // moment the node boots (15:00 here) and again at every reload — and this node restarts and
  // reloads several times a day. Passes on the current code, and must keep passing.
  it('frequency: 24h fires the moment it is registered — at boot AND again at every reload (why daily: exists)', async () => {
    const { spawn, calls } = makeSpawn();
    const registry = createHeartbeats();
    const t0 = Date.UTC(2026, 8, 16, 14, 0);   // 15:00 in Tenerife — nowhere near the 11:00 anyone meant
    const loader = makeLoader({
      getConfig: () => ({ heartbeats: { prime: { frequency: '24h', command: 'node prime.js' } } }),
      aliveMs: 0, spawn, io: noopIo(), now: () => t0,
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });

    registry.runDue(t0);
    expect(calls).toHaveLength(1);             // fired at registration
    calls[0].child.emit('exit', 0);
    registry.runDue(t0 + 3_600_000);
    expect(calls).toHaveLength(1);             // 1h later: the cadence has not elapsed

    await loader.reload();                     // any inbound message triggers this
    registry.runDue(t0 + 3_600_000);
    expect(calls).toHaveLength(2);             // …and it fires AGAIN: the anchor moved to the reload
  });

  it('daily: "11:00" + time_zone: Atlantic/Canary fires at 11:00 Canary (10:00Z in WEST) and not at 10:59', async () => {
    const h = build();
    const beat = await h.start();
    expect(beat).toBeTypeOf('function');
    expect(h.registry.registered.find((r) => r.name === 'whatsapp/primes:prime-of-the-day').everyMs).toBe(0);   // rides the tick

    beat(SEP16_1100_CANARY - 60_000); await flush();   // 10:59 Canary
    expect(h.calls).toHaveLength(0);
    beat(SEP16_1100_CANARY - 1); await flush();        // 10:59:59.999
    expect(h.calls).toHaveLength(0);
    beat(SEP16_1100_CANARY); await flush();            // 11:00:00 Canary
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe('node prime.js');
    expect(h.calls[0].opts).toMatchObject({ shell: true, cwd: PRIMES.dir });
    expect(h.logs).toContain('whatsapp/primes:prime-of-the-day: fire command — node prime.js');
  });

  it('fires ONCE per local day: later ticks inside the window do nothing, the next day fires again', async () => {
    const h = build();
    const beat = await h.start();

    beat(SEP16_1100_CANARY); await flush();
    beat(SEP16_1100_CANARY + 30_000); await flush();
    beat(SEP16_1100_CANARY + 90_000); await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.disk.ledger()).toEqual({ 'whatsapp/primes:prime-of-the-day': '2026-09-16' });

    beat(SEP16_1100_CANARY + DAY); await flush();      // 2026-09-17 11:00 Canary
    expect(h.calls).toHaveLength(2);
    expect(h.disk.ledger()).toEqual({ 'whatsapp/primes:prime-of-the-day': '2026-09-17' });
  });

  it('does NOT re-fire after a RELOAD or a RESTART inside the grace window — the ledger is durable', async () => {
    const disk = makeDisk();
    const first = build({ disk });
    const beat = await first.start();
    beat(SEP16_1100_CANARY + 10_000); await flush();
    expect(first.calls).toHaveLength(1);

    // a config reload re-registers every beat with fresh closures
    first.setNow(SEP16_1100_CANARY + 40_000);
    await first.loader.reload();
    first.beat()(SEP16_1100_CANARY + 40_000); await flush();
    expect(first.calls).toHaveLength(1);

    // a restart: a brand-new loader over the same state/ files, booting inside the window
    const second = build({ disk, clock: SEP16_1100_CANARY + 60_000 });
    const beat2 = await second.start();
    beat2(SEP16_1100_CANARY + 60_000); await flush();
    beat2(SEP16_1100_CANARY + 90_000); await flush();
    expect(second.calls).toHaveLength(0);
    expect(disk.ledger()).toEqual({ 'whatsapp/primes:prime-of-the-day': '2026-09-16' });
  });

  it('a node down through the whole window SKIPS that day — no 15:00 catch-up — and fires the next day', async () => {
    const late = build({ clock: SEP16_1100_CANARY + 4 * 3_600_000 });   // boots at 15:00 Canary
    const beat = await late.start();
    beat(SEP16_1100_CANARY + 4 * 3_600_000); await flush();
    expect(late.calls).toHaveLength(0);
    beat(SEP16_1100_CANARY + DAY); await flush();
    expect(late.calls).toHaveLength(1);

    // the edge: the same 2-minute grace when: uses — 1:30 late fires, 2:30 late is stale
    const inGrace = build({ clock: SEP16_1100_CANARY + 90_000 });
    (await inGrace.start())(SEP16_1100_CANARY + 90_000); await flush();
    expect(inGrace.calls).toHaveLength(1);
    const stale = build({ clock: SEP16_1100_CANARY + 150_000 });
    (await stale.start())(SEP16_1100_CANARY + 150_000); await flush();
    expect(stale.calls).toHaveLength(0);
  });

  it('a window that crosses local midnight still fires once, recorded against the day it belongs to', async () => {
    const h = build({ raw: { daily: '23:59', time_zone: 'UTC', command: 'node late.js' }, clock: Date.UTC(2026, 8, 16, 23, 0) });
    const beat = await h.start();
    beat(Date.UTC(2026, 8, 17, 0, 0, 30)); await flush();   // 00:00:30 — 90s after 23:59 on the 16th
    beat(Date.UTC(2026, 8, 17, 0, 1, 0)); await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.disk.ledger()).toEqual({ 'whatsapp/primes:prime-of-the-day': '2026-09-16' });
  });

  // Canary (EU rules) leaves summer time on 2026-10-25; New York (US rules) on 2026-11-01; in
  // spring the US moves on 2026-03-08 and the EU on 2026-03-29. Between those dates the two zones
  // are an hour closer than usual — a fixed offset anywhere gets exactly these days wrong.
  it('the UTC instant is right on both sides of the Canary DST change AND on the days between the US and EU changes', async () => {
    async function firesExactlyAt(raw, utcMs) {
      const h = build({ raw, clock: utcMs - 3_600_000 });
      const beat = await h.start();
      beat(utcMs - 1); await flush();
      expect(h.calls, `${JSON.stringify(raw)} fired before ${new Date(utcMs).toISOString()}`).toHaveLength(0);
      beat(utcMs); await flush();
      expect(h.calls, `${JSON.stringify(raw)} did not fire at ${new Date(utcMs).toISOString()}`).toHaveLength(1);
    }
    const canary = { daily: '11:00', time_zone: 'Atlantic/Canary', command: 'x' };
    const ny = { daily: '07:00', time_zone: 'America/New_York', command: 'x' };
    const et = { daily: '07:00', time_zone: 'ET', command: 'x' };   // the alias table resolves it
    await firesExactlyAt(canary, Date.UTC(2026, 9, 24, 10, 0));   // Sat 10-24: WEST +1
    await firesExactlyAt(canary, Date.UTC(2026, 9, 25, 11, 0));   // Sun 10-25: the change day, WET +0
    await firesExactlyAt(canary, Date.UTC(2026, 9, 28, 11, 0));   // EU back, US not yet
    await firesExactlyAt(ny, Date.UTC(2026, 9, 28, 11, 0));       // …NY still EDT −4: same instant as Canary 11:00
    await firesExactlyAt(et, Date.UTC(2026, 10, 2, 12, 0));       // after US change: EST −5
    await firesExactlyAt(canary, Date.UTC(2026, 2, 20, 11, 0));   // US forward (03-08), EU not yet: WET +0
    await firesExactlyAt(ny, Date.UTC(2026, 2, 20, 11, 0));       // …NY already EDT −4
    await firesExactlyAt(canary, Date.UTC(2026, 2, 30, 10, 0));   // EU forward (03-29): WEST +1
  });

  it('with no time_zone: the config default_time_zone applies, exactly as for when:', async () => {
    const h = build({ raw: { daily: '11:00', command: 'x' }, config: { default_time_zone: 'Atlantic/Canary' } });
    const beat = await h.start();
    beat(SEP16_1100_CANARY - 1); await flush();
    expect(h.calls).toHaveLength(0);
    beat(SEP16_1100_CANARY); await flush();
    expect(h.calls).toHaveLength(1);
  });

  it('an invalid daily: value is skipped + logged', async () => {
    for (const bad of ['25:00', '11:60', '11', 'noon', '11:00am', '', 660, true]) {
      const h = build({ raw: { daily: bad, time_zone: 'Atlantic/Canary', command: 'x' } });
      expect((await h.loader.collect()).entries, JSON.stringify(bad)).toEqual([]);
      expect(h.logs.some((l) => l.includes('prime-of-the-day') && l.includes('invalid daily')), JSON.stringify(bad)).toBe(true);
    }
  });

  it('an invalid time_zone makes the entry invalid — skipped + logged, never silently machine-local', async () => {
    for (const bad of ['Nowhere/Bogus', 'Tenerife', '', 42]) {
      const h = build({ raw: { daily: '11:00', time_zone: bad, command: 'x' } });
      expect((await h.loader.collect()).entries, JSON.stringify(bad)).toEqual([]);
      expect(h.logs.some((l) => l.includes('prime-of-the-day') && l.includes('invalid time_zone')), JSON.stringify(bad)).toBe(true);
      expect(h.logs.some((l) => l.includes('machine local')), JSON.stringify(bad)).toBe(false);
    }
  });

  it('daily + frequency, daily + when, and all three are rejected (one trigger), like frequency + when', async () => {
    const cases = [
      [{ daily: '11:00', frequency: '24h', command: 'x' }, 'both frequency and daily set'],
      [{ daily: '11:00', when: '7/2/2026 08:20', command: 'x' }, 'both when and daily set'],
      [{ daily: '11:00', when: '7/2/2026 08:20', frequency: '24h', command: 'x' }, 'all of frequency, when and daily set'],
    ];
    for (const [raw, msg] of cases) {
      const h = build({ raw });
      expect((await h.loader.collect()).entries, msg).toEqual([]);
      expect(h.logs.some((l) => l.includes('prime-of-the-day') && l.includes(msg)), msg).toBe(true);
    }
  });

  it('time_zone: without daily: is rejected — when: has no per-entry zone, so it would be silently ignored', async () => {
    const h = build({ raw: { when: '9/16/2026 11:00', time_zone: 'Atlantic/Canary', command: 'x' } });
    expect((await h.loader.collect()).entries).toEqual([]);
    expect(h.logs.some((l) => l.includes('prime-of-the-day') && l.includes('time_zone without daily'))).toBe(true);
  });

  it('two entities declaring the same beat name keep SEPARATE ledger rows', async () => {
    const A = { dir: '/home/conversations/whatsapp/primes-a', ns: 'whatsapp/primes-a' };
    const B = { dir: '/home/conversations/whatsapp/primes-b', ns: 'whatsapp/primes-b' };
    // A already fired today (before a restart); B did not
    const disk = makeDisk({ [LEDGER]: JSON.stringify({ 'whatsapp/primes-a:prime-of-the-day': '2026-09-16' }) });
    const h = build({ entities: [A, B], disk, clock: SEP16_1100_CANARY - 60_000 });
    await h.start();
    h.beat(A.ns)(SEP16_1100_CANARY); await flush();
    h.beat(B.ns)(SEP16_1100_CANARY); await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].opts.cwd).toBe(B.dir);
    expect(disk.ledger()).toEqual({
      'whatsapp/primes-a:prime-of-the-day': '2026-09-16',
      'whatsapp/primes-b:prime-of-the-day': '2026-09-16',
    });
  });

  it('the operator\'s beat: agent: e + script_path: in a WhatsApp entity dispatches E\'s TURN at 11:00 Canary', async () => {
    const h = build({
      raw: { daily: '11:00', time_zone: 'Atlantic/Canary', agent: 'e', script_path: 'prime.x.md' },
      config: { agents: { egpt: { default: true, handles: ['e'] } } },
    });
    const beat = await h.start();
    beat(SEP16_1100_CANARY - 1); await flush();
    expect(h.turns).toHaveLength(0);
    beat(SEP16_1100_CANARY); await flush();
    expect(h.calls).toHaveLength(0);                     // no textecute spawn
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({ being: 'egpt', ns: 'whatsapp/primes', name: 'whatsapp/primes:prime-of-the-day' });
    expect(h.turns[0].prompt).toBe(framePrompt('prime.x.md', 'Post the prime of the day.\n'));
  });

  it('the readonly view shows daily:, its zone and the next fire instant (across the DST change too)', async () => {
    const before = build({ clock: SEP16_1100_CANARY - 3_600_000 });   // 10:00 Canary
    await before.start();
    const ro = before.disk.files.get(join('/home', 'heartbeats.readonly.yaml'));
    expect(ro).toContain('name: whatsapp/primes:prime-of-the-day');
    expect(ro).toMatch(/daily: "?11:00"?/);
    expect(ro).toContain('time_zone: Atlantic/Canary');
    expect(ro).toContain('next_fire: 2026-09-16T10:00:00.000Z');
    expect(ro).not.toContain('frequency');

    const after = build({ clock: SEP16_1100_CANARY + 4 * 3_600_000 });   // 15:00: today's window is gone
    await after.start();
    expect(after.disk.files.get(join('/home', 'heartbeats.readonly.yaml'))).toContain('next_fire: 2026-09-17T10:00:00.000Z');

    const dst = build({ clock: Date.UTC(2026, 9, 24, 12, 0) });   // Sat 13:00 WEST → next is Sun 11:00 WET
    await dst.start();
    expect(dst.disk.files.get(join('/home', 'heartbeats.readonly.yaml'))).toContain('next_fire: 2026-10-25T11:00:00.000Z');
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

  // prompt: (operator 2026-09-16: "don't use a textecutable for this either. just prompt the model with
  // the one-liner instruction") — the third action, for agent: beats: the line IS the trigger text.
  it('prompt: hands the one-liner over EXACTLY as the trigger text — no textecute frame, no file read, no spawn', async () => {
    const LINE = 'Di en una frase por qué 1637 es primo.';
    const { loader, registry, turns, calls, reads, logs } = build({ frequency: '30m', agent: 'pi', prompt: `  ${LINE}  ` });
    const e = (await loader.collect()).entries.find((x) => x.name === 'room/dj-son:dj');
    expect(e.action).toEqual({ kind: 'turn', being: 'pi', prompt: LINE, cwd: '/home/conversations/room/dj-son', ns: 'room/dj-son' });

    loader.wrapRegistry(registry);
    await loader.activate({ stats: () => ({}) });
    logs.length = 0;
    beatsOf(registry).find((r) => r.name === 'room/dj-son:dj').fn();
    await flush();

    expect(turns).toEqual([{ being: 'pi', ns: 'room/dj-son', name: 'room/dj-son:dj', prompt: LINE }]);
    expect(reads).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(logs[0]).toBe(`room/dj-son:dj: fire turn — pi prompt: ${LINE}`);
  });

  it('prompt: invalid combinations are skipped + logged — with command, with script_path, without agent, empty; and agent: needs one of script_path/prompt', async () => {
    for (const [raw, msg] of [
      [{ frequency: '30m', agent: 'pi', prompt: 'x', command: 'node x.js' }, 'both prompt and command set'],
      [{ frequency: '30m', agent: 'pi', prompt: 'x', script_path: 'dj.x.md' }, 'both prompt and script_path set'],
      [{ frequency: '30m', prompt: 'x' }, 'prompt without agent'],
      [{ frequency: '30m', agent: 'pi', prompt: '   ' }, 'is not an instruction'],
      [{ frequency: '30m', agent: 'pi', prompt: 42 }, 'is not an instruction'],
      [{ frequency: '30m', agent: 'pi' }, 'without script_path or prompt'],
    ]) {
      const { loader, logs, calls, turns } = build(raw);
      expect((await loader.collect()).entries, msg).toEqual([]);
      expect(logs.some((l) => l.includes('room/dj-son:dj') && l.includes(msg)), msg).toBe(true);
      expect(calls).toHaveLength(0);
      expect(turns).toHaveLength(0);
    }
  });

  it('the readonly view shows a prompt: beat as the prompt and who runs it', async () => {
    const writes = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => CONFIG, aliveMs: 0, egptHome: '/home',
      listEntityDirs: async () => [{ dir: '/home/conversations/room/dj-son', ns: 'room/dj-son' }],
      readEntityConfig: async () => ({ heartbeats: { dj: { frequency: '30m', agent: 'pi', prompt: 'Pon tres temas.' } } }),
      dispatchTurn: async () => {},
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    expect(writes.at(-1).c).toContain('action: "prompt: Pon tres temas."');
    expect(writes.at(-1).c).toContain('agent: pi');
  });

  // A beat that SENDS into its chat must not wait for a message to arrive there to learn which
  // connection holds it: the loader asks boot's placeChat once per entity, at registration.
  it('placeChat: asked ONCE per entity that a post:/agent: beat sends into — never for a plain command or a node beat — at activate, and for a new entity on reload', async () => {
    let dirs = [{ dir: '/home/conversations/whatsapp/a', ns: 'whatsapp/a' }, { dir: '/home/conversations/whatsapp/b', ns: 'whatsapp/b' }];
    const blocks = {
      'whatsapp/a': { primo: { frequency: '24h', command: 'x', post: '{stdout}' }, porque: { frequency: '24h', agent: 'pi', prompt: 'y' } },
      'whatsapp/b': { sweep: { frequency: '24h', command: 'x' } },
      'whatsapp/c': { dj: { frequency: '24h', agent: 'pi', script_path: 'dj.x.md' } },
    };
    const placed = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => ({ ...CONFIG, heartbeats: { node: { frequency: '1h', command: 'z' } } }), aliveMs: 0, egptHome: '/home',
      listEntityDirs: async () => dirs,
      readEntityConfig: async (_dir, ns) => ({ heartbeats: blocks[ns] ?? {} }),
      dispatchTurn: async () => {}, dispatchPost: async () => {},
      placeChat: async (p) => { placed.push(p); },
      io: noopIo(),
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    expect(placed).toEqual([{ ns: 'whatsapp/a', name: 'whatsapp/a:primo' }]);

    await loader.reload();                                   // same set: nobody is asked again
    expect(placed).toHaveLength(1);
    dirs = [...dirs, { dir: '/home/conversations/whatsapp/c', ns: 'whatsapp/c' }];
    await loader.reload();                                   // a new entity with a turn beat: asked once
    expect(placed).toEqual([{ ns: 'whatsapp/a', name: 'whatsapp/a:primo' }, { ns: 'whatsapp/c', name: 'whatsapp/c:dj' }]);
  });

  it('placeChat that THROWS is logged and never blocks registration', async () => {
    const logs = [];
    const registry = makeRegistry();
    const loader = makeLoader({
      getConfig: () => CONFIG, aliveMs: 0, egptHome: '/home',
      listEntityDirs: async () => [{ dir: '/home/conversations/whatsapp/a', ns: 'whatsapp/a' }],
      readEntityConfig: async () => ({ heartbeats: { primo: { frequency: '24h', command: 'x', post: '{stdout}' } } }),
      dispatchPost: async () => {},
      placeChat: async () => { throw new Error('Beeper is not up'); },
      io: noopIo(), onLog: (m) => logs.push(m),
    });
    loader.wrapRegistry(registry);
    await loader.collect();
    await loader.activate({ stats: () => ({}) });
    expect(beatsOf(registry).map((r) => r.name)).toEqual(['whatsapp/a:primo']);
    expect(logs.some((l) => l.includes('whatsapp/a:primo: could not place its chat — Beeper is not up'))).toBe(true);
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

// ── command beats on win32 run under POSIX bash (operator 2026-09-16: "mejor usa bash posix. la
//    tienes en KG y en DO"). `shell: true` there is cmd.exe, and `bash` on PATH is System32's WSL
//    launcher. The bash comes from THE resolver (sandbox-cli-session.mjs), resolved once per
//    load/reload; with none installed the beat falls back to `shell: true` LOUDLY, because the
//    alive beat must never depend on msys. Fakes only: the resolver and spawn are both seams. ──
describe('createHeartbeatLoader — the command runner on win32 (POSIX bash)', () => {
  const BASH = 'C:\\msys64\\usr\\bin\\bash.exe';
  const ENT = { dir: '/home/conversations/whatsapp/x', ns: 'whatsapp/x' };

  function build({ bash = BASH, config = {}, block = { job: { frequency: '5s', command: 'node job.js' } }, entities = [ENT], ...rest } = {}) {
    const logs = [];
    const writes = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    let resolves = 0;
    const loader = makeLoader({
      getConfig: () => config, aliveMs: 0, egptHome: '/home', spawn, env: { PATH: '/bin' },
      platform: 'win32', resolvePosixBash: () => { resolves++; return bash; },
      listEntityDirs: async () => entities,
      readEntityConfig: async () => ({ heartbeats: block }),
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
      onLog: (m) => logs.push(m),
      ...rest,
    });
    return {
      loader, registry, logs, writes, calls, resolves: () => resolves,
      async start() { loader.wrapRegistry(registry); await loader.collect(); await loader.activate({ stats: () => ({ queueDepth: 1, oldestMs: 5 }) }); },
      beat: (name) => registry.registered.find((r) => r.name === name).fn,
    };
  }

  it('a resolved bash runs the beat as spawn(bash, [-c, command]) with the entity cwd + env — no cmd.exe', async () => {
    const h = build();
    await h.start();
    h.beat('whatsapp/x:job')();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe(BASH);
    expect(h.calls[0].args).toEqual(['-c', 'node job.js']);
    expect(h.calls[0].opts).toMatchObject({ cwd: ENT.dir });
    expect(h.calls[0].opts.shell).toBeUndefined();
    expect(h.calls[0].opts.env).toMatchObject({ PATH: '/bin', EGPT_HOME: '/home', EGPT_QUEUE_DEPTH: '1' });
    // the operator can see what shell runs the beats
    expect(h.writes.at(-1).c).toContain(`shell: ${BASH} -c`);
    expect(h.logs.some((l) => l.includes('NO POSIX BASH'))).toBe(false);
  });

  it('resolves ONCE per load and once per reload — never per fire', async () => {
    const h = build();
    await h.start();
    expect(h.resolves()).toBe(1);
    for (let i = 0; i < 3; i++) { h.beat('whatsapp/x:job')(); h.calls.at(-1).child.emit('exit', 0); }
    expect(h.resolves()).toBe(1);
    await h.loader.reload();
    expect(h.resolves()).toBe(2);
  });

  it('with NO bash: falls back to shell: true and says so LOUDLY, naming the candidates — once, not on every reload', async () => {
    const h = build({ bash: null });
    await h.start();
    h.beat('whatsapp/x:job')();
    expect(h.calls[0].cmd).toBe('node job.js');
    expect(h.calls[0].opts).toMatchObject({ shell: true, cwd: ENT.dir });
    const loud = h.logs.filter((l) => l.includes('NO POSIX BASH'));
    expect(loud).toHaveLength(1);
    for (const c of GIT_BASH_CANDIDATES) expect(loud[0]).toContain(c);
    expect(h.writes.at(-1).c).toContain('NO POSIX BASH');
    await h.loader.reload();
    await h.loader.reload();
    expect(h.logs.filter((l) => l.includes('NO POSIX BASH'))).toHaveLength(1);
  });

  // LIVENESS IS EXEMPT (operator 2026-09-16). alive.txt is what the watchdog and the stand-down
  // handover read, and msys can fail to start in another account's session — so the beat BOOT
  // INJECTS never runs under the POSIX bash, resolved or not. Keyed on the injection, not the name.
  it('the alive beat BOOT INJECTS stays on the native shell even with a bash resolved — same command, cwd = EGPT_HOME', async () => {
    for (const bash of [BASH, null]) {
      const h = build({ bash, block: {}, entities: [], aliveMs: 60_000, aliveCommand: 'echo beat > state/alive.txt', procCwd: '/checkout' });
      await h.start();
      h.beat('alive')();
      expect(h.calls, String(bash)).toHaveLength(1);
      expect(h.calls[0].cmd).toBe('echo beat > state/alive.txt');
      expect(h.calls[0].args).toBeUndefined();
      expect(h.calls[0].opts).toMatchObject({ shell: true, cwd: '/home' });
    }
    // …and the readonly view says so beside the row, where `shell:` above would otherwise mislead
    const h = build({ block: {}, entities: [], aliveMs: 60_000, aliveCommand: 'echo beat > state/alive.txt' });
    await h.start();
    expect(h.writes.at(-1).c).toMatch(/name: alive[\s\S]*shell: native/);
  });

  it('a declared `alive:` with NO command runs boot\'s liveness command, so it stays native too', async () => {
    const h = build({ bash: BASH, block: {}, entities: [], config: { heartbeats: { alive: { frequency: '1s' } } }, aliveCommand: 'echo beat > state/alive.txt' });
    await h.start();
    h.beat('alive')();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe('echo beat > state/alive.txt');
    expect(h.calls[0].args).toBeUndefined();
    expect(h.calls[0].opts).toMatchObject({ shell: true, cwd: '/home' });
  });

  it('not special by NAME: a command the operator WRITES runs under the bash — under `alive`, or the same line under another name', async () => {
    for (const block of [
      { alive: { frequency: '1s', command: 'echo beat > state/alive.txt' } },
      { pulse: { frequency: '1s', command: 'echo beat > state/alive.txt' } },
    ]) {
      const h = build({ block: {}, entities: [], config: { heartbeats: block }, aliveMs: 60_000, aliveCommand: 'echo beat > state/alive.txt' });
      await h.start();
      const name = Object.keys(block)[0];
      h.beat(name)();
      expect(h.calls, JSON.stringify(block)).toHaveLength(1);
      expect(h.calls[0].cmd).toBe(BASH);
      expect(h.calls[0].args).toEqual(['-c', 'echo beat > state/alive.txt']);
    }
  });

  it('off win32 nothing changes: shell: true (/bin/sh), and the resolver is never asked', async () => {
    const h = build({ platform: 'linux' });
    await h.start();
    h.beat('whatsapp/x:job')();
    expect(h.calls[0]).toMatchObject({ cmd: 'node job.js', args: undefined });
    expect(h.calls[0].opts).toMatchObject({ shell: true, cwd: ENT.dir });
    expect(h.resolves()).toBe(0);
    expect(h.writes.at(-1).c).toContain('shell: /bin/sh\n');
  });

  it('the operator\'s primo-del-dia line reaches bash byte for byte, from the group\'s own folder', async () => {
    const yaml = [
      'heartbeats:',
      '  primo-del-dia:',
      '    daily: "14:00"',
      '    time_zone: Atlantic/Canary',
      '    command: bash scripts/nth_prime.sh "$(TZ=Atlantic/Canary date +%-j)"',
      '    post: "Hola muchachas y muchachos, el primo del día es {stdout}"',
      '',
    ].join('\n');
    const GROUP = { dir: 'C:\\Users\\an\\.egpt\\conversations\\whatsapp\\Reencuentro CRC 1991-2026-2607161314', ns: 'whatsapp/Reencuentro CRC 1991-2026-2607161314' };
    const h = build({
      block: parseEntityConfig(yaml).heartbeats, entities: [GROUP],
      now: () => Date.UTC(2026, 8, 16, 12, 0),   // 13:00 in Tenerife (WEST), an hour before
      io: { writeFile: async () => {}, mkdir: async () => {}, readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
    });
    await h.start();
    h.beat(`${GROUP.ns}:primo-del-dia`)(Date.UTC(2026, 8, 16, 13, 0));   // 14:00 WEST
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe(BASH);
    expect(h.calls[0].args).toEqual(['-c', 'bash scripts/nth_prime.sh "$(TZ=Atlantic/Canary date +%-j)"']);
    expect(h.calls[0].opts.cwd).toBe(GROUP.dir);
  });
});

// ── post: a command beat's stdout, posted into the entity's chat (operator 2026-09-16: "a minimal
//    .yaml with the specification, structural, not dependent on the robot"). The loader renders
//    the template and hands it to boot's injected dispatchPost; it never touches a bridge. ──
describe('createHeartbeatLoader — post: (a command beat that posts its stdout)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const ENT = { dir: '/home/conversations/whatsapp/primes', ns: 'whatsapp/primes' };
  const TEMPLATE = 'Hola muchachas y muchachos, el primo del día es {stdout}';

  function build(raw, { dispatchPost, entities = [ENT], config = { agents: { egpt: { handles: ['e'] } } }, node, clock = 1_000_000, ledger = {} } = {}) {
    const logs = [];
    const posts = [];
    const writes = [];
    const { spawn, calls } = makeSpawn();
    const registry = makeRegistry();
    let clockMs = clock;
    const files = new Map([[join('/home', 'state', 'heartbeats-daily.json'), JSON.stringify(ledger)]]);
    const loader = makeLoader({
      getConfig: () => ({ default_time_zone: 'UTC', ...config, ...(node ? { heartbeats: node } : {}) }),
      aliveMs: 0, egptHome: '/home', spawn,
      listEntityDirs: async () => entities,
      readEntityConfig: async () => ({ heartbeats: raw ? { prime: raw } : {} }),
      dispatchPost: dispatchPost ?? (async (p) => { posts.push(p); }),
      io: { writeFile: async (p, c) => { files.set(p, c); writes.push({ p, c }); }, mkdir: async () => {}, readFile: async (p) => files.get(p) },
      onLog: (m) => logs.push(m), now: () => clockMs,
    });
    return {
      loader, registry, logs, posts, writes, calls, files,
      advance: (ms) => { clockMs += ms; },
      async start() { loader.wrapRegistry(registry); await loader.collect(); await loader.activate({ stats: () => ({}) }); logs.length = 0; },
      beat: () => registry.registered.find((r) => r.name === `${ENT.ns}:prime`)?.fn,
    };
  }

  it('exit 0 → posts the template with {stdout} = the TRIMMED stdout, once, into the entity it was declared in', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: TEMPLATE });
    await h.start();
    h.beat()();
    const child = h.calls[0].child;
    child.stdout.emit('data', '  1637');
    child.stdout.emit('data', '\n\n');
    child.emit('close', 0);
    await flush();
    expect(h.posts).toEqual([{ ns: 'whatsapp/primes', name: 'whatsapp/primes:prime', text: 'Hola muchachas y muchachos, el primo del día es 1637' }]);
    expect(h.logs).toEqual([
      'whatsapp/primes:prime: fire command — node prime.js',
      'whatsapp/primes:prime: ok in 0ms — posted: Hola muchachas y muchachos, el primo del día es 1637',
    ]);
  });

  it('waits for close, not exit: stdout that lands after exit is still in the post', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: '{stdout}' });
    await h.start();
    h.beat()();
    const child = h.calls[0].child;
    child.emit('exit', 0);                  // exit fires while stdout is still draining
    child.stdout.emit('data', '1637\n');
    await flush();
    expect(h.posts).toHaveLength(0);
    child.emit('close', 0);
    await flush();
    expect(h.posts.map((p) => p.text)).toEqual(['1637']);
  });

  it('a NONZERO exit posts nothing and logs FAILED with the exit code', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: TEMPLATE });
    await h.start();
    h.beat()();
    h.calls[0].child.stdout.emit('data', '1637\n');
    h.calls[0].child.emit('close', 1);
    await flush();
    expect(h.posts).toHaveLength(0);
    expect(h.logs.at(-1)).toBe('whatsapp/primes:prime: FAILED in 0ms — exited 1');
  });

  it('EMPTY (or whitespace-only) stdout posts nothing and logs why', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: TEMPLATE });
    await h.start();
    h.beat()();
    h.calls[0].child.stdout.emit('data', ' \n\t\n');
    h.calls[0].child.emit('close', 0);
    await flush();
    expect(h.posts).toHaveLength(0);
    expect(h.logs.at(-1)).toBe('whatsapp/primes:prime: FAILED in 0ms — empty stdout — nothing posted');
  });

  it('a spawn ERROR posts nothing (one outcome, even when close follows)', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: TEMPLATE });
    await h.start();
    h.beat()();
    h.calls[0].child.emit('error', new Error('ENOENT bash'));
    h.calls[0].child.emit('close', null, 'SIGTERM');
    await flush();
    expect(h.posts).toHaveLength(0);
    expect(h.logs.filter((l) => l.includes('FAILED'))).toEqual(['whatsapp/primes:prime: FAILED in 0ms — ENOENT bash']);
  });

  it('a post that THROWS logs FAILED with the reason and releases the overlap guard', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: TEMPLATE }, { dispatchPost: async () => { throw new Error('no conversation for whatsapp/primes'); } });
    await h.start();
    h.beat()();
    h.calls[0].child.stdout.emit('data', '1637');
    h.calls[0].child.emit('close', 0);
    await flush();
    expect(h.logs.at(-1)).toBe('whatsapp/primes:prime: FAILED in 0ms — post failed: no conversation for whatsapp/primes');
    h.beat()();
    expect(h.calls).toHaveLength(2);
  });

  it('invalid combinations are skipped + logged: no command, with agent:, with script_path:, on a node-level beat, a non-template', async () => {
    const cases = [
      [{ frequency: '24h', post: TEMPLATE }, 'post without command'],
      [{ frequency: '24h', agent: 'e', script_path: 'prime.x.md', post: TEMPLATE }, 'both post and agent set'],
      [{ frequency: '24h', script_path: 'prime.x.md', post: TEMPLATE }, 'both post and script_path set'],
      [{ frequency: '24h', command: 'node prime.js', post: '' }, 'is not a message template'],
      [{ frequency: '24h', command: 'node prime.js', post: 42 }, 'is not a message template'],
    ];
    for (const [raw, msg] of cases) {
      const h = build(raw);
      expect((await h.loader.collect()).entries, msg).toEqual([]);
      expect(h.logs.some((l) => l.includes('whatsapp/primes:prime') && l.includes(msg)), msg).toBe(true);
    }
    const nodeLevel = build(null, { node: { prime: { frequency: '24h', command: 'node prime.js', post: TEMPLATE } } });
    expect((await nodeLevel.loader.collect()).entries).toEqual([]);
    expect(nodeLevel.logs.some((l) => l.includes('prime: post on a node-level beat'))).toBe(true);
  });

  it('daily: + command: + post: fires ONCE and posts ONCE across a reload inside the grace window', async () => {
    const at = Date.UTC(2026, 8, 16, 13, 0);   // 14:00 Atlantic/Canary (WEST)
    const h = build({ daily: '14:00', time_zone: 'Atlantic/Canary', command: 'bash scripts/nth_prime.sh 259', post: TEMPLATE }, { clock: at - 60_000 });
    await h.start();
    h.beat()(at);
    await flush();
    expect(h.calls).toHaveLength(1);
    h.calls[0].child.stdout.emit('data', '1637\n');
    h.calls[0].child.emit('close', 0);
    await flush();

    h.advance(90_000);
    await h.loader.reload();                  // an inbound message, 30s after the fire
    h.beat()(at + 30_000);
    h.beat()(at + 90_000);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.posts.map((p) => p.text)).toEqual(['Hola muchachas y muchachos, el primo del día es 1637']);
  });

  it('the readonly view shows the post: template beside the command', async () => {
    const h = build({ frequency: '24h', command: 'node prime.js', post: TEMPLATE });
    await h.start();
    const ro = h.writes.filter((w) => w.p.endsWith('heartbeats.readonly.yaml')).at(-1).c;
    expect(ro).toContain('command: node prime.js');
    expect(ro).toContain(`post: ${TEMPLATE}`);
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
