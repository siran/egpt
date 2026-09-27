// being-browser.test.mjs — A BOXED BEING ASKS THE SPINE TO START ITS BROWSER (operator 2026-09-26).
//
// THE MEASUREMENT: the brain Chrome (CDP :9221, config chrome.profile_dir) died at a reboot, and being
// E — boxed, running as a pool account — could not restart it. /chrome is operator-gated, and a
// chrome.exe the being launched itself would run as egpt-sbx-NN against a profile sealed by DPAPI to
// the operator: logged out, and a risk to the profile. The operator's ruling, verbatim: "granting a
// sandbox being to execute any arbitrary command through the spine (operator's account) defeats the
// purpose of the sandbox. so it seems for now only the browser."
//
// So a boxed being may ask for exactly ONE thing, `browser start`, and passes NOTHING with it — no
// executable, no flags, no port, no profile. The spine alone decides what runs. What this file locks:
//   1. the wire (src/shell/being.mjs) and the link's registry + request (src/spine/being-link.mjs);
//   2. the limb (src/bridges/shell-port.mjs): /being is routed like /peer, answers only a live
//      minted secret, never touches the console seat, never reaches the turn dispatch;
//   3. the mint (src/sandbox-cli-session.mjs): three entries in the ONE -SetEnv element for a boxed
//      ccode session, revoked at close, nothing for codex/pi, the secret never logged;
//   4. the request runs /chrome's OWN launch path (src/spine/commands.mjs startBrowser), idempotent,
//      and two concurrent asks launch one browser;
//   5. the client (src/tools/ask-spine.mjs), end to end over a real loopback socket.
import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { responseFrame, authMac, macMatches } from '../src/shell/auth.mjs';
import { MOUTH_PATH } from '../src/shell/mouth.mjs';
import { BEING_PATH, isBeingDial, askFrame, askResultFrame, parseAskFrame, SPINE_PORT_ENV, BEING_TOKEN_ENV, ASK_SPINE_ENV } from '../src/shell/being.mjs';
import { createBeingLink, askSpineClientPath } from '../src/spine/being-link.mjs';
import { createSandboxCliSession } from '../src/sandbox-cli-session.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { askSpine } from '../src/tools/ask-spine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(REPO, 'src', 'tools', 'ask-spine.mjs');
const STORE = mkdtempSync(join(tmpdir(), 'egpt-being-browser-'));
afterAll(() => { try { rmSync(STORE, { recursive: true, force: true }); } catch { /* best effort */ } });
const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN-NOT-REAL';
const SHELL_TOKEN = 'the-operators-shell-token';
const E_IN_ACIM = { being: 'e', surface: 'room', slug: 'acim' };

// ── THE TRANSPORT SEAM (tests/peer-mouth.test.mjs's, same shape) ───────────────────────────────
class Sock {
  constructor() { this._h = {}; this.readyState = 1; this.closed = false; this.sent = []; }
  on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
  fire(ev, ...a) { for (const cb of [...(this._h[ev] || [])]) cb(...a); }
  send(d) { if (this.closed) throw new Error('socket is closed'); this.sent.push(String(d)); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.fire('close'); }
}
function makeFakeWss() {
  const servers = [];
  class FakeWSS {
    constructor(opts) { this.opts = opts; this._h = {}; servers.push(this); }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); if (ev === 'listening') cb(); return this; }
    fire(ev, ...a) { for (const cb of [...(this._h[ev] || [])]) cb(...a); }
    close() {}
    dial(path) { const ws = new Sock(); this.fire('connection', ws, path == null ? undefined : { url: path }); return ws; }
  }
  return { WebSocketServer: FakeWSS, servers };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// A being link reduced to what the limb needs from it — real HMACs, so the handshake is the real
// one. Used where the test is about the LIMB; the real link is exercised in its own sections.
function fakeLink(secrets = { 'being-secret-1': E_IN_ACIM }) {
  const asked = [];
  return {
    asked,
    identify: (mac, nonce) => {
      for (const [s, who] of Object.entries(secrets)) if (macMatches(mac, authMac(s, nonce))) return who;
      return null;
    },
    ask: async (who, frame) => { asked.push({ who, frame }); return { ok: true, alreadyRunning: true, detail: 'already answering' }; },
  };
}

function limb({ onBeing = fakeLink(), onPeerSay = null } = {}) {
  const { WebSocketServer, servers } = makeFakeWss();
  const logs = [];
  const turns = [];
  const port = createShellPort({ WebSocketServer, token: SHELL_TOKEN, reapPort: () => 0, onBeing, onPeerSay, onLog: (m) => logs.push(m) });
  port.onMessage((ev) => turns.push(ev));
  port.start();
  return { port, server: servers[0], logs, turns, onBeing };
}
const answerChallenge = (ws, secret) => {
  const challenge = JSON.parse(ws.sent.shift());
  ws.fire('message', Buffer.from(responseFrame(secret, challenge.nonce)));
};
const seatEditor = (server) => { const ws = server.dial(); answerChallenge(ws, SHELL_TOKEN); return ws; };

// A fake launcher process: enough for createSandboxCliSession to spawn through, read synchronously.
function launcherSpawn() {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push(args);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.stdin = { write: () => {}, end: () => {} };
    proc.kill = () => {};
    return proc;
  };
  return { spawn: spawnFn, calls };
}
const setEnvOf = (args) => (args.includes('-SetEnv') ? JSON.parse(args[args.indexOf('-SetEnv') + 1]) : []);
// A deterministic secret so a test can look for it everywhere it must NOT be.
const fixedBytes = (fill) => (n) => Buffer.alloc(n, fill);

describe('REPRODUCE: a boxed being has no way to ask the spine for its browser', () => {
  it('a boxed ccode session is handed a browser credential through the ONE -SetEnv element', async () => {
    const f = launcherSpawn();
    const minted = [];
    const beingLink = { mint: () => { minted.push(1); return { env: ['EGPT_BEING_TOKEN=minted-secret'], revoke: () => {} }; } };
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE, sessionId: 'thread-x', gitBashCandidates: [], beingLink });
    s.turn('hi').catch(() => {});
    s.close();
    expect(minted).toHaveLength(1);
    expect(setEnvOf(f.calls[0])).toContain('EGPT_BEING_TOKEN=minted-secret');
  });

  it('a being that dials /being with a credential the spine minted is heard — not treated as a console client', async () => {
    const { server, onBeing, turns, port } = limb();
    const ws = server.dial('/being');
    answerChallenge(ws, 'being-secret-1');
    ws.fire('message', Buffer.from(JSON.stringify({ ask: 'browser', action: 'start' })));
    await flush();
    expect(onBeing.asked).toHaveLength(1);
    expect(onBeing.asked[0].who).toEqual(E_IN_ACIM);
    expect(turns).toEqual([]);
    port.stop();
  });
});

// ── 1. THE WIRE AND THE LINK ──────────────────────────────────────────────────────────────────
describe('the wire: one dial path, one two-field request', () => {
  it('/being is recognised by the same path rule the mouth uses — and nothing that merely starts like it', () => {
    expect(BEING_PATH).toBe('/being');
    expect(isBeingDial({ url: '/being' })).toBe(true);
    expect(isBeingDial({ url: '/being?x=1' })).toBe(true);
    expect(isBeingDial({ url: '/beings' })).toBe(false);
    expect(isBeingDial({ url: MOUTH_PATH })).toBe(false);
    expect(isBeingDial(undefined)).toBe(false);
  });

  it('a request is ask + action and nothing else; any other field is reported by NAME, never by value', () => {
    expect(JSON.parse(askFrame({ ask: 'browser', action: 'start' }))).toEqual({ ask: 'browser', action: 'start' });
    expect(parseAskFrame(askFrame({ ask: 'browser', action: 'start' }))).toEqual({ ask: 'browser', action: 'start', extra: [] });
    const smuggled = parseAskFrame(JSON.stringify({ ask: 'browser', action: 'start', executable: 'C:/evil.exe', args: ['--x'] }));
    expect(smuggled.extra).toEqual(['executable', 'args']);
    expect(JSON.stringify(smuggled)).not.toContain('evil');
    for (const junk of ['', 'hola', '{"text":"/upgrade"}', '[1]', '{"auth":"response","mac":"x"}']) expect(parseAskFrame(junk)).toBe(null);
  });

  it('the answer frame round-trips', () => {
    expect(parseAskFrame(askResultFrame({ ok: true, launched: true, detail: 'up' }))).toEqual({ ask: 'result', ok: true, launched: true, alreadyRunning: false, reason: '', detail: 'up' });
    expect(parseAskFrame(askResultFrame({ ok: false, reason: 'launch-failed', detail: 'no exe' }))).toMatchObject({ ok: false, reason: 'launch-failed', detail: 'no exe' });
  });
});

describe('the link: a secret per boxed session, and one request', () => {
  it('mints three entries — the port, THIS session\'s secret, the client — and identifies its own answers only', () => {
    const link = createBeingLink({ port: 23475, clientPath: 'C:/x/ask-spine.mjs', startBrowser: async () => ({ ok: true }), randomBytes: fixedBytes(7) });
    const { env } = link.forBeing(E_IN_ACIM).mint();
    const secret = '07'.repeat(32);
    expect(env).toEqual([`${SPINE_PORT_ENV}=23475`, `${BEING_TOKEN_ENV}=${secret}`, `${ASK_SPINE_ENV}=C:/x/ask-spine.mjs`]);
    expect(link.identify(authMac(secret, 'n1'), 'n1')).toEqual(E_IN_ACIM);
    // a replayed answer to ANOTHER nonce, and the operator's shell token, are nobody
    expect(link.identify(authMac(secret, 'n1'), 'n2')).toBe(null);
    expect(link.identify(authMac(SHELL_TOKEN, 'n1'), 'n1')).toBe(null);
  });

  it('two sessions get two secrets, and revoking one leaves the other live', () => {
    const link = createBeingLink({ port: 1, startBrowser: async () => ({ ok: true }) });
    const a = link.forBeing(E_IN_ACIM).mint();
    const b = link.forBeing({ being: 'ken', surface: 'whatsapp', slug: 'x' }).mint();
    const secretOf = (m) => m.env.find((e) => e.startsWith(`${BEING_TOKEN_ENV}=`)).split('=')[1];
    expect(secretOf(a)).not.toBe(secretOf(b));
    expect(secretOf(a)).toMatch(/^[0-9a-f]{64}$/);
    a.revoke();
    expect(link.identify(authMac(secretOf(a), 'n'), 'n')).toBe(null);
    expect(link.identify(authMac(secretOf(b), 'n'), 'n')).toMatchObject({ being: 'ken' });
    expect(link.size).toBe(1);
  });

  it('the default client path is the copy in the eGPT checkout the pool profiles mount, not the running tree', () => {
    expect(askSpineClientPath('C:\\Users\\op')).toBe(join('C:\\Users\\op', 'src', 'egpt', 'src', 'tools', 'ask-spine.mjs'));
  });

  it('browser start runs the shared launch path once and writes ONE audit line: being, room, action, outcome', async () => {
    const logs = [];
    let starts = 0;
    const link = createBeingLink({ port: 1, startBrowser: async () => { starts++; return { ok: true, launched: true, detail: 'the browser is up on localhost:9221 (pid 42)' }; }, onLog: (m) => logs.push(m), randomBytes: fixedBytes(9) });
    link.forBeing(E_IN_ACIM).mint();
    const r = await link.ask(E_IN_ACIM, parseAskFrame(askFrame({ ask: 'browser', action: 'start' })));
    expect(r).toEqual({ ok: true, launched: true, detail: 'the browser is up on localhost:9221 (pid 42)' });
    expect(starts).toBe(1);
    expect(logs).toEqual(['e (room/acim) asked browser start → launched — the browser is up on localhost:9221 (pid 42)']);
    expect(logs.join('\n')).not.toContain('09'.repeat(32));
  });

  it('PROVEN: a request carrying an executable, flags, a port or a profile is REFUSED, and nothing is launched', async () => {
    const logs = [];
    let starts = 0;
    const link = createBeingLink({ port: 1, startBrowser: async () => { starts++; return { ok: true }; }, onLog: (m) => logs.push(m) });
    for (const extra of [{ executable: 'C:/evil.exe' }, { args: ['--remote-debugging-port=1'] }, { port: 9999 }, { profile: 'C:/Users/an/AppData' }, { url: 'https://x' }]) {
      const r = await link.ask(E_IN_ACIM, parseAskFrame(JSON.stringify({ ask: 'browser', action: 'start', ...extra })));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('bad-request');
      expect(r.detail).toMatch(/takes no arguments/);
    }
    expect(starts).toBe(0);
    expect(logs).toHaveLength(5);
    for (const l of logs) expect(l).toMatch(/^e \(room\/acim\) asked "browser" "start" → REFUSED \(bad-request\)/);
    // the log names the FIELDS a being tried, never what it put in them
    expect(logs.join('\n')).not.toMatch(/evil|9999|AppData|https/);
  });

  it('anything but browser start is refused as unknown — there is no run/exec verb to find', async () => {
    let starts = 0;
    const link = createBeingLink({ port: 1, startBrowser: async () => { starts++; return { ok: true }; } });
    for (const [ask, action] of [['browser', 'stop'], ['exec', 'run'], ['run', 'start'], ['browser', ''], ['constructor', 'start'], ['__proto__', 'start']]) {
      const r = await link.ask(E_IN_ACIM, parseAskFrame(askFrame({ ask, action })));
      expect(r, `${ask} ${action}`).toMatchObject({ ok: false, reason: 'unknown' });
    }
    expect((await link.ask(E_IN_ACIM, null)).reason).toBe('bad-request');
    expect(starts).toBe(0);
  });

  it('a launch path that throws is a launch-failed answer, never an unanswered request', async () => {
    const link = createBeingLink({ port: 1, startBrowser: async () => { throw new Error('spawn EPERM'); } });
    expect(await link.ask(E_IN_ACIM, parseAskFrame(askFrame({ ask: 'browser', action: 'start' })))).toEqual({ ok: false, reason: 'launch-failed', detail: 'spawn EPERM' });
  });
});

// ── 2. THE LIMB ───────────────────────────────────────────────────────────────────────────────
describe('/being on the console port: routed like /peer, never the console seat', () => {
  it('a WRONG secret is refused and logged; the operator\'s editor still takes the seat afterwards', async () => {
    const { server, onBeing, logs, port } = limb();
    const ws = server.dial(BEING_PATH);
    answerChallenge(ws, 'a-secret-nobody-minted');
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'start' })));
    await flush();
    expect(ws.closed).toBe(true);
    expect(ws.sent).toEqual([]);                          // told nothing past the challenge
    expect(onBeing.asked).toEqual([]);
    expect(logs.join('\n')).toMatch(/on \/being answered with a credential this spine did not mint, or has revoked/);
    seatEditor(server);
    expect(port.isConnected).toBe(true);
    port.stop();
  });

  it('a REVOKED secret is refused — the real link, the session closed', async () => {
    let starts = 0;
    const link = createBeingLink({ port: 1, startBrowser: async () => { starts++; return { ok: true, alreadyRunning: true, detail: 'x' }; } });
    const m = link.forBeing(E_IN_ACIM).mint();
    const secret = m.env.find((e) => e.startsWith(`${BEING_TOKEN_ENV}=`)).split('=')[1];
    m.revoke();
    const { server, port } = limb({ onBeing: link });
    const ws = server.dial(BEING_PATH);
    answerChallenge(ws, secret);
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'start' })));
    await flush();
    expect(ws.closed).toBe(true);
    expect(starts).toBe(0);
    port.stop();
  });

  it('the node\'s SHELL TOKEN is not a being credential, and a being secret does not open the console', async () => {
    const { server, onBeing, port } = limb();
    const asBeing = server.dial(BEING_PATH);
    answerChallenge(asBeing, SHELL_TOKEN);
    expect(asBeing.closed).toBe(true);
    const asEditor = server.dial();
    answerChallenge(asEditor, 'being-secret-1');
    expect(asEditor.closed).toBe(true);
    expect(port.isConnected).toBe(false);
    expect(onBeing.asked).toEqual([]);
    port.stop();
  });

  it('a SEATED EDITOR neither blocks a being nor loses the console to it', async () => {
    const { server, onBeing, port } = limb();
    const editor = seatEditor(server);
    const ws = server.dial(BEING_PATH);
    answerChallenge(ws, 'being-secret-1');
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'start' })));
    await flush();
    expect(onBeing.asked).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ ask: 'result', ok: true, alreadyRunning: true, detail: 'already answering' });
    expect(port.isConnected).toBe(true);
    expect(editor.closed).toBe(false);
    expect(editor.sent).toEqual([]);
    port.stop();
  });

  it('nothing a being sends reaches the turn dispatch — a console-shaped line is handed to the link, which refuses it', async () => {
    const link = createBeingLink({ port: 1, startBrowser: async () => ({ ok: true }) });
    const m = link.forBeing(E_IN_ACIM).mint();
    const secret = m.env.find((e) => e.startsWith(`${BEING_TOKEN_ENV}=`)).split('=')[1];
    const { server, turns, port } = limb({ onBeing: link });
    const ws = server.dial(BEING_PATH);
    answerChallenge(ws, secret);
    ws.fire('message', Buffer.from(JSON.stringify({ text: '/upgrade', chatId: 'lobby' })));
    await flush();
    expect(turns).toEqual([]);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ ask: 'result', ok: false, reason: 'bad-request' });
    port.stop();
  });

  it('/peer is unaffected: with no mouth configured it is still refused on the spot, being link or not', () => {
    const { server, logs, port } = limb();
    const peer = server.dial(MOUTH_PATH);
    expect(peer.closed).toBe(true);
    expect(peer.sent).toEqual([]);
    expect(logs.join('\n')).toMatch(/offers no mouth link/);
    port.stop();
  });

  it('a limb handed NO being link closes a /being dial on the spot and tells it nothing', () => {
    const { server, logs, port } = limb({ onBeing: null });
    const ws = server.dial(BEING_PATH);
    expect(ws.closed).toBe(true);
    expect(ws.sent).toEqual([]);
    expect(logs.join('\n')).toMatch(/offers no being link/);
    seatEditor(server);
    expect(port.isConnected).toBe(true);
    port.stop();
  });

  it('stop() closes an authenticated being connection too', () => {
    const { server, port } = limb();
    const ws = server.dial(BEING_PATH);
    answerChallenge(ws, 'being-secret-1');
    expect(ws.closed).toBe(false);
    port.stop();
    expect(ws.closed).toBe(true);
  });
});

// ── 3. THE MINT ───────────────────────────────────────────────────────────────────────────────
describe('the mint: a boxed ccode session is handed its credential, and loses it at close', () => {
  const build = (extra = {}) => {
    const f = launcherSpawn();
    const logs = [];
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: TOKEN, jsonlStoreRoot: STORE, sessionId: 'thread-y', gitBashCandidates: [], onLog: (l) => logs.push(String(l)), ...extra });
    s.turn('hi').catch(() => {});
    return { s, f, logs };
  };

  it('three NAME=VALUE entries join the ONE -SetEnv element, after the existing ones; nothing else in the argv moves', () => {
    const link = createBeingLink({ port: 23475, clientPath: 'C:/x/ask-spine.mjs', startBrowser: async () => ({ ok: true }), randomBytes: fixedBytes(5) });
    const plain = build();
    const withLink = build({ beingLink: link.forBeing(E_IN_ACIM) });
    const secret = '05'.repeat(32);
    expect(setEnvOf(withLink.f.calls[0])).toEqual([
      ...setEnvOf(plain.f.calls[0]),
      `${SPINE_PORT_ENV}=23475`, `${BEING_TOKEN_ENV}=${secret}`, `${ASK_SPINE_ENV}=C:/x/ask-spine.mjs`,
    ]);
    expect(withLink.f.calls[0].filter((a) => a === '-SetEnv')).toHaveLength(1);
    const blank = (args) => args.map((v, i) => (args[i - 1] === '-SetEnv' ? '<setenv>' : v));
    expect(blank(withLink.f.calls[0])).toEqual(blank(plain.f.calls[0]));
    // the value is in the child's environment and NOWHERE the node logs
    for (const l of withLink.logs) expect(l).not.toContain(secret);
    plain.s.close(); withLink.s.close();
  });

  it('REVOKED AT CLOSE: the warm pool closes a session on every eviction, and the secret dies with it', () => {
    const link = createBeingLink({ port: 1, startBrowser: async () => ({ ok: true }), randomBytes: fixedBytes(6) });
    const { s } = build({ beingLink: link.forBeing(E_IN_ACIM) });
    const secret = '06'.repeat(32);
    expect(link.identify(authMac(secret, 'n'), 'n')).toEqual(E_IN_ACIM);
    s.close();
    expect(link.identify(authMac(secret, 'n'), 'n')).toBe(null);
    expect(link.size).toBe(0);
  });

  it('codex and pi mint nothing and keep their argv byte-identical', () => {
    for (const engine of ['codex', 'pi']) {
      let mints = 0;
      const beingLink = { mint: () => { mints++; return { env: ['EGPT_BEING_TOKEN=x'], revoke: () => {} }; } };
      const run = (extra) => {
        const f = launcherSpawn();
        const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', engine, sessionId: 'sess-pinned', ...extra });
        s.turn('hi').catch(() => {});
        s.close();
        return f.calls[0];
      };
      expect(run({ beingLink }), engine).toEqual(run({}));
      expect(mints, engine).toBe(0);
    }
  });

  it('a session REFUSED by an earlier guard mints nothing — no live secret for a process that never ran', () => {
    let mints = 0;
    const beingLink = { mint: () => { mints++; return { env: [], revoke: () => {} }; } };
    expect(() => createSandboxCliSession({ spawn: launcherSpawn().spawn, cwd: process.cwd(), platform: 'win32', jsonlStoreRoot: STORE, beingLink })).toThrow(/NO credential/);
    expect(() => createSandboxCliSession({ spawn: launcherSpawn().spawn, cwd: process.cwd(), platform: 'linux', sandboxOauthToken: TOKEN, beingLink })).toThrow(/platform=linux/);
    expect(mints).toBe(0);
  });
});

// ── 4. THE REQUEST IS /chrome's LAUNCH PATH ───────────────────────────────────────────────────
describe('browser start goes through /chrome\'s own launch path', () => {
  const kg = { node_name: 'kg', whatsapp: { chat_id: '!self' }, chrome: { bin: 'C:/x/chrome.exe', profile_dir: 'C:/x/brain' } };
  function cmdsWith({ cdp, launch }) {
    let t = 0;
    const sent = [];
    const cmds = createCommands({
      getConfig: () => kg, cdp, launchChrome: launch, now: () => t, sleep: async (ms) => { t += ms; },
      send: async (chatId, text) => sent.push(text), brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    });
    return { cmds, sent };
  }
  // Down until the launch seam fires, up on the next probe — a launcher that really worked.
  function browser() {
    const s = { up: false, launched: 0, probes: 0 };
    s.cdp = { isRunning: async () => { s.probes++; return s.up; }, cdpHost: async () => 'localhost:9221', listTabs: async () => [{ title: 'ChatGPT', url: 'https://chatgpt.com/' }] };
    s.launch = async (o) => { s.launched++; s.args = o; await Promise.resolve(); s.up = true; return { ok: true, direct: true, pid: 4242, detail: 'chrome.exe' }; };
    return s;
  }

  it('it hands the launch seam exactly what /chrome hands it — the attach port, config\'s profile and binary', async () => {
    const b = browser();
    const { cmds } = cmdsWith(b);
    expect(await cmds.startBrowser()).toEqual({ ok: true, launched: true, detail: 'the browser is up on localhost:9221 (pid 4242)' });
    expect(b.args).toEqual({ port: '9221', userDataDir: 'C:/x/brain', bin: 'C:/x/chrome.exe' });
  });

  it('IDEMPOTENT: CDP already answering launches nothing and says so', async () => {
    const b = browser();
    b.up = true;
    const { cmds } = cmdsWith(b);
    expect(await cmds.startBrowser()).toEqual({ ok: true, alreadyRunning: true, detail: 'the browser is already answering on localhost:9221 — nothing was launched' });
    expect(b.launched).toBe(0);
  });

  it('TWO CONCURRENT STARTS LAUNCH ONE BROWSER — and a /chrome arriving in the middle joins it too', async () => {
    const b = browser();
    const { cmds, sent } = cmdsWith(b);
    const [one, two] = await Promise.all([cmds.startBrowser(), cmds.startBrowser(), cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/chrome kg' })]);
    expect(b.launched).toBe(1);
    expect(one.ok && two.ok).toBe(true);
    expect(sent[0]).toMatch(/attached: localhost:9221/);
    // ...and once it has settled, the next ask probes afresh and finds it up
    expect(await cmds.startBrowser()).toMatchObject({ ok: true, alreadyRunning: true });
    expect(b.launched).toBe(1);
  });

  it('a direct launch that fails is reported with the launcher\'s own detail', async () => {
    const b = browser();
    const { cmds } = cmdsWith({ cdp: b.cdp, launch: async () => ({ ok: false, direct: true, detail: 'Chrome executable not found in standard locations' }) });
    expect(await cmds.startBrowser()).toEqual({ ok: false, reason: 'launch-failed', detail: 'Chrome executable not found in standard locations' });
  });

  it('a browser that never binds the port says so; the Session 0 task hop names its own remedy', async () => {
    const down = { isRunning: async () => false, cdpHost: async () => 'localhost:9221', listTabs: async () => [] };
    const direct = cmdsWith({ cdp: down, launch: async () => ({ ok: true, direct: true, pid: 7 }) });
    expect((await direct.cmds.startBrowser()).detail).toMatch(/never bound :9221 within 20s/);
    const hop = cmdsWith({ cdp: down, launch: () => ({ ok: false }) });
    expect(await hop.cmds.startBrowser()).toMatchObject({ ok: false, reason: 'launch-failed' });
    expect((await hop.cmds.startBrowser()).detail).toMatch(/register-chrome-task\.ps1/);
  });

  it('ONE launch path: /chrome and startBrowser both go through ensureChrome, and launchChrome is called in one place', () => {
    const src = readFileSync(join(REPO, 'src', 'spine', 'commands.mjs'), 'utf8');
    expect(src.match(/await launchChrome\(/g)).toHaveLength(1);
    const report = src.slice(src.indexOf('async function chromeReport()'), src.indexOf('function waitForChromeUp'));
    const start = src.slice(src.indexOf('async function startBrowser()'), src.indexOf('async function chromeReport()'));
    expect(report).toMatch(/await ensureChrome\(\)/);
    expect(start).toMatch(/await ensureChrome\(\)/);
  });
});

// ── 5. THE CLIENT, END TO END ─────────────────────────────────────────────────────────────────
// A REAL limb on a real ephemeral loopback port, the real link, and the client over a real socket —
// in-process, and once as the script a being actually runs.
describe('ask-spine: the client a boxed being runs, against a real in-process spine', () => {
  async function spine(startBrowser) {
    const logs = [];
    const link = createBeingLink({ port: 0, startBrowser, onLog: (m) => logs.push(m) });
    const port = createShellPort({ port: 0, token: SHELL_TOKEN, reapPort: () => 0, onBeing: link, onLog: () => {} });
    const wss = port.start();
    await new Promise((r) => wss.once('listening', r));
    const live = wss.address().port;
    // The env a boxed session is handed, with the port the limb actually bound.
    const envFor = (who = E_IN_ACIM) => {
      const m = link.forBeing(who).mint();
      const env = Object.fromEntries(m.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
      env[SPINE_PORT_ENV] = String(live);
      return { env, revoke: m.revoke };
    };
    return { port, link, logs, envFor, live };
  }

  it('started: exit 0, one line; the being is named in the audit line', async () => {
    const { port, envFor, logs } = await spine(async () => ({ ok: true, launched: true, detail: 'the browser is up on localhost:9221 (pid 42)' }));
    const r = await askSpine({ argv: ['browser', 'start'], env: envFor().env });
    expect(r).toEqual({ code: 0, line: 'ask-spine: browser start — started: the browser is up on localhost:9221 (pid 42)' });
    expect(logs).toEqual(['e (room/acim) asked browser start → launched — the browser is up on localhost:9221 (pid 42)']);
    port.stop();
  });

  it('already running: exit 0', async () => {
    const { port, envFor } = await spine(async () => ({ ok: true, alreadyRunning: true, detail: 'already answering' }));
    expect(await askSpine({ argv: ['browser', 'start'], env: envFor().env })).toEqual({ code: 0, line: 'ask-spine: browser start — already running: already answering' });
    port.stop();
  });

  it('launch failed: exit 1 with the spine\'s detail', async () => {
    const { port, envFor } = await spine(async () => ({ ok: false, reason: 'launch-failed', detail: 'Chrome executable not found' }));
    expect(await askSpine({ argv: ['browser', 'start'], env: envFor().env })).toEqual({ code: 1, line: 'ask-spine: browser start FAILED — Chrome executable not found' });
    port.stop();
  });

  it('revoked (its session closed): exit 1, REFUSED, and the launch path never ran', async () => {
    let starts = 0;
    const { port, envFor } = await spine(async () => { starts++; return { ok: true }; });
    const { env, revoke } = envFor();
    revoke();
    const r = await askSpine({ argv: ['browser', 'start'], env });
    expect(r.code).toBe(1);
    expect(r.line).toMatch(/^ask-spine: REFUSED — the spine on 127\.0\.0\.1:\d+ closed the connection without an answer/);
    expect(starts).toBe(0);
    port.stop();
  });

  it('not a boxed session: exit 1 without dialling anything', async () => {
    let dialled = 0;
    class NeverDial { constructor() { dialled++; } }
    const r = await askSpine({ argv: ['browser', 'start'], env: {}, WebSocket: NeverDial });
    expect(r.code).toBe(1);
    expect(r.line).toMatch(/not a boxed session/);
    expect(dialled).toBe(0);
  });

  it('spine unreachable: exit 1, naming where it looked', async () => {
    const dead = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    const r = await askSpine({ argv: ['browser', 'start'], env: { [BEING_TOKEN_ENV]: 'x', [SPINE_PORT_ENV]: String(dead) } });
    expect(r.code).toBe(1);
    expect(r.line).toMatch(new RegExp(`^ask-spine: spine unreachable on 127\\.0\\.0\\.1:${dead}`));
  });

  it('anything but `browser start` is refused before a dial — there is nothing else to ask for', async () => {
    let dialled = 0;
    class NeverDial { constructor() { dialled++; } }
    for (const argv of [[], ['browser'], ['browser', 'stop'], ['browser', 'start', '--profile', 'x'], ['exec', 'calc.exe']]) {
      const r = await askSpine({ argv, env: { [BEING_TOKEN_ENV]: 'x', [SPINE_PORT_ENV]: '1' }, WebSocket: NeverDial });
      expect(r.code).toBe(1);
      expect(r.line).toMatch(/usage: node "\$EGPT_ASK_SPINE" browser start/);
    }
    expect(dialled).toBe(0);
  });

  it('AS THE SCRIPT A BEING RUNS: `node ask-spine.mjs browser start` prints one line and exits 0', async () => {
    const { port, envFor } = await spine(async () => ({ ok: true, alreadyRunning: true, detail: 'already answering' }));
    const { env } = envFor();
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLIENT, 'browser', 'start'], { env: { ...process.env, ...env }, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(out).toEqual({ code: 0, stdout: 'ask-spine: browser start — already running: already answering\n', stderr: '' });
    port.stop();
  });
});

// ── 6. BOOT HANDS ONE LINK TO BOTH ENDS ───────────────────────────────────────────────────────
// Running boot for real would bind a real console; the wiring is locked at the source, the way
// tests/spine-commands.test.mjs locks the launcher choice.
describe('boot wires ONE being link into the brain and the console limb', () => {
  const BOOT_SRC = readFileSync(join(REPO, 'src', 'spine', 'boot.mjs'), 'utf8');
  it('one createBeingLink, handed to createShellPort as onBeing and to createBrainPool as beingLink', () => {
    expect(BOOT_SRC.match(/createBeingLink\(/g)).toHaveLength(1);
    expect(BOOT_SRC).toMatch(/onBeing: beingLink,/);
    expect(BOOT_SRC).toMatch(/createBrainPool\(\{[^\n]*\bbeingLink\b/);
    expect(BOOT_SRC).toMatch(/startBrowser: \(\) => commands\.startBrowser\(\)/);
    expect(BOOT_SRC).toMatch(/port: shellPortFrom\(cfg\),\s*startBrowser/);
  });
});
