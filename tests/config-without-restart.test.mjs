// CONFIG WITHOUT RESTART (step B, INFORME-reinicios-sin-matar-agentes, 2026-10-16).
//
// A changed config.yaml used to restart the whole spine (exit 43) when auto_restart_on_config_change
// was on — killing every being's `claude` and its background agents for an edit to ONE being. Now
// boot swaps the new config in (getConfig() returns it) and only the restart-only keys
// (config-swap.mjs RESTART_KEYS) take the drained restart. A being's spawn options changing reopens
// THAT being's warm session on its next turn — never mid-turn, never under live background work.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-config-without-restart-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { restartKeysChanged, changedKeys, isRestartKey } from '../src/spine/config-swap.mjs';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

// ── the classification ────────────────────────────────────────────────────────────────────────
describe('config-swap — restart-only keys', () => {
  const base = { node_name: 'kg', beeper: { main: { token: 'A' } }, agents: { e: { default: true, mode: 'on' }, h: { configuration: 'x' } }, liveness: { every_ms: 15000 } };

  it('a per-being key, dispatch and liveness are hot', () => {
    const next = { ...base, agents: { e: { default: true, mode: 'mute' }, h: { configuration: 'y' } }, dispatch: { auto_default_mode: 'on' }, liveness: { every_ms: 60000 } };
    expect(restartKeysChanged(base, next)).toEqual([]);
    expect(changedKeys(base, next)).toEqual(['agents.e', 'agents.h', 'liveness', 'dispatch']);
  });

  it('a token, a port, an agent\'s connection are restart-only, named by path; `default:` is ignored (no default agent)', () => {
    const next = { ...base, beeper: { main: { token: 'B' } }, shell: { port: 23999 }, agents: { e: { mode: 'on' }, h: { configuration: 'x', use: 'secondary', default: true } } };
    expect(restartKeysChanged(base, next)).toEqual(['beeper', 'agents.h.use', 'shell']);
  });

  it('isRestartKey answers /config set targets: under a restart key, or a parent of one', () => {
    expect(isRestartKey('beeper.main.token')).toBe(true);
    expect(isRestartKey('agents.h.use')).toBe(true);
    expect(isRestartKey('warm.max')).toBe(true);
    expect(isRestartKey('agents.h.configuration')).toBe(false);
    expect(isRestartKey('warm.idle_ttl')).toBe(false);
    expect(isRestartKey('dispatch.auto_default_mode')).toBe(false);
  });
});

// ── (c)+(d) the warm pool: a changed spawn option reopens that key only, never under background work ──
function sessions() {
  const made = [];
  const makeSession = (opts) => {
    const s = { opts, closed: false, turns: [], background: 0, get sessionId() { return opts.sessionId ?? null; }, close() { this.closed = true; }, async turn(m) { this.turns.push(m); return { text: m, sessionId: this.sessionId }; } };
    made.push(s);
    return s;
  };
  return { made, makeSession };
}
const full = (over = {}) => ({ sessionId: 'S1', engine: 'ccode', cwd: '/c', model: 'opus', allowedTools: ['Read'], sandboxed: false, dangerouslySkipPermissions: false, verboseThinking: false, ...over });

describe('warm pool — the reopen guard covers every spawn option', () => {
  it('a changed system prompt reopens that key only; the other key keeps its process', async () => {
    const { made, makeSession } = sessions();
    const pool = createWarmPool({ makeSession });
    await pool.run('h:ccode:wa:x', 'a', () => {}, { brainOptions: full({ appendSystemPrompt: 'old' }) });
    await pool.run('e:ccode:wa:x', 'a', () => {}, { brainOptions: full() });
    await pool.run('h:ccode:wa:x', 'b', () => {}, { brainOptions: full({ appendSystemPrompt: 'new' }) });
    await pool.run('e:ccode:wa:x', 'b', () => {}, { brainOptions: full() });
    expect(made).toHaveLength(3);
    expect(made[0].closed).toBe(true);
    expect(made[2].opts.appendSystemPrompt).toBe('new');
    expect(made[1].closed).toBe(false);
    expect(made[1].turns).toEqual(['a', 'b']);
  });

  it('equal arrays and a fresh being link are not a change; a secret is never logged', async () => {
    const { made, makeSession } = sessions();
    const logs = [];
    const pool = createWarmPool({ makeSession, onLog: (m) => logs.push(m) });
    await pool.run('k', 'a', () => {}, { brainOptions: full({ beingLink: { n: 1 }, sandboxOauthToken: 'sk-old' }) });
    await pool.run('k', 'b', () => {}, { brainOptions: full({ allowedTools: ['Read'], beingLink: { n: 2 }, sandboxOauthToken: 'sk-old' }) });
    expect(made).toHaveLength(1);
    await pool.run('k', 'c', () => {}, { brainOptions: full({ sandboxOauthToken: 'sk-new' }) });
    expect(made).toHaveLength(2);
    expect(logs.join('\n')).not.toMatch(/sk-(old|new)/);
    expect(logs.some((l) => /configuration changed: sandboxOauthToken/.test(l))).toBe(true);
  });

  it('(d) live background work defers the reopen; the first turn after it ends reopens', async () => {
    const { made, makeSession } = sessions();
    const logs = [];
    const pool = createWarmPool({ makeSession, onLog: (m) => logs.push(m) });
    await pool.run('k', 'a', () => {}, { brainOptions: full({ model: 'sonnet' }) });
    made[0].background = 2;
    await pool.run('k', 'b', () => {}, { brainOptions: full({ model: 'opus' }) });
    expect(made).toHaveLength(1);
    expect(made[0].closed).toBe(false);
    expect(made[0].turns).toEqual(['a', 'b']);
    expect(logs.some((l) => /configuration changed on k \(model sonnet→opus\) — reopen deferred: 2 background task\(s\) still running/.test(l))).toBe(true);
    made[0].background = 0;
    await pool.run('k', 'c', () => {}, { brainOptions: full({ model: 'opus' }) });
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    expect(made[1].opts.model).toBe('opus');
  });
});

// (The spine half — apply / restart / refuse on the tick — is tests/spine-config-restart.test.mjs.)

// ── boot: the real wiring ──────────────────────────────────────────────────────────────────────
const CHAT = '!room:beeper.com';
const LOGS = '!logs:beeper.com';
const BASE = () => ({
  node_name: 'kg',
  user_name: 'John',
  auto_restart_on_config_change: true,
  log_to_group: 'eGPT Logs',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: {
    egpt: { configuration: { type: 'ccode', model: 'haiku' }, handles: ['e'], default: true, name: 'E' },
    h: { configuration: { type: 'ccode', model: 'sonnet' }, handles: ['h'], name: 'H' },
  },
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
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
  const sent = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, streams: [] };
    built.push(spy);
    return {
      async send(text, o) { sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async resolveChatId(name) { return name === 'eGPT Logs' ? LOGS : null; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built, sent };
}

async function bootWith({ modes = {}, edit = (c) => c } = {}) {
  const { start, built, sent } = fakeTransport();
  const made = [];
  const exits = [];
  const lines = [];
  let config = edit(BASE());
  let hash = 'h0';
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'fam', slugHint: 'fam' });
  let convState = ens.state;
  const entry = convState.contacts.whatsapp[CHAT];
  entry.agents = Object.fromEntries(Object.entries(modes).map(([b, mode]) => [b, { mode }]));
  const io = memIo();
  const app = await boot({
    readConfig: () => structuredClone(config),
    readConfigHash: () => hash,
    startBridge: start,
    makeSession: (opts) => {
      const s = { opts, closed: false, turns: [], background: 0, get sessionId() { return opts.sessionId ?? `sess-${made.indexOf(s)}`; }, async turn(m) { this.turns.push(m); return { text: 'ok', sessionId: this.sessionId }; }, close() { this.closed = true; } };
      made.push(s);
      return s;
    },
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0,
    exit: (code) => exits.push(code),
    now: () => Date.UTC(2026, 9, 16, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  const say = (body, msgKey) => built[0].onIncoming(body, { chatId: CHAT, chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey });
  const save = (edit) => { config = edit(structuredClone(config)); hash = `h${Number(hash.slice(1)) + 1}`; };
  const card = () => [...io.files].find(([p]) => p.endsWith('config.readonly.yaml'))?.[1] ?? '';
  return { app, made, exits, lines, sent, say, save, card };
}

describe('boot — a config.yaml edit applies without a restart unless it touches a restart-only key', () => {
  // The conversation sets no mode of its own, so the node and agent rungs decide (gating resolveMode).
  it('(a) dispatch.auto_default_mode, agents.<x>.mode, liveness.every_ms: swapped, no restart, the next turn sees it', async () => {
    // h holds 'mention' here, so the node rung moves egpt alone (an 'on' node default would wake every being).
    const t = await bootWith({ modes: { h: 'mention' }, edit: (c) => ({ ...c, dispatch: { auto_default_mode: 'off' } }) });
    await t.say('@e hola', 'm1');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.made).toHaveLength(0);                            // egpt off: no turn

    t.save((c) => ({ ...c, dispatch: { auto_default_mode: 'on' }, liveness: { every_ms: 60_000 } }));
    t.app.spine.tick();
    await t.say('@e otra', 'm2');
    await vi.waitFor(() => expect(t.card()).toMatch(/mode: on\s+# node default/));

    t.save((c) => { c.agents.egpt.mode = 'on'; return c; });
    t.app.spine.tick();
    await t.say('@e y otra', 'm3');
    await vi.waitFor(() => expect(t.card()).toMatch(/mode: on\s+# agent default/));

    expect(t.made).toHaveLength(1);                            // one warm process throughout
    expect(t.exits).toEqual([]);
    expect(t.app.cfg.liveness).toEqual({ every_ms: 60_000 });
    expect(t.lines.some((l) => l.includes('config.yaml applied without a restart'))).toBe(true);
    t.app.stop();
  });

  it('a change is applied when the next message arrives, before any tick', async () => {
    const t = await bootWith({ edit: (c) => ({ ...c, dispatch: { auto_default_mode: 'off' } }) });
    t.save((c) => { c.agents.egpt.mode = 'on'; return c; });
    await t.say('@e hola', 'm1');
    await vi.waitFor(() => expect(t.card()).toMatch(/mode: on\s+# agent default/));
    expect(t.exits).toEqual([]);
    t.app.stop();
  });

  it('(b) a restart-only key (shell.port, a beeper token) still takes the drained restart, config untouched', async () => {
    const t = await bootWith();
    t.save((c) => ({ ...c, shell: { port: 23999 }, agents: { ...c.agents, egpt: { ...c.agents.egpt, mode: 'on' } } }));
    t.app.spine.tick();
    await vi.waitFor(() => expect(t.exits).toEqual([43]));
    expect(t.app.cfg.shell).toBeUndefined();
    expect(t.app.cfg.agents.egpt.mode).toBeUndefined();
    expect(t.lines.some((l) => l.includes('restart-only key(s) shell'))).toBe(true);
    t.app.stop();

    const u = await bootWith();
    u.save((c) => { c.beeper.main.token = 'TOK2'; return c; });
    u.app.spine.tick();
    await vi.waitFor(() => expect(u.exits).toEqual([43]));
    u.app.stop();
  });

  it('(c) agents.h.configuration: only H\'s warm session reopens, on H\'s next turn; E keeps its process', async () => {
    const t = await bootWith({ modes: { egpt: 'mention', h: 'mention' } });
    await t.say('@e hola', 'm1');
    await t.say('@h hola', 'm2');
    await vi.waitFor(() => expect(t.made.map((s) => s.opts.model)).toEqual(['haiku', 'sonnet']));
    const [e, h] = t.made;

    t.save((c) => { c.agents.h.configuration = { type: 'ccode', model: 'opus' }; return c; });
    t.app.spine.tick();
    expect(t.exits).toEqual([]);
    expect(h.closed).toBe(false);                              // not at the swap: on H's next turn

    await t.say('@h otra', 'm3');
    await vi.waitFor(() => expect(t.made.map((s) => s.opts.model)).toEqual(['haiku', 'sonnet', 'opus']));
    expect(h.closed).toBe(true);
    expect(t.made[2].opts.sessionId).toBe(h.sessionId);        // the same thread, resumed on the new engine

    await t.say('@e otra', 'm4');
    await vi.waitFor(() => expect(e.turns).toHaveLength(2));
    expect(e.closed).toBe(false);
    expect(t.made).toHaveLength(3);
    t.app.stop();
  });

  it('(e) an invalid config: the old one stays, logged, one line to the logging group, no restart', async () => {
    const t = await bootWith();
    t.save((c) => { delete c.node_name; c.agents.egpt.mode = 'on'; return c; });
    t.app.spine.tick();
    await vi.waitFor(() => expect(t.sent.filter((s) => s.chatId === LOGS)).toHaveLength(1));
    expect(t.sent.find((s) => s.chatId === LOGS).text).toContain('config.yaml change refused, the running config stays: boot: no node_name');
    expect(t.lines.some((l) => l.includes('config.yaml change REFUSED'))).toBe(true);
    expect(t.app.cfg.node_name).toBe('kg');
    expect(t.app.cfg.agents.egpt.mode).toBeUndefined();
    t.app.spine.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sent.filter((s) => s.chatId === LOGS)).toHaveLength(1);
    expect(t.exits).toEqual([]);
    t.app.stop();
  });
});
