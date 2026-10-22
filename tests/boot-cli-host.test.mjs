// boot-cli-host.test.mjs — the daemon-held sessions (src/cli-host.mjs) wired end to end through boot:
// two REAL boots against ONE host, the real warm session, only `claude` fake. Proves the glue — the
// hosted spawn, the adoption after the spine starts, the wake where the key last ran — not only the pieces.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-cli-host-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createCliHost, connectCliHost, CLI_HOST_ENV } from '../src/cli-host.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { ipcPair, fakeClaude } from './fake-claude-cli.mjs';

// The fake claudes' pids (71xx) answer the liveness probe as alive, unless named here: pid → the code it throws.
const probe = new Map();
const realKill = process.kill;

let boot, emptyState, ensureContact;
beforeAll(async () => {
  await fs.mkdir(`${_PRIVATE_HOME}/state`, { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
  vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
    if (sig !== 0 || !(pid >= 7100 && pid < 7200)) return realKill.call(process, pid, sig);
    if (probe.has(pid)) throw Object.assign(new Error(`kill ${probe.get(pid)}`), { code: probe.get(pid) });
    return true;
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!room:beeper.com';
const SELF_DM = '!self-dm';
const CONFIG = () => ({
  node_name: 'kg',
  user_name: 'An',
  networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: ['u-1'] } },
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { onIncoming: opts.onIncoming, streams: [] };
    built.push(spy);
    return {
      async send() { return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant() { return null; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// The daemon side, once per test; each spine is a boot over its own IPC pair to it.
function daemon() {
  const spawns = [];
  const host = createCliHost({
    log: () => {}, setPriority: () => {},
    spawn: (bin, args, opts) => { const child = fakeClaude(7100 + spawns.length); spawns.push({ bin, args, opts, child }); setImmediate(() => child.emit('spawn')); return child; },
  });
  const io = memIo();
  const state = { conv: null };
  const exits = [];
  const lines = [];
  const spine = async () => {
    const pair = ipcPair();
    host.attach(pair.daemonSide);
    const { start, built } = fakeTransport();
    const app = await boot({
      readConfig: CONFIG,
      startBridge: start,
      cliHost: connectCliHost(pair.spineSide, { [CLI_HOST_ENV]: '1' }),
      // The real warm session — and never a real claude: a spawn that did not come from the host is refused.
      makeSession: (o) => { if (!o.spawn) throw new Error('not hosted'); return createWarmCliSession({ ...o, cwd: undefined }); },
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => state.conv,
      writeState: async (s) => { state.conv = s; },
      io, ingest: false, tickMs: 0,
      spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
      reapPort: () => 0,
      exit: (code) => exits.push(code),
      now: () => Date.UTC(2026, 9, 16, 14, 5),
      log: { line: (s) => lines.push(s) },
    });
    const say = (body, chatId = CHAT) => built[0].onIncoming(body, {
      chatId, chatName: chatId === CHAT ? 'fam' : 'self-dm', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true,
      msgKey: `m-${Math.random()}`, ...(chatId === SELF_DM ? {} : { atEStart: true, atEAnywhere: true }),
    });
    return { pair, app, spy: built[0], say };
  };
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'fam', slugHint: 'fam' });
  const entry = ens.state.contacts.whatsapp[CHAT];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  state.conv = ens.state;
  return { host, spawns, spine, exits, lines };
}
const finals = (spy) => spy.streams.flatMap((s) => s.finals);

describe('boot — the daemon holds the sessions across a spine restart', () => {
  it('the new spine adopts the live claude: a task that finished in between wakes the being, and the next turn runs on the same process', async () => {
    const d = daemon();
    const one = await d.spine();
    await one.say('e, bg: run the audit');
    await vi.waitFor(() => expect(finals(one.spy).some((f) => f.includes('bg: run the audit'))).toBe(true), { timeout: 5000 });
    expect(d.spawns).toHaveLength(1);
    const claude = d.spawns[0].child;

    one.app.stop();
    one.pair.drop();                                   // /upgrade: the spine goes, the daemon and claude stay
    claude.finishBg();                                 // …and the audit finishes while nobody listens

    const two = await d.spine();
    await vi.waitFor(() => expect(finals(two.spy).some((f) => f.includes('A background task you started has finished: audit — completed'))).toBe(true), { timeout: 5000 });
    expect(two.spy.streams[0].chatId).toBe(CHAT);

    await two.say('e, sigues ahí?');
    await vi.waitFor(() => expect(finals(two.spy).some((f) => f.includes('echo:') && f.includes('sigues ahí?'))).toBe(true), { timeout: 5000 });
    expect(d.spawns).toHaveLength(1);                  // ← before: a second claude, --resume'd, and the audit's agent dead
    expect(claude.killed).toBe(false);
    expect(d.lines.some((l) => /\[cli-host\] adopted egpt:ccode:whatsapp:/.test(l))).toBe(true);
    two.app.stop();
  });

  it('step C no longer holds a SPINE restart for background work the daemon keeps: /restart leaves at once', async () => {
    const d = daemon();
    const one = await d.spine();
    await one.say('e, bg: run the audit');
    await vi.waitFor(() => expect(finals(one.spy)).toHaveLength(1), { timeout: 5000 });
    expect(one.app.pool.background(one.app.pool.stats().keys[0])).toHaveLength(1);
    await one.say('/e restart', SELF_DM);
    await vi.waitFor(() => expect(d.exits).toEqual([43]), { timeout: 5000 });
    expect(d.lines.some((l) => l.includes('drain: waiting for'))).toBe(false);
    expect(d.spawns[0].child.killed).toBe(false);
    one.app.stop();
  });
});

describe('boot — a held session whose process is gone is not adopted', () => {
  // 7101: odd, so never a live Windows pid — the ESRCH tasklist fallback agrees.
  for (const [code, adopted] of [['ESRCH', false], ['EPERM', true]]) {
    it(`${code}: ${adopted ? 'another account\'s process is alive — adopted' : 'dropped once, the next turn spawns fresh on --resume of the same thread'}`, async () => {
      const d = daemon();
      const one = await d.spine();
      await one.say('e, hola');
      await vi.waitFor(() => expect(finals(one.spy).some((f) => f.includes('echo:'))).toBe(true), { timeout: 5000 });
      one.app.stop();
      one.pair.drop();
      d.spawns[0].child.pid = 7101;
      probe.set(7101, code);
      try {
        const two = await d.spine();
        await vi.waitFor(() => expect(d.lines.some((l) => /\[cli-host\] (adopted|dropping held)/.test(l))).toBe(true), { timeout: 5000 });
        await two.say('e, sigues?');
        await vi.waitFor(() => expect(finals(two.spy).some((f) => f.includes('sigues?'))).toBe(true), { timeout: 5000 });
        expect(d.lines.filter((l) => l.includes('[cli-host] dropping held')).length).toBe(adopted ? 0 : 1);
        expect(d.lines.some((l) => l.includes('[cli-host] adopted'))).toBe(adopted);
        expect(d.spawns).toHaveLength(adopted ? 1 : 2);
        if (!adopted) expect(d.spawns[1].args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
        two.app.stop();
      } finally { probe.delete(7101); }
    });
  }
});
