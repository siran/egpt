// boot-side-group-accum.test.mjs — one accum from a chat and its SI+ side group, wired end to end through
// boot (operator 2026-11-20): the real transcript writer, contacts, accum reader and spine over one
// in-memory folder. The unit cases (order, day, ties, which chats) are in side-group-accum.test.mjs; this
// is the wiring: a turn woken in the chat is prompted with what was said in the side group since the
// being's last turn, and what the being was told before that is not told again.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-side-group-accum-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState, ensureContact, aliasContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact, aliasContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!grupo:beeper.com';
const SIDE = '!sigrupo:beeper.com';
const CONFIG = () => ({
  node_name: 'kg',
  user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { name: 'egpt', configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
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
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, streams: [] };
    built.push(spy);
    return {
      async send() { return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// The chat in mode accum, and its SI+ group: an alias of it, marked automatic (what reply_in_side_group makes).
function seed() {
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'Grupo', slugHint: 'grupo' });
  const entry = ens.state.contacts.whatsapp[CHAT];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'accum' } };
  return aliasContact(ens.state, 'whatsapp', SIDE, CHAT, { transcript: 'SI+Grupo', automatic: true });
}

const MIN = 60_000;
const contextOf = (prompt) => (prompt.includes('ACCUMULATED CONTEXT') ? prompt.split('do not answer it.\n')[1].split('\n\n') : []);

describe('boot — a turn woken in the chat reads the SI+ group too', () => {
  it('REPRODUCE: the side group\'s lines since the being\'s last turn are in the prompt; what came before it are not', async () => {
    const { start, built } = fakeTransport();
    const io = memIo();
    const prompts = [];
    let convState = seed();
    const app = await boot({
      readConfig: CONFIG,
      startBridge: start,
      makeSession: (opts) => ({
        opts, sessionId: 'sess-1',
        async turn(m, onUpdate) { prompts.push(m); onUpdate?.('listo'); return { text: 'listo', sessionId: this.sessionId }; },
        close() {},
      }),
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => convState,
      writeState: async (s) => { convState = s; },
      io, ingest: false, tickMs: 0,
      log: { line() {} },
    });
    const spy = built[0];
    let n = 0;
    const said = (chatId, chatName, who, text, ts) => spy.onIncoming(text, { chatId, chatName, network: 'whatsapp', userId: who, senderName: who, authorized: true, msgKey: `m${++n}`, ts });
    const t0 = Date.now();
    await said(CHAT, 'Grupo', 'Lola', 'uno', t0 - 30 * MIN);
    await said(SIDE, 'SI+Grupo', 'Pepe', 'dos', t0 - 25 * MIN);
    await said(CHAT, 'Grupo', 'Lola', '@e resume', t0 - 20 * MIN);                       // its turn: the reply is logged now
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(() => expect([...io.files.values()].join('')).toContain('listo'), { timeout: 5000 });
    await said(SIDE, 'SI+Grupo', 'Pepe', 'tres', Date.now());
    await said(CHAT, 'Grupo', 'Lola', '@e otra', Date.now());
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 5000 });

    expect(contextOf(prompts[0]).map((b) => b.replace(/^.*?: /, ''))).toEqual(['uno', 'dos']);
    expect(contextOf(prompts[1]).map((b) => b.replace(/^.*?: /, ''))).toEqual(['tres']);   // the other group's line; not uno, dos, nor its own reply
    expect(contextOf(prompts[1])[0]).toContain('@[SI+Grupo]');                                  // under its own group's name
    app.stop();
  });
});
