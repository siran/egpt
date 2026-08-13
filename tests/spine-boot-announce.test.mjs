// spine-boot-announce.test.mjs — the restart-announce READ-BACK block in boot.mjs
// (src/spine/boot.mjs, "Back-up announce") must never leave the operator silently
// in the dark about a restart:
//   sidecar present (a lifecycle command, or the daemon's crash/wedge fallback,
//     src/daemon-runtime.mjs)  -> "egpt back up! (...)" — UNCHANGED, locked here too.
//   sidecar missing (cold boot: first-ever start, or a gap the fallback couldn't
//     resolve a chat id for) -> "egpt started (...)" instead of silence.
//
// Modeled on the heavy `ingest: true` real-boot harness (tests/boot-profile-contract.test.mjs)
// combined with the lighter fakeStart/memIo/config shape (tests/stop-file.test.mjs). The
// sidecar itself is real fs (boot.mjs reads/writes it via node:fs/promises directly, not the
// injected `io` seam) at the real path under the isolated tmp EGPT_HOME.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

const tmpHome = join(os.tmpdir(), `egpt-boot-announce-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;
const SIDECAR = join(tmpHome, 'state', 'restart-announce.json');

let boot, emptyState;

beforeAll(async () => {
  await fs.mkdir(join(tmpHome, 'state'), { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});

afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

// Every case starts from no sidecar on disk — each test writes its own (or none).
async function clearSidecar() { await fs.rm(SIDECAR, { force: true }); }

// The announce block is a fire-and-forget async IIFE (real fs readFile/unlink, real
// bridge.send) — poll briefly instead of guessing a fixed number of microtask ticks.
async function waitFor(check, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

// --- boot harness (stop-file.test.mjs's fakeStart/memIo shape) ---------------------------
function fakeStart() {
  const spy = { started: false, onIncoming: null, sent: [] };
  const start = async (opts) => {
    spy.started = true;
    spy.onIncoming = opts.onIncoming;
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, spy };
}
const fakeSession = (opts) => ({
  sessionId: opts.sessionId ?? 'sess-1',
  async turn(message, onUpdate) { onUpdate?.(`↩ ${message}`); return { text: `↩ ${message}`, sessionId: this.sessionId }; },
  close() {},
});
function memIo() {
  const files = new Map(); const dirs = new Set();
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (p, d) => files.set(p, `${files.get(p) ?? ''}${d}`),
    writeFile: async (p, d) => files.set(p, String(d)),
    readFile: async (p) => { if (!files.has(p)) throw missing(p); return files.get(p); },
    mkdir: async (p) => { dirs.add(p); },
    existsSync: (p) => files.has(p) || dirs.has(p),
    readdir: async (p) => [...files.keys()].filter((f) => dirname(f) === p).map((f) => f.slice(p.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}
// fake spawn so a heartbeat command beat never runs a real shell (boot-profile-contract's recipe).
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

const SELF_CHAT = '!self:beeper.com';
const CONFIG = {
  node_name: 'kg',   // mandatory — boot throws without one
  networks: { whatsapp: { chat_ids: [SELF_CHAT], allowed_users: ['u-1'] } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
};
const AT = Date.UTC(2026, 7, 13, 12, 0);

async function bootNode() {
  const { start, spy } = fakeStart();
  let state = emptyState();
  const app = await boot({
    readConfig: () => CONFIG,
    startBridge: start,
    makeSession: fakeSession,
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io: memIo(),
    ingest: true,                 // the announce block is gated on this
    spawn: fakeSpawn,
    reapPort: () => 0,             // fake the stray-whisper port-killer — never taskkill a real process
    exit: () => {},                // a lifecycle ingest command must never kill the test process
    now: () => AT,
    tickMs: 0,
    log: { line: () => {} },
  });
  return { app, spy };
}

describe('boot.mjs — restart-announce read-back', () => {
  it('a MISSING sidecar (cold boot) still announces — "egpt started", not silence', async () => {
    await clearSidecar();
    const { app, spy } = await bootNode();
    await waitFor(() => spy.sent.length > 0);

    const started = spy.sent.find((s) => /egpt started/.test(s.text));
    expect(started, JSON.stringify(spy.sent)).toBeTruthy();
    expect(started.chatId).toBe(SELF_CHAT);
    app.stop();
  });

  it('regression: an EXISTING sidecar still produces "egpt back up!" — byte-for-byte unchanged', async () => {
    await clearSidecar();
    await fs.writeFile(SIDECAR, JSON.stringify({ chatId: SELF_CHAT, kind: '/restart', preSha: 'abc123', pid: 999 }), 'utf8');
    const { app, spy } = await bootNode();
    await waitFor(() => spy.sent.length > 0 || !existsSync(SIDECAR));

    const backUp = spy.sent.find((s) => /egpt back up!/.test(s.text));
    expect(backUp, JSON.stringify(spy.sent)).toBeTruthy();
    expect(backUp.chatId).toBe(SELF_CHAT);
    expect(backUp.text).toContain('abc123');
    expect(existsSync(SIDECAR)).toBe(false);   // consumed, same as the existing unlink(sidecar) behavior
    app.stop();
  });
});
