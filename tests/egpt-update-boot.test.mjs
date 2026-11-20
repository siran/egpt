// egpt-update-boot.test.mjs — src/tools/egpt-update.mjs as boot.mjs wires it, on the heavy `ingest: true`
// real-boot harness (tests/spine-boot-announce.test.mjs): the spine's first tick looks at the checkout's
// upstream, the ask_on_boot line follows the "back up" line to the same chat, and under auto the
// existing /upgrade full leaves through the node's `exit` seam (46), once. The checkout is a throwaway
// clone two commits behind a local bare remote (no network); the process works from inside it.
// Beeper's own check rides the same tick and, by default, reads /opt/beeper, probes the Desktop ports and
// fetches the update feed: the config says `none` for it, and fetch is a recorder that refuses, so a test
// that reaches the network or the real Beeper fails instead of doing it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmpHome = join(os.tmpdir(), `egpt-boot-egpt-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;
const SIDECAR = join(tmpHome, 'state', 'restart-announce.json');
const STATE = join(tmpHome, 'state', 'egpt-update.json');
const SELF_CHAT = '!self:beeper.com';
const startCwd = process.cwd();
const realFetch = globalThis.fetch;
const supervisedWas = process.env.EGPT_SUPERVISED;
const selfUpdateWas = process.env.EGPT_SELF_UPDATE;
process.env.EGPT_SELF_UPDATE = 'on';   // the suite's default is off (tests/setup-egpt-home.mjs); this boot is fenced in above and below
const fetched = [];

let boot, emptyState;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd, name) => { writeFileSync(join(cwd, name), name); git(cwd, 'add', name); git(cwd, 'commit', '-qm', `add ${name}`); };

beforeAll(async () => {
  await fs.mkdir(join(tmpHome, 'state'), { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
  const root = mkdtempSync(join(os.tmpdir(), 'egpt-update-boot-'));
  const remote = join(root, 'remote.git'), mine = join(root, 'mine'), other = join(root, 'other');
  mkdirSync(remote);
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'clone', '-q', remote, mine);
  git(mine, 'checkout', '-q', '-B', 'main');
  commit(mine, 'one');
  git(mine, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'clone', '-q', remote, other);
  commit(other, 'two'); commit(other, 'three');
  git(other, 'push', '-q', 'origin', 'main');
  process.chdir(mine);   // the checkout the node looks at: process.cwd(), as boot's own shortSha reads it
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error(`no network in this test: ${url}`); };
}, 120_000);   // importing boot.mjs alone can take 15-20 s on a loaded box

// Every boot's whisper watcher pings the local resident whisper-server (:8089); that is not this test's concern.
afterEach(() => {
  const reached = fetched.splice(0).filter((u) => !u.startsWith('http://127.0.0.1:8089'));
  expect(reached, 'a boot reached for the network or the real Beeper').toEqual([]);
});

afterAll(async () => {
  process.chdir(startCwd);
  globalThis.fetch = realFetch;
  if (supervisedWas === undefined) delete process.env.EGPT_SUPERVISED; else process.env.EGPT_SUPERVISED = supervisedWas;
  if (selfUpdateWas === undefined) delete process.env.EGPT_SELF_UPDATE; else process.env.EGPT_SELF_UPDATE = selfUpdateWas;
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

async function waitFor(check, { timeoutMs = 10000, stepMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

function fakeStart() {
  const spy = { sent: [] };
  const start = async () => ({
    async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
    startStreamMessage() { return { update() {}, async finish() {} }; },
    isAlive: () => true, stop() {},
  });
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
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

const config = (autoUpdate) => ({
  node_name: 'kg',
  networks: { whatsapp: { chat_ids: [SELF_CHAT], allowed_users: ['u-1'] } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
  // Beeper's own method, said: none on every OS (its default is auto), so its check never looks at the host
  limbs: { beeper: { auto_update: { windows: { method: 'none' }, linux: { method: 'none' }, mac: { method: 'none' } } } },
  ...(autoUpdate ? { auto_update: autoUpdate } : {}),
});

// supervised: a daemon respawns this spine (EGPT_SUPERVISED=1, read by boot when it looks): auto needs it.
async function bootNode(cfg, { supervised = false } = {}) {
  if (supervised) process.env.EGPT_SUPERVISED = '1'; else delete process.env.EGPT_SUPERVISED;
  const { start, spy } = fakeStart();
  const lines = [], exits = [];
  let state = emptyState();
  await fs.rm(STATE, { force: true });
  await fs.writeFile(SIDECAR, JSON.stringify({ chatId: SELF_CHAT, kind: '/restart', preSha: 'abc123', pid: 999 }), 'utf8');
  const app = await boot({
    readConfig: () => cfg,
    startBridge: start,
    makeSession: fakeSession,
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io: memIo(),
    ingest: true,
    spawn: fakeSpawn,
    reapPort: () => 0,
    exit: (code) => exits.push(code),
    now: () => Date.UTC(2026, 10, 20, 12, 0),
    tickMs: 500,   // the spine's first tick, the boot look, comes this soon
    log: { line: (s) => lines.push(s) },
  });
  return { app, spy, lines, exits };
}

describe('boot.mjs — the eGPT update check', () => {
  it('manual: the notice line is logged, and ONE pending line follows the back-up line to the same chat', async () => {
    const { app, spy, lines, exits } = await bootNode(config({ egpt: 'manual' }));
    expect(await waitFor(() => spy.sent.some((s) => /eGPT 2 commits/.test(s.text)))).toBe(true);
    const at = (re) => spy.sent.findIndex((s) => re.test(s.text));
    expect(at(/egpt back up!/)).toBeGreaterThan(-1);
    expect(at(/⬆ pending: eGPT 2 commits \([0-9a-f]{8} → [0-9a-f]{8}\) — \/e upgrade full\. Apply now\?/), JSON.stringify(spy.sent)).toBeGreaterThan(at(/egpt back up!/));
    expect(spy.sent.filter((s) => /⬆ pending/.test(s.text)).map((s) => s.chatId)).toEqual([SELF_CHAT]);
    expect(lines.some((l) => /^\[egpt-update\] ⬆ kg · eGPT 2 new commits on main .*: add three; add two — send \/e upgrade full$/.test(l)), lines.join('\n')).toBe(true);
    expect(exits).toEqual([]);   // manual applies nothing
    expect(lines.filter((l) => /\[beeper-update\]/.test(l))).toEqual([]);   // Beeper's check looked at nothing
    app.stop();
  });

  it('auto: the same look leaves through the /upgrade full exit, once, the sha spent on disk first', async () => {
    const { app, spy, lines, exits } = await bootNode(config(), { supervised: true });   // no auto_update: the default is auto
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([46]);
    expect(JSON.parse(readFileSync(STATE, 'utf8')).autoTried).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(readFileSync(SIDECAR, 'utf8'))).toMatchObject({ kind: '/upgrade full' });   // the going-down half, unchanged
    expect(await waitFor(() => spy.sent.some((s) => /⬆ pending: eGPT 2 commits .* — at the next quiet moment/.test(s.text))), JSON.stringify(spy.sent)).toBe(true);
    expect(spy.sent.some((s) => /Apply now/.test(s.text))).toBe(false);
    expect(lines.some((l) => /upgrading \(\/upgrade full\) at the next quiet moment/.test(l))).toBe(true);
    app.stop();
  });

  it('auto without a daemon to respawn the spine: noticed as manual, nothing exits', async () => {
    const { app, spy, lines, exits } = await bootNode(config());   // no auto_update: auto; EGPT_SUPERVISED unset
    expect(await waitFor(() => spy.sent.some((s) => /⬆ pending: eGPT 2 commits .* — \/e upgrade full\. Apply now\?/.test(s.text))), JSON.stringify(spy.sent)).toBe(true);
    expect(lines.some((l) => /eGPT 2 new commits on main .* — send \/e upgrade full$/.test(l))).toBe(true);
    expect(exits).toEqual([]);
    app.stop();
  });

  it('none: nothing is fetched, said or exited', async () => {
    const { app, spy, lines, exits } = await bootNode(config({ egpt: 'none' }));
    expect(await waitFor(() => spy.sent.some((s) => /egpt back up!/.test(s.text)))).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));   // past the first tick
    expect(spy.sent.some((s) => /pending|eGPT \d/.test(s.text))).toBe(false);
    expect(exits).toEqual([]);
    expect(existsSync(STATE)).toBe(false);
    expect(lines.filter((l) => /\[egpt-update\]|\[beeper-update\]/.test(l))).toEqual([]);
    app.stop();
  });

  it('ask_on_boot false: the notice stays, the pending line does not', async () => {
    const { app, spy, lines } = await bootNode(config({ egpt: 'manual', ask_on_boot: false }));
    expect(await waitFor(() => lines.some((l) => /eGPT 2 new commits/.test(l)))).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(spy.sent.some((s) => /⬆ pending/.test(s.text))).toBe(false);
    app.stop();
  });
});
