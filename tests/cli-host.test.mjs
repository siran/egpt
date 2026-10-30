// tests/cli-host.test.mjs — the daemon HOLDS every claude session (src/cli-host.mjs), so a spine restart
// adopts them instead of ending them (operator 2026-10-16: "sessions shouldn't be closed"). The REAL
// host, the REAL spine end, the REAL warm pool and session over an in-memory IPC pair; only `claude`
// is fake. A spine restart = the pair drops, a new pair + a new pool against the same host.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliHost, connectCliHost, CLI_HOST_ENV } from '../src/cli-host.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { createSandboxCliSession } from '../src/sandbox-cli-session.mjs';
import { createBeingLink } from '../src/spine/being-link.mjs';
import { authMac } from '../src/shell/auth.mjs';
import { ipcPair, fakeClaude } from './fake-claude-cli.mjs';

const KEY = 'egpt:ccode:whatsapp:fam';
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// `mute(i)`: spawn #i takes stdin and never answers (nothing reads the pipe).
function world({ mute = () => false } = {}) {
  const spawns = [];
  const logs = [];
  const host = createCliHost({
    log: (m) => logs.push(m),
    setPriority: () => {},
    spawn: (bin, args, opts) => {
      const child = fakeClaude(7000 + spawns.length);
      if (mute(spawns.length)) child.stdin.write = () => true;
      spawns.push({ bin, args, opts, child }); setImmediate(() => child.emit('spawn')); return child;
    },
  });
  // One spine: a fresh IPC pair to the SAME host, its end of it, and its warm pool — wired as boot wires them.
  const spine = ({ factory = (o) => createWarmCliSession(o), poolLogs = [], max } = {}) => {
    const pair = ipcPair();
    host.attach(pair.daemonSide);
    const cli = connectCliHost(pair.spineSide, { [CLI_HOST_ENV]: '1' }, { uuid: (() => { let n = 0; return () => `h${spawns.length}-${++n}-${Math.random()}`; })() });
    const woken = [];
    const pool = createWarmPool({
      max,
      makeSession: (opts) => factory({ ...opts, spawn: cli.spawner(opts.pool.key, { ...opts.pool, sessionId: opts.sessionId ?? null }) }),
      onBackgroundDone: (key, info) => { woken.push({ key, ...info }); },
      onLog: (m) => poolLogs.push(m),
    });
    // boot's adoption loop, in small.
    const adoptAll = async (extra = () => ({})) => {
      for (const h of await cli.list()) {
        const a = await cli.adopt(h.hid);
        pool.adopt(h.key, { brainOptions: { ...h.meta.opened, sessionId: a.sessionId, adopt: a, ...extra(h) }, klass: h.meta.klass, idleTtlMs: h.meta.idleTtlMs, opened: h.meta.opened });
      }
    };
    return { pair, cli, pool, woken, adoptAll, poolLogs };
  };
  return { host, spawns, logs, spine };
}
const run = (s, text, brainOptions = { model: 'sonnet' }, onUpdate = () => {}) => s.pool.run(KEY, text, onUpdate, { brainOptions, klass: 'conversation' });

describe('a spine restart never ends a claude session', () => {
  it('(a) the new spine adopts the live process: same pid, the next turn answered by it, no respawn, no --resume', async () => {
    const w = world();
    const one = w.spine();
    expect((await run(one, 'hola')).text).toBe('echo:hola');
    expect(w.spawns).toHaveLength(1);
    const claude = w.spawns[0].child;

    one.pair.drop();                                   // /upgrade, /restart, a crash: the spine goes, the daemon stays
    const two = w.spine();
    await two.adoptAll();
    expect(two.pool.has(KEY)).toBe(true);

    const r = await run(two, 'sigues ahí?', { model: 'sonnet', sessionId: 'sess-1' });
    expect(r.text).toBe('echo:sigues ahí?');
    expect(r.sessionId).toBe('sess-1');
    expect(w.spawns).toHaveLength(1);                  // ← before: the old spine took its claude down; this spawned again with --resume
    expect(claude.killed).toBe(false);
    expect(claude.ended).toBe(false);
    expect(claude.lines).toEqual(['hola', 'sigues ahí?']);
  });

  it('(b) a background task that finishes while no spine is connected is buffered, then wakes the being after the reconnect', async () => {
    const w = world();
    const one = w.spine();
    await run(one, 'bg: run the audit');
    expect(one.pool.background(KEY)).toHaveLength(1);
    const claude = w.spawns[0].child;

    one.pair.drop();
    claude.finishBg();                                 // nobody is listening: the host buffers it, in order
    expect(w.host.size).toBe(1);

    const two = w.spine();
    expect(two.woken).toEqual([]);
    await two.adoptAll();
    await flush();
    expect(two.woken).toEqual([{ key: KEY, summaries: ['audit — completed'], reply: 'the audit is done' }]);
    expect(two.pool.background(KEY)).toEqual([]);
    expect(claude.controls).toEqual([]);              // the CLI's own turn on it is not interrupted
    expect(claude.killed).toBe(false);
    expect(w.spawns).toHaveLength(1);
  });

  it('(b) a task still running at the reconnect is known to the new spine — the pool holds it, and its completion wakes the being', async () => {
    const w = world();
    const one = w.spine();
    await run(one, 'bg: run the audit');
    one.pair.drop();
    const two = w.spine();
    await two.adoptAll();
    await flush();
    expect(two.pool.background(KEY).map((t) => t.description)).toEqual(['audit']);
    w.spawns[0].child.finishBg();
    await flush();
    expect(two.woken).toEqual([{ key: KEY, summaries: ['audit — completed'], reply: 'the audit is done' }]);
  });

  it('a turn in flight when the spine died is adopted: its reply reaches the being through the wake', async () => {
    const w = world();
    const one = w.spine();
    const claude = await (async () => { await run(one, 'hola'); return w.spawns[0].child; })();
    claude.holdNext = true;
    const lost = run(one, 'escribe el informe', { model: 'sonnet', sessionId: 'sess-1' }).catch((e) => e);
    await flush();
    one.pair.drop();                                   // a crash mid-turn (a planned restart drains first)
    expect(String((await lost).message)).toMatch(/gone|exited/);

    const two = w.spine();
    await two.adoptAll();
    expect(two.pool.busy(KEY)).toBe(true);             // the adopted turn holds the key
    claude.release();                                  // …and lands after the reconnect
    await flush();
    expect(two.woken).toEqual([{ key: KEY, reply: 'echo:escribe el informe' }]);
    expect(two.pool.busy(KEY)).toBe(false);
    expect((await run(two, 'gracias', { model: 'sonnet', sessionId: 'sess-1' })).text).toBe('echo:gracias');
    expect(w.spawns).toHaveLength(1);
  });

  it('…and one that landed while no spine was connected is in the replay; a command (/compact) is not a reply and wakes nothing', async () => {
    for (const [text, want] of [['escribe el informe', [{ key: KEY, reply: 'echo:escribe el informe' }]], ['/compact', []]]) {
      const w = world();
      const one = w.spine();
      await run(one, 'hola');
      const claude = w.spawns[0].child;
      claude.holdNext = true;
      run(one, text, { model: 'sonnet', sessionId: 'sess-1' }).catch(() => {});
      await flush();
      one.pair.drop();
      claude.release();
      const two = w.spine();
      await two.adoptAll();
      await flush();
      expect(two.woken).toEqual(want);
    }
  });

  it('(d) a sandboxed session survives with its lease: the launcher is never respawned or killed, and its being link still answers', async () => {
    const w = world();
    const jsonlStoreRoot = mkdtempSync(join(tmpdir(), 'egpt-clihost-'));
    const who = { being: 'egpt', surface: 'whatsapp', slug: 'fam', boxed: true };
    const linkOf = () => createBeingLink({ port: 1, startBrowser: async () => ({ ok: true }) });
    const boxed = { model: 'sonnet', sandboxed: true, sandboxOauthToken: 'tok', engine: 'ccode' };
    const factory = (linkHandle) => (o) => createSandboxCliSession({ ...o, platform: 'win32', jsonlStoreRoot, beingLink: linkHandle });

    const linkA = linkOf();
    let secret = null;
    const handleA = { mint: (s) => { const l = linkA.forBeing(who).mint(s); secret = l.secret; return l; } };
    const one = w.spine({ factory: factory(handleA) });
    expect((await run(one, 'hola', boxed)).text).toBe('echo:hola');
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].bin).toBe('powershell.exe');   // the daemon holds the LAUNCHER — the lease is its life
    const launcher = w.spawns[0].child;

    one.pair.drop();
    const linkB = linkOf();                            // the new spine's registry starts empty…
    const two = w.spine({ factory: factory({ mint: () => linkB.forBeing(who).mint(secret) }) });
    await two.adoptAll();
    expect(linkB.identify(authMac(secret, 'n1'), 'n1')).toEqual(who);   // …and knows the secret the process already holds

    expect((await run(two, 'sigues?', { ...boxed, sessionId: 'sess-1' })).text).toBe('echo:sigues?');
    expect(w.spawns).toHaveLength(1);
    expect(launcher.killed).toBe(false);
    expect(launcher.ended).toBe(false);
    expect(launcher.lines).toEqual(['hola', 'sigues?']);
  });

  it('(e) a DAEMON restart still ends every session (documented limit) — the next turn resumes by id', async () => {
    const w = world();
    const one = w.spine();
    await run(one, 'hola');
    // The daemon dies: its job object takes its children down with it (measured 2026-10-16, node 24).
    one.pair.drop();
    w.spawns[0].child.kill();
    await flush();
    expect(w.host.size).toBe(0);

    const w2 = world();                                // a fresh daemon holds nothing
    const two = w2.spine();
    await two.adoptAll();
    expect(two.pool.has(KEY)).toBe(false);
    expect((await run(two, 'sigues?', { model: 'sonnet', sessionId: 'sess-1' })).text).toBe('echo:sigues?');
    expect(w2.spawns).toHaveLength(1);
    expect(w2.spawns[0].args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
  });
});

describe('the host', () => {
  it('buffers in order and bounded: partials are shed first, results and notifications kept', async () => {
    const logs = [];
    const spawns = [];
    const host = createCliHost({ log: (m) => logs.push(m), setPriority: () => {}, bufferBytes: 600, spawn: () => { const c = fakeClaude(1); spawns.push(c); return c; } });
    const pair = ipcPair();
    host.attach(pair.daemonSide);
    const cli = connectCliHost(pair.spineSide, { [CLI_HOST_ENV]: '1' });
    cli.spawner(KEY, { opened: {} })('claude', [], {});
    await flush();
    pair.drop();
    const out = (ev) => spawns[0].stdout.emit('data', `${JSON.stringify(ev)}\n`);
    for (let i = 0; i < 20; i++) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `p${i}` } } });
    out({ type: 'system', subtype: 'task_notification', task_id: 'b1' });
    out({ type: 'result', subtype: 'success', result: 'done' });

    const pair2 = ipcPair();
    host.attach(pair2.daemonSide);
    const cli2 = connectCliHost(pair2.spineSide, { [CLI_HOST_ENV]: '1' });
    const [h] = await cli2.list();
    const a = await cli2.adopt(h.hid);
    const got = [];
    a.proc.stdout.on('data', (d) => got.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    await flush();
    expect(got.slice(-2).map((e) => e.type)).toEqual(['system', 'result']);
    const kept = got.filter((e) => e.type === 'stream_event').map((e) => e.event.delta.text);
    expect(kept.length).toBeLessThan(20);
    expect(kept).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`).slice(20 - kept.length));   // the newest, in order
    expect(got.map((l) => JSON.stringify(l).length + 1).reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(600);
    expect(a.dropped).toBe(20 - kept.length);
    expect(logs.some((l) => /shed/.test(l))).toBe(true);
  });

  it('a spine that never says hello (older code) ends what the host holds; one that does keeps it', () => {
    vi.useFakeTimers();
    try {
      const spawns = [];
      const host = createCliHost({ log: () => {}, setPriority: () => {}, spawn: () => { const c = fakeClaude(1); spawns.push(c); return c; } });
      const p1 = ipcPair();
      host.attach(p1.daemonSide);
      p1.daemonSide.emit('message', { t: 'cli:spawn', hid: 'x', key: KEY, bin: 'claude', args: [] });
      p1.drop();
      const p2 = ipcPair();
      host.attach(p2.daemonSide);
      p2.daemonSide.emit('message', { t: 'cli:hello' });
      vi.advanceTimersByTime(120_000);
      expect(spawns[0].killed).toBe(false);
      p2.drop();
      const p3 = ipcPair();
      host.attach(p3.daemonSide);                     // a rewound/rolled-back spine: no cli-host
      vi.advanceTimersByTime(120_000);
      expect(spawns[0].killed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('no daemon host (run by hand, tests): connectCliHost is null and the spine spawns as before', () => {
    expect(connectCliHost(new EventEmitter(), {})).toBeNull();
    expect(connectCliHost(Object.assign(new EventEmitter(), { send() {} }), {})).toBeNull();
  });
});

describe('the host, across more than one restart', () => {
  it('a spine that leaves before adopting does not lose the turn the one before it was waiting on', async () => {
    const spawns = [];
    const host = createCliHost({ log: () => {}, setPriority: () => {}, spawn: () => { const c = fakeClaude(1); spawns.push(c); return c; } });
    const p1 = ipcPair();
    host.attach(p1.daemonSide);
    const cli1 = connectCliHost(p1.spineSide, { [CLI_HOST_ENV]: '1' });
    const proc = cli1.spawner(KEY, { opened: {} })('claude', [], {});
    await flush();
    spawns[0].holdNext = true;
    proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'informe' }] } })}\n`);
    await flush();
    p1.drop();                                          // crash mid-turn
    const p2 = ipcPair();
    host.attach(p2.daemonSide);                         // a spine that dies while booting, before adopting…
    spawns[0].release();                                // …while the turn lands in the buffer
    p2.drop();
    const p3 = ipcPair();
    host.attach(p3.daemonSide);
    const cli3 = connectCliHost(p3.spineSide, { [CLI_HOST_ENV]: '1' });
    const [h] = await cli3.list();
    expect((await cli3.adopt(h.hid)).orphan).toEqual({ opener: 'informe' });
  });

  it('what /rewind ended is not offered for adoption', async () => {
    const slow = () => Object.assign(fakeClaude(1), { kill: () => true });   // still exiting when the next spine asks
    const host = createCliHost({ log: () => {}, setPriority: () => {}, spawn: slow });
    const p1 = ipcPair();
    host.attach(p1.daemonSide);
    connectCliHost(p1.spineSide, { [CLI_HOST_ENV]: '1' }).spawner(KEY, { opened: {} })('claude', [], {});
    await flush();
    host.endAll('/rewind');
    const p2 = ipcPair();
    host.attach(p2.daemonSide);
    expect(await connectCliHost(p2.spineSide, { [CLI_HOST_ENV]: '1' }).list()).toEqual([]);
  });

  it('a spawn with the daemon gone fails the turn instead of hanging it', async () => {
    const p = ipcPair();
    const cli = connectCliHost(p.spineSide, { [CLI_HOST_ENV]: '1' });
    p.drop();
    const s = createWarmCliSession({ spawn: cli.spawner(KEY, { opened: {} }) });
    await expect(s.turn('hola')).rejects.toThrow(/daemon holding the sessions is gone/);
  });
});

// Live 2026-10-21 (kg, E in SI+EduWeb): a sandboxed session LRU-evicted, its launcher gone, the host still
// listing it — adopted dead on every spine restart, the next turn written into nothing, the lane wedged for hours.
describe('a dead held session never wedges a conversation', () => {
  const OTHER = 'egpt:ccode:whatsapp:other';
  // A sandbox launcher: kill ends it, but the claude it started holds its stdio — 'exit', never 'close'.
  const launcherDies = (child) => { child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; }; };

  for (const [kind, prep] of [['a claude that closes', () => {}], ['a launcher whose pipes outlive it', launcherDies]]) {
    it(`(a) LRU eviction takes it off the host — ${kind} — so the next spine cannot adopt it`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const w = world();
        const one = w.spine({ max: 1 });
        await run(one, 'hola');
        const evicted = w.spawns[0].child;
        prep(evicted);
        await one.pool.run(OTHER, 'hey', () => {}, { brainOptions: { model: 'sonnet' }, klass: 'conversation' });
        await flush();
        expect(evicted.killed).toBe(true);
        vi.advanceTimersByTime(5_000);
        expect(w.logs).toContain(`cli-host: ${KEY} pid 7000 exited (SIGTERM)`);
        one.pair.drop();
        const two = w.spine();
        expect((await two.cli.list()).map((h) => h.key)).toEqual([OTHER]);
      } finally { vi.useRealTimers(); }
    });
  }

  it('a process that exits with its stdio held open still ends its session on the spine', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = world();
      const one = w.spine();
      await run(one, 'hola');
      w.spawns[0].child.emit('exit', 1, null);
      await flush();
      vi.advanceTimersByTime(5_000);
      await flush();
      expect(w.host.size).toBe(0);
      expect((await run(one, 'sigues?', { model: 'sonnet', sessionId: 'sess-1' })).text).toBe('echo:sigues?');
      expect(w.spawns).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('(B) an eviction mid-turn ends that turn even when its process is already dead — the lane goes on', async () => {
    const w = world();
    const one = w.spine();
    await run(one, 'hola');
    const dead = w.spawns[0].child;
    dead.stdin.write = () => true;                     // nothing reads the pipe…
    dead.kill = () => true;                            // …and nothing will ever close it
    const turn = run(one, 'estás?', { model: 'sonnet', sessionId: 'sess-1' }).catch((e) => e);
    await flush();
    expect(await one.pool.interrupt(KEY, { graceMs: 10 })).toEqual({ stopped: 'evict' });   // /agents stop
    expect(String((await turn).message)).toMatch(/closed mid-turn/);
    expect((await run(one, 'y', { model: 'sonnet', sessionId: 'sess-1' })).text).toBe('echo:y');
    expect(w.spawns).toHaveLength(2);
  });

  it('(c) a turn the process never answers (no event at all) is evicted and run once more on a fresh process, same thread', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = world();
      const one = w.spine();
      await run(one, 'hola');
      const mute = w.spawns[0].child;
      mute.stdin.write = () => true;
      const turn = run(one, 'estás?', { model: 'sonnet', sessionId: 'sess-1' });
      await flush();
      vi.advanceTimersByTime(120_000);
      expect((await turn).text).toBe('echo:estás?');
      expect(mute.killed).toBe(true);
      expect(w.spawns).toHaveLength(2);
      expect(w.spawns[1].args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
    } finally { vi.useRealTimers(); }
  });

  it('(c) …once: a fresh process that is silent too fails the turn, it does not spawn again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = world({ mute: () => true });
      const one = w.spine();
      const turn = run(one, 'hola').catch((e) => e);
      await flush();
      vi.advanceTimersByTime(120_000);
      await flush();
      vi.advanceTimersByTime(120_000);
      const err = await turn;
      expect(err.unresponsive).toBe(true);
      expect(w.spawns).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('a long turn that is talking is never cut by that bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = world();
      const one = w.spine();
      await run(one, 'hola');
      const claude = w.spawns[0].child;
      claude.holdNext = true;
      const turn = run(one, 'informe largo', { model: 'sonnet', sessionId: 'sess-1' });
      await flush();
      claude.stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })}\n`);
      await flush();
      vi.advanceTimersByTime(3_600_000);
      claude.release();
      expect((await turn).text).toBe('echo:informe largo');
      expect(w.spawns).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  // Live 2026-10-22 (reve): pid 32420, evicted 23:40, was re-adopted at five restarts and sent a turn at 08:29.
  it('what a spine evicted is never offered to the next one, even while its process is still up — the next turn spawns fresh', async () => {
    const w = world();
    const one = w.spine({ max: 1 });
    await run(one, 'hola');
    const evicted = w.spawns[0].child;
    evicted.kill = () => { evicted.killed = true; return true; };      // no 'exit', no 'close' yet
    const write = evicted.stdin.write;
    evicted.stdin.write = (d) => (evicted.ended ? true : write(d));    // its stdin is ended: nothing reaches it
    await one.pool.run(OTHER, 'hey', () => {}, { brainOptions: { model: 'sonnet' }, klass: 'conversation' });
    await flush();
    expect(evicted.killed).toBe(true);
    one.pair.drop();
    const two = w.spine();
    expect((await two.cli.list()).map((h) => h.key)).toEqual([OTHER]);
    await two.adoptAll();
    expect((await run(two, 'estás?', { model: 'sonnet', sessionId: 'sess-1' })).text).toBe('echo:estás?');
    expect(w.spawns).toHaveLength(3);
    expect(w.spawns[2].args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
  });

  it('the turn an adopted process was answering is not lost when that process dies: the being is woken to answer it, and the turn queued behind runs fresh', async () => {
    const w = world();
    const one = w.spine();
    await run(one, 'hola');
    const claude = w.spawns[0].child;
    claude.holdNext = true;
    run(one, 'revisa el sitio', { model: 'sonnet', sessionId: 'sess-1' }).catch(() => {});
    await flush();
    one.pair.drop();
    const two = w.spine();
    await two.adoptAll();
    const queued = run(two, 'estás de vuelta?', { model: 'sonnet', sessionId: 'sess-1' });
    claude.emit('exit', 1, null);
    claude.emit('close', 1, null);
    expect((await queued).text).toBe('echo:estás de vuelta?');
    await flush();
    expect(two.woken).toEqual([{ key: KEY, lost: 'revisa el sitio', why: expect.stringMatching(/exited 1/) }]);
    expect(w.spawns).toHaveLength(2);
  });

  it('…but an adopted turn ended on purpose (/agents stop, an eviction) wakes nothing', async () => {
    for (const end of [(s) => s.pool.interrupt(KEY, { graceMs: 10 }), (s) => s.pool.evict(KEY)]) {
      const w = world();
      const one = w.spine();
      await run(one, 'hola');
      const claude = w.spawns[0].child;
      claude.holdNext = true;
      run(one, 'revisa el sitio', { model: 'sonnet', sessionId: 'sess-1' }).catch(() => {});
      await flush();
      one.pair.drop();
      const two = w.spine();
      await two.adoptAll();
      await end(two);
      await flush();
      expect(two.woken).toEqual([]);
    }
  });
});
