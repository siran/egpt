// tests/being-cdp.test.mjs — chunk B of the named browser groups (plans/2610091931 rev 2026-10-11):
// a being's raw CDP reaches ONLY its own chat's group Chrome, through the spine, over the /being
// link. Fake Chromes on fake pipes; no real Chrome anywhere.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, basename, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, linkSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createPipeChannel, createCdpMux, cdpWire } from '../src/tools/cdp.mjs';
import { withInsert } from '../migrations/0038-being-scripts-reach-chrome-through-the-spine.mjs';
import { createBeingLink } from '../src/spine/being-link.mjs';
import { browserUploadsOn } from '../src/rooms-file.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { responseFrame, authMac, macMatches } from '../src/shell/auth.mjs';
import { BEING_PATH, askFrame, SPINE_PORT_ENV, BEING_TOKEN_ENV, CDP_MODULE_ENV } from '../src/shell/being.mjs';
import { slugDir } from '../src/conversations-state.mjs';
import { createConfigResolver } from '../src/spine/config-resolver.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { createSandboxCliSession, spawnBoxedCommand } from '../src/sandbox-cli-session.mjs';

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 2)); }
};
const tick = () => new Promise((r) => setTimeout(r, 20));

const TARGETS = [
  { targetId: 'T-page', type: 'page', url: 'https://mail.google.com/', title: 'Inbox' },
  { targetId: 'T-ext', type: 'service_worker', url: 'chrome-extension://vault/bg.js', title: 'vault' },
];

// A scripted Chrome on the far end of a --remote-debugging-pipe: \0-framed JSON both ways.
function fakeChrome(name = 'chrome', { silent = [] } = {}) {
  const toChrome = new PassThrough();
  const toClient = new PassThrough();
  const seen = [];
  let n = 0, buf = '';
  const push = (o) => toClient.write(JSON.stringify(o) + '\0');
  toChrome.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) !== -1) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push(m);
      if (silent.includes(m.method)) continue;   // a Chrome that never answers this method
      const reply = (result) => push({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      switch (m.method) {
        case 'Target.attachToBrowserTarget': reply({ sessionId: `${name}-B${++n}` }); break;
        case 'Target.setDiscoverTargets': for (const t of TARGETS) push({ method: 'Target.targetCreated', sessionId: m.sessionId, params: { targetInfo: t } }); reply({}); break;
        case 'Target.attachToTarget': reply({ sessionId: `${name}-P${++n}` }); break;
        case 'Target.getTargets': reply({ targetInfos: TARGETS }); break;
        case 'Browser.getVersion': reply({ product: 'Chrome/140', protocolVersion: '1.3', userAgent: 'UA', jsVersion: '14' }); break;
        case 'Runtime.evaluate': reply({ result: { value: m.params.expression } }); break;
        default: reply({});
      }
    }
  });
  const channel = createPipeChannel({ writable: toChrome, readable: toClient });
  const of = (method) => seen.filter((m) => m.method === method);
  return { name, channel, seen, of, push, toChrome, client: { channel: async () => channel } };
}

const sink = () => {
  const out = [];
  return { out, ended: false, send(t) { out.push(JSON.parse(t)); }, end() { this.ended = true; } };
};
const cmd = (id, method, params = {}, extra = {}) => JSON.stringify({ id, method, params, ...extra });

const ADMIN = { being: 'e', surface: 'whatsapp', slug: 'eGPT Admin-2609121344', boxed: true };
const DIEGO = { being: 'e', surface: 'whatsapp', slug: 'Diego Perez-2606301826', boxed: true };
const GROUPS = { brain: ['eGPT Admin', 'eGPT Rodz Lulu An'] };
const CDP = { ask: 'browser', action: 'cdp', extra: [] };

function linkWith(chromes, extra = {}) {
  const asked = [];
  const started = [];
  const logs = [];
  const link = createBeingLink({
    port: 23475, clientPath: 'C:/x/ask-spine.mjs', onLog: (m) => logs.push(m),
    startBrowser: async (c) => { started.push(c); return { ok: true, alreadyRunning: true, detail: 'up' }; },
    chromeClientFor: async (c) => { asked.push(c); return { client: chromes[c.group]?.client ?? null }; },
    readGroups: async () => GROUPS,
    ...extra,
  });
  return { link, asked, started, logs };
}

// ── 1. THE MUX: many clients on one group connection ────────────────────────────────────────
describe('mux — each client its own browser-target session, and only its own sessions', () => {
  it('a message with no sessionId is stamped with the client\'s session; the answer comes back unstamped, with the client\'s id', async () => {
    const chrome = fakeChrome();
    const mux = createCdpMux(chrome.channel);
    const s = sink();
    const t = await mux.attach(s);
    t.send(cmd(1, 'Target.getTargets'));
    await until(() => s.out.length === 1);
    const sent = chrome.of('Target.getTargets')[0];
    expect(sent.sessionId).toMatch(/^chrome-B\d+$/);
    expect(sent.id).not.toBe(1);                       // remapped into the connection's id space
    expect(s.out[0]).toEqual({ id: 1, result: { targetInfos: TARGETS } });
  });

  it('two clients on one group cannot use each other\'s sessions, and the same ids do not collide', async () => {
    const chrome = fakeChrome();
    const mux = createCdpMux(chrome.channel);
    const a = sink(), b = sink();
    const ta = await mux.attach(a);
    const tb = await mux.attach(b);
    ta.send(cmd(1, 'Target.attachToTarget', { targetId: 'T-page', flatten: true }));
    await until(() => a.out.length === 1);
    const pa = a.out[0].result.sessionId;
    // B tries A's page session, and A's (unseen) root session too: refused, Chrome never sees either
    tb.send(cmd(1, 'Runtime.evaluate', { expression: 'steal' }, { sessionId: pa }));
    const rootA = chrome.of('Target.attachToTarget')[0].sessionId;
    tb.send(cmd(2, 'Runtime.evaluate', { expression: 'steal2' }, { sessionId: rootA }));
    await until(() => b.out.length === 2);
    expect(b.out.map((m) => m.error?.message)).toEqual([expect.stringMatching(/not this client's/), expect.stringMatching(/not this client's/)]);
    expect(chrome.of('Runtime.evaluate')).toEqual([]);
    // A uses its own; B uses id 1 at the same time — each gets its own answer
    ta.send(cmd(2, 'Runtime.evaluate', { expression: 'mine' }, { sessionId: pa }));
    tb.send(cmd(3, 'Target.getTargets'));
    await until(() => a.out.length === 2 && b.out.length === 3);
    expect(a.out[1]).toEqual({ id: 2, sessionId: pa, result: { result: { value: 'mine' } } });
    expect(b.out[2].id).toBe(3);
  });

  it('events reach only the client owning their session; auto-attached sessions join their owner', async () => {
    const chrome = fakeChrome();
    const mux = createCdpMux(chrome.channel);
    const a = sink(), b = sink();
    await mux.attach(a);
    await mux.attach(b);
    const [, rootA, rootB] = chrome.of('Target.attachToBrowserTarget').map((_, i) => `chrome-B${i + 1}`);   // [mux's own, a, b]
    chrome.push({ method: 'Target.attachedToTarget', sessionId: rootA, params: { sessionId: 'AUTO', targetInfo: TARGETS[0] } });
    chrome.push({ method: 'Page.loadEventFired', sessionId: 'AUTO', params: {} });
    await until(() => a.out.length === 2);
    await tick();
    expect(a.out.map((m) => m.method)).toEqual(['Target.attachedToTarget', 'Page.loadEventFired']);
    expect(a.out[0].sessionId).toBeUndefined();          // the root stamp is stripped
    expect(b.out).toEqual([]);
    expect(rootB).toBeDefined();
  });

  it('a closed tunnel detaches every session it held', async () => {
    const chrome = fakeChrome();
    const mux = createCdpMux(chrome.channel);
    const a = sink();
    const t = await mux.attach(a);
    t.send(cmd(1, 'Target.attachToTarget', { targetId: 'T-page', flatten: true }));
    await until(() => a.out.length === 1);
    const page = a.out[0].result.sessionId;
    const root = chrome.of('Target.attachToTarget')[0].sessionId;
    t.close();
    await until(() => chrome.of('Target.detachFromTarget').length === 2);
    expect(chrome.of('Target.detachFromTarget').map((m) => m.params.sessionId).sort()).toEqual([page, root].sort());
    expect(a.ended).toBe(true);
    t.send(cmd(2, 'Target.getTargets'));
    await tick();
    expect(chrome.of('Target.getTargets')).toEqual([]);
  });

  it('a frame that is not a CDP command is refused, never forwarded', async () => {
    const chrome = fakeChrome();
    const a = sink();
    const t = await createCdpMux(chrome.channel).attach(a);
    t.send('not json');
    t.send(JSON.stringify({ method: 'Runtime.evaluate' }));   // no id
    await until(() => a.out.length === 2);
    for (const m of a.out) expect(m.error.message).toMatch(/refused by eGPT/);
  });
});

// ── 2. THE LINK: who → conversation → group → that group's Chrome ───────────────────────────
describe('being link — `browser cdp` resolves the group at ask time', () => {
  it('a being in eGPT Admin tunnels to brain\'s Chrome; one in an unlisted chat to shared\'s; never the other', async () => {
    const brain = fakeChrome('brain'), shared = fakeChrome('shared');
    const { link, asked } = linkWith({ brain, shared });
    for (const [who, mine, other] of [[ADMIN, brain, shared], [DIEGO, shared, brain]]) {
      const before = other.seen.length;
      const s = sink();
      const r = await link.ask(who, CDP, s);
      expect(r).toMatchObject({ ok: true, detail: `group ${mine.name}` });
      r.tunnel.send(cmd(9, 'Runtime.evaluate', { expression: who.slug }));
      await until(() => s.out.length === 1);
      expect(mine.of('Runtime.evaluate').at(-1).params.expression).toBe(who.slug);
      expect(other.seen.length).toBe(before);
    }
    expect(asked.map((c) => c.group)).toEqual(['brain', 'shared']);
    expect(asked[0]).toEqual({ key: ADMIN.slug, name: 'eGPT Admin', group: 'brain' });
  });

  it('a chat with no group (listed twice) is refused, and no Chrome is asked for', async () => {
    const { link, asked } = linkWith({}, { readGroups: async () => ({ brain: ['eGPT Admin'], work: ['eGPT Admin'] }) });
    const r = await link.ask(ADMIN, CDP, sink());
    expect(r).toMatchObject({ ok: false, reason: 'no-browser' });
    expect(r.detail).toMatch(/listed in browser groups brain, work/);
    expect(r.tunnel).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('`browser start` goes through the same resolution and hands startBrowser the conversation', async () => {
    const { link, started } = linkWith({});
    await link.ask(DIEGO, { ask: 'browser', action: 'start', extra: [] });
    expect(started).toEqual([{ key: DIEGO.slug, name: 'Diego Perez', group: 'shared' }]);
    const none = linkWith({}, { readGroups: async () => ({ a: ['Diego Perez'], b: ['Diego Perez'] }) });
    expect(await none.link.ask(DIEGO, { ask: 'browser', action: 'start', extra: [] })).toMatchObject({ ok: false, reason: 'no-browser' });
    expect(none.started).toEqual([]);
  });

  it('`browser cdp` takes no arguments either', async () => {
    const { link, asked } = linkWith({ shared: fakeChrome() });
    const r = await link.ask(DIEGO, { ask: 'browser', action: 'cdp', extra: ['group'] }, sink());
    expect(r).toMatchObject({ ok: false, reason: 'bad-request' });
    expect(asked).toEqual([]);
  });

  it('the mint hands every session EGPT_CDP — the file URL of being-cdp.mjs beside the ask-spine client', () => {
    const { link } = linkWith({});
    const { env } = link.forBeing(DIEGO).mint();
    expect(env).toContain(`${CDP_MODULE_ENV}=file:///C:/x/being-cdp.mjs`);
  });

  it('revoking a session closes the tunnels it opened', async () => {
    const shared = fakeChrome();
    const { link } = linkWith({ shared });
    const m = link.forBeing(DIEGO).mint();
    const secret = m.env.find((e) => e.startsWith(`${BEING_TOKEN_ENV}=`)).split('=')[1];
    const who = link.identify(authMac(secret, 'n'), 'n');
    const s = sink();
    await link.ask(who, CDP, s);
    m.revoke();
    expect(s.ended).toBe(true);
    await until(() => chromeDetached(shared));
  });
});
const chromeDetached = (c) => c.of('Target.detachFromTarget').length >= 1;

// ── 3. THE REFUSALS: boxed beings only ──────────────────────────────────────────────────────
describe('refusals — blocked for a BOXED being, served to an UNBOXED one', () => {
  const inside = join(slugDir('whatsapp', DIEGO.slug), 'downloads');
  const CASES = [
    ['Page.navigate file:', 'Page.navigate', { url: 'file:///C:/Users/an/.ssh/id_rsa' }],
    ['Page.navigate file: with a tab inside the scheme', 'Page.navigate', { url: 'fi\tle:///C:/Users/an/' }],
    ['Page.navigate view-source:file:', 'Page.navigate', { url: 'view-source:file:///C:/' }],
    ['Page.navigate devtools:', 'Page.navigate', { url: 'devtools://devtools/bundled/inspector.html' }],
    ['Target.createTarget chrome:', 'Target.createTarget', { url: 'chrome://settings/passwords' }],
    ['Target.createTarget chrome-extension:', 'Target.createTarget', { url: 'chrome-extension://vault/popup.html' }],
    ['Network.loadNetworkResource file:', 'Network.loadNetworkResource', { url: 'file:///C:/Users/an/x', frameId: 'F', options: { disableCache: true, includeCredentials: false } }],
    ['Fetch.continueRequest rewritten to file:', 'Fetch.continueRequest', { requestId: 'r', url: 'file:///C:/x' }],
    ['DOMStorage on an extension origin', 'DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'chrome-extension://vault', isLocalStorage: true } }],
    ['DOM.setFileInputFiles', 'DOM.setFileInputFiles', { files: ['C:/Users/an/secret.txt'], nodeId: 1 }],
    ['Page.handleFileChooser', 'Page.handleFileChooser', { action: 'accept', files: ['C:/Users/an/secret.txt'] }],
    ['Input.dispatchDragEvent with files', 'Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files: ['C:/Users/an/x'], dragOperationsMask: 1 } }],
    ['Browser.setDownloadBehavior outside the conversation', 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:/Users/an/Documents' }],
    ['Page.setDownloadBehavior outside the conversation', 'Page.setDownloadBehavior', { behavior: 'allow', downloadPath: join(inside, '..', '..', 'Other-2601010101') }],
    ['Browser.setDownloadBehavior to the default dir', 'Browser.setDownloadBehavior', { behavior: 'allowAndName' }],
    ['Extensions.loadUnpacked', 'Extensions.loadUnpacked', { path: 'C:/x' }],
    ['Extensions.getStorageItems', 'Extensions.getStorageItems', { id: 'vault', storageArea: 'local' }],
    ['Target.exposeDevToolsProtocol', 'Target.exposeDevToolsProtocol', { targetId: 'T-page' }],
    ['Target.openDevTools', 'Target.openDevTools', { targetId: 'T-page' }],
    ['Target.sendMessageToTarget', 'Target.sendMessageToTarget', { message: '{"id":1,"method":"Page.navigate","params":{"url":"file:///C:/"}}' }],
    ['Browser.close', 'Browser.close', {}],
    ['Browser.crash', 'Browser.crash', {}],
    ['PWA.launchFilesInApp', 'PWA.launchFilesInApp', { manifestId: 'm', files: ['C:/Users/an/x'] }],
    ['PWA.install', 'PWA.install', { manifestId: 'm', installUrlOrBundleUrl: 'https://x/app.swbn' }],
  ];

  async function tunnelFor(boxed) {
    const shared = fakeChrome();
    const { link, logs } = linkWith({ shared });
    const s = sink();
    const r = await link.ask({ ...DIEGO, boxed }, CDP, s);
    return { shared, s, t: r.tunnel, logs };
  }

  for (const [label, method, params] of CASES) {
    it(label, async () => {
      const boxed = await tunnelFor(true);
      boxed.t.send(cmd(5, method, params));
      await until(() => boxed.s.out.length === 1);
      expect(boxed.s.out[0]).toMatchObject({ id: 5, error: { message: expect.stringMatching(/^refused by eGPT: /) } });
      expect(boxed.shared.of(method)).toEqual([]);
      expect(boxed.logs.join('\n')).toContain(`cdp "${method}" → REFUSED`);

      const unboxed = await tunnelFor(false);
      unboxed.t.send(cmd(5, method, params));
      await until(() => unboxed.s.out.length === 1);
      expect(unboxed.s.out[0].error).toBeUndefined();
      expect(unboxed.shared.of(method)).toHaveLength(1);
    });
  }

  it('applies to messages carrying a sessionId too — a page session cannot navigate to file:', async () => {
    const { s, t, shared } = await tunnelFor(true);
    t.send(cmd(1, 'Target.attachToTarget', { targetId: 'T-page', flatten: true }));
    await until(() => s.out.length === 1);
    t.send(cmd(2, 'Page.navigate', { url: 'file:///C:/' }, { sessionId: s.out[0].result.sessionId }));
    await until(() => s.out.length === 2);
    expect(s.out[1].error.message).toMatch(/refused by eGPT/);
    expect(shared.of('Page.navigate')).toEqual([]);
  });

  it('a session on a chrome-extension: target serves a boxed being nothing (attaching itself is harmless)', async () => {
    for (const boxed of [true, false]) {
      const { s, t, shared } = await tunnelFor(boxed);
      t.send(cmd(1, 'Target.attachToTarget', { targetId: 'T-ext', flatten: true }));
      await until(() => s.out.length === 1);
      t.send(cmd(2, 'Runtime.evaluate', { expression: 'vault.unlock()' }, { sessionId: s.out[0].result.sessionId }));
      await until(() => s.out.length === 2);
      expect(!!s.out[1].error, `boxed=${boxed}`).toBe(boxed);
      expect(shared.of('Runtime.evaluate')).toHaveLength(boxed ? 0 : 1);
    }
  });

  it('what a boxed being still gets: https navigation, and downloads into its own conversation folder', async () => {
    const { s, t, shared } = await tunnelFor(true);
    t.send(cmd(1, 'Page.navigate', { url: 'https://example.com/' }));
    t.send(cmd(2, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: inside }));
    t.send(cmd(3, 'Browser.setDownloadBehavior', { behavior: 'deny' }));
    t.send(cmd(4, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', text: 'v' }));
    await until(() => s.out.length === 4);
    expect(s.out.filter((m) => m.error)).toEqual([]);
    expect(shared.of('Browser.setDownloadBehavior')).toHaveLength(2);
  });

  // operator 2026-10-11: "it is safe to enable paste … beings use paste to talk to chatgpt"
  it('a boxed being may paste: paste keys, the paste command, and clipboard permission grants reach Chrome', async () => {
    const { s, t, shared } = await tunnelFor(true);
    t.send(cmd(1, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 }));
    t.send(cmd(2, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'v', code: 'KeyV' }));
    t.send(cmd(3, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 }));
    t.send(cmd(4, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', commands: ['paste'] }));
    t.send(cmd(5, 'Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }));
    t.send(cmd(6, 'Browser.setPermission', { permission: { name: 'clipboard-read' }, setting: 'granted' }));
    await until(() => s.out.length === 6);
    expect(s.out.filter((m) => m.error)).toEqual([]);
    expect(shared.of('Input.dispatchKeyEvent')).toHaveLength(4);
    expect(shared.of('Browser.grantPermissions')).toHaveLength(1);
    expect(shared.of('Browser.setPermission')).toHaveLength(1);
  });
});

// ── 3b. UPLOADS: on for every browser group unless browsers.yaml sets it false; only from the conversation's own folder ──
describe('uploads — a boxed being attaches files from its own folder unless its browser group is set false', () => {
  const UP = { being: 'e', surface: 'whatsapp', slug: `Uploads Test-${process.pid}`, boxed: true };
  const conv = slugDir('whatsapp', UP.slug);
  const photo = join(conv, 'media', '20261017-132858-an-image-33369.jpg');
  const IN_WORK = { work: [UP.slug] };   // GROUPS leaves UP in no group → shared
  let outside, secret, stage, browsersYaml;
  beforeAll(() => {
    mkdirSync(join(conv, 'media'), { recursive: true });
    writeFileSync(photo, 'jpeg bytes');
    outside = mkdtempSync(join(tmpdir(), 'egpt-up-outside-'));
    secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'operator secret');
    symlinkSync(outside, join(conv, 'jx'), 'junction');
    linkSync(secret, join(conv, 'media', 'hard.txt'));
    stage = mkdtempSync(join(tmpdir(), 'egpt-up-stage-'));
    browsersYaml = join(outside, 'browsers.yaml');
  });
  afterAll(() => {
    for (const l of ['jx', 'ln.txt']) try { unlinkSync(join(conv, l)); } catch { /* absent */ }
    for (const d of [conv, outside, stage]) rmSync(d, { recursive: true, force: true });
  });

  async function tunnel({ groups = GROUPS, yaml = '', flags = {} } = {}) {
    writeFileSync(browsersYaml, yaml);
    const chromes = { shared: fakeChrome('shared'), work: fakeChrome('work') };
    const { link, logs } = linkWith(chromes, {
      readGroups: async () => groups,
      resolveConfig: (dir) => (dir === conv ? flags : {}),
      uploadsOn: (g) => browserUploadsOn(g, { path: browsersYaml }),
      uploadStage: stage,
    });
    const s = sink();
    const r = await link.ask(UP, CDP, s);
    return { chrome: chromes[r.detail.replace('group ', '')], group: r.detail, s, t: r.tunnel, logs };
  }
  const send = async ({ s, t }, method, params) => {
    const n = s.out.length;
    t.send(cmd(n + 1, method, params));
    await until(() => s.out.length === n + 1);
    return s.out[n];
  };
  const UPLOADERS = [
    ['DOM.setFileInputFiles', (files) => ({ files, backendNodeId: 7 }), (m) => m.params.files],
    ['Page.handleFileChooser', (files) => ({ action: 'accept', files }), (m) => m.params.files],
    ['Input.dispatchDragEvent', (files) => ({ type: 'drop', x: 1, y: 1, data: { items: [], files, dragOperationsMask: 1 } }), (m) => m.params.data.files],
  ];
  const inStage = (p) => { const r = relative(stage, p); return !!r && !r.startsWith('..') && !isAbsolute(r); };

  for (const [method, paramsOf, filesOf] of UPLOADERS) {
    it(`${method}: with no setting, a file in media/ reaches Chrome as a checked copy — in shared and in a named group`, async () => {
      for (const [groups, group] of [[GROUPS, 'group shared'], [IN_WORK, 'group work']]) {
        const c = await tunnel({ groups });
        expect(c.group).toBe(group);
        expect((await send(c, method, paramsOf([photo]))).error).toBeUndefined();
        const [got] = filesOf(c.chrome.of(method)[0]);
        expect(inStage(got)).toBe(true);
        expect(basename(got)).toBe(basename(photo));
        expect(readFileSync(got, 'utf8')).toBe('jpeg bytes');
      }
    });

    it(`${method}: a group set to false (or to anything but true) refuses it as before`, async () => {
      for (const [groups, yaml] of [[GROUPS, 'uploads:\n  shared: false\n'], [IN_WORK, 'uploads:\n  work: false\n'], [IN_WORK, 'uploads:\n  work: "yes"\n']]) {
        const c = await tunnel({ groups, yaml });
        expect((await send(c, method, paramsOf([photo]))).error.message).toMatch(/^refused by eGPT: .*is not served to a boxed being$/);
        expect(c.chrome.of(method)).toEqual([]);
      }
    });

    it(`${method}: a file outside the folder or behind a junction is refused`, async () => {
      const c = await tunnel();
      for (const f of [secret, join(conv, 'jx', 'secret.txt')]) {
        expect((await send(c, method, paramsOf([f]))).error.message).toMatch(/^refused by eGPT: uploads may come only from this conversation's folder/);
      }
      expect(c.chrome.of(method)).toEqual([]);
      expect(c.logs.join('\n')).toContain(`cdp "${method}" → REFUSED`);
    });
  }

  const ESCAPES = () => [
    ['a hardlink inside the folder to an outside file', [join(conv, 'media', 'hard.txt')]],
    ['.. that climbs out', [`${conv}\\..\\Other-2601010101\\x.jpg`]],
    ['.. even when it lands back inside', [`${conv}\\media\\..\\media\\${basename(photo)}`]],
    ['a UNC path to the same file', [`\\\\localhost\\${conv[0]}$${photo.slice(2)}`]],
    ['a \\\\?\\ device path', [`\\\\?\\${photo}`]],
    ['a \\\\.\\ device path', [`\\\\.\\${photo}`]],
    ['an alternate data stream', [`${photo}:hidden`]],
    ['the ::$DATA stream', [`${photo}::$DATA`]],
    ['a file that does not exist', [join(conv, 'media', 'nope.jpg')]],
    ['a directory', [join(conv, 'media')]],
    ['a relative path', ['media/x.jpg']],
    ['a non-string', [42]],
    ['one good file beside one bad one', [photo, secret]],
  ];
  it('uploads on (by default or set true), every escape is refused and nothing reaches Chrome', async () => {
    for (const yaml of ['', 'uploads:\n  shared: true\n']) {
      const c = await tunnel({ yaml });
      for (const [label, files] of ESCAPES()) {
        const r = await send(c, 'DOM.setFileInputFiles', { files, backendNodeId: 7 });
        expect(r.error?.message, label).toMatch(/^refused by eGPT: uploads may come only from this conversation's folder/);
      }
      expect(c.chrome.of('DOM.setFileInputFiles')).toEqual([]);
    }
  });

  it('a file symlink inside the folder pointing outside is refused', async (ctx) => {
    try { symlinkSync(secret, join(conv, 'ln.txt'), 'file'); } catch (e) { if (e.code === 'EPERM') return ctx.skip(); throw e; }
    const c = await tunnel();
    expect((await send(c, 'DOM.setFileInputFiles', { files: [join(conv, 'ln.txt')] })).error.message).toMatch(/uploads may come only/);
    expect(c.chrome.of('DOM.setFileInputFiles')).toEqual([]);
  });

  it('browsers.yaml is read per upload: an edit applies to the next upload on an open tunnel', async () => {
    const c = await tunnel();
    expect((await send(c, 'DOM.setFileInputFiles', { files: [photo] })).error).toBeUndefined();
    writeFileSync(browsersYaml, 'uploads:\n  shared: false\n');
    expect((await send(c, 'DOM.setFileInputFiles', { files: [photo] })).error.message).toMatch(/is not served to a boxed being/);
    writeFileSync(browsersYaml, 'uploads:\n  work: false\n');
    expect((await send(c, 'DOM.setFileInputFiles', { files: [photo] })).error).toBeUndefined();
    expect(c.chrome.of('DOM.setFileInputFiles')).toHaveLength(2);
  });

  it('another group set false does not touch this one', async () => {
    const c = await tunnel({ yaml: 'uploads:\n  work: false\n  brain: false\n' });
    expect(c.group).toBe('group shared');
    expect((await send(c, 'DOM.setFileInputFiles', { files: [photo] })).error).toBeUndefined();
  });

  it('a conversation-level browser_uploads key is ignored: the group decides', async () => {
    const on = await tunnel({ flags: { browser_uploads: false } });
    expect((await send(on, 'DOM.setFileInputFiles', { files: [photo] })).error).toBeUndefined();
    const off = await tunnel({ flags: { browser_uploads: true }, yaml: 'uploads:\n  shared: false\n' });
    expect((await send(off, 'DOM.setFileInputFiles', { files: [photo] })).error.message).toMatch(/is not served to a boxed being/);
  });

  it('Page.setInterceptFileChooserDialog (no paths) reaches Chrome, uploads on or off', async () => {
    for (const yaml of ['', 'uploads:\n  shared: false\n']) {
      const c = await tunnel({ yaml });
      expect((await send(c, 'Page.setInterceptFileChooserDialog', { enabled: true })).error).toBeUndefined();
      expect(c.chrome.of('Page.setInterceptFileChooserDialog')).toHaveLength(1);
    }
  });

  it('downloads behave as before: into the folder served, elsewhere refused', async () => {
    const c = await tunnel();
    expect((await send(c, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(conv, 'downloads') })).error).toBeUndefined();
    expect((await send(c, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outside })).error.message).toMatch(/downloads may go only/);
    expect(c.chrome.of('Browser.setDownloadBehavior')).toHaveLength(1);
  });
});

// ── 3c. PRIVILEGED: privileged_browser: true serves a boxed being the unboxed CDP ────────────
describe('privileged_browser — that conversation\'s boxed being is not filtered; no other is', () => {
  const RODZ = { being: 'e', surface: 'whatsapp', slug: 'eGPT Rodz Lulu An-2610170000', boxed: true };
  const rodzDir = slugDir('whatsapp', RODZ.slug);
  async function brainPair() {
    const brain = fakeChrome('brain');
    const { link, logs } = linkWith({ brain }, { resolveConfig: (dir) => (dir === rodzDir ? { privileged_browser: true } : {}), uploadsOn: (g) => g !== 'brain' });
    const open = async (who) => { const s = sink(); const r = await link.ask(who, CDP, s); expect(r.detail).toBe('group brain'); return { s, t: r.tunnel }; };
    return { brain, logs, rodz: await open(RODZ), admin: await open(ADMIN) };
  }
  const TRY = [
    [1, 'Page.navigate', { url: 'file:///C:/Users/an/.ssh/id_rsa' }],
    [2, 'DOM.setFileInputFiles', { files: ['C:/Users/an/secret.txt'], backendNodeId: 7 }],
    [3, 'Target.openDevTools', { targetId: 'T-page' }],
  ];

  it('file: navigation, an upload from anywhere (privileged wins over uploads: false on its group) and NOT_SERVED methods reach Chrome; the open is logged', async () => {
    const { brain, logs, rodz } = await brainPair();
    for (const [id, method, params] of TRY) rodz.t.send(cmd(id, method, params));
    await until(() => rodz.s.out.length === TRY.length);
    expect(rodz.s.out.filter((m) => m.error)).toEqual([]);
    expect(brain.of('DOM.setFileInputFiles')[0].params.files).toEqual(['C:/Users/an/secret.txt']);
    expect(logs.filter((l) => l.includes('privileged browser — no CDP filter'))).toEqual([`e (whatsapp/${RODZ.slug}) privileged browser — no CDP filter`]);
  });

  it('the flag on another conversation in the SAME browser group does not reach this one', async () => {
    const { brain, admin } = await brainPair();
    for (const [id, method, params] of TRY) admin.t.send(cmd(id, method, params));
    await until(() => admin.s.out.length === TRY.length);
    for (const m of admin.s.out) expect(m.error.message).toMatch(/^refused by eGPT: /);
    for (const [, method] of TRY) expect(brain.of(method)).toEqual([]);
  });
});

// ── 4. THE LIMB: one WS text message = one raw CDP message ──────────────────────────────────
class Sock {
  constructor() { this._h = {}; this.readyState = 1; this.closed = false; this.sent = []; this.bufferedAmount = 0; }
  on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
  fire(ev, ...a) { for (const cb of [...(this._h[ev] || [])]) cb(...a); }
  send(d) { if (this.closed) throw new Error('socket is closed'); this.sent.push(String(d)); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.fire('close'); }
}
function limbWith(onBeing) {
  const servers = [];
  class FakeWSS {
    constructor() { this._h = {}; servers.push(this); }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); if (ev === 'listening') cb(); return this; }
    fire(ev, ...a) { for (const cb of [...(this._h[ev] || [])]) cb(...a); }
    close() {}
  }
  const logs = [];
  const port = createShellPort({ WebSocketServer: FakeWSS, token: 'shell-token', reapPort: () => 0, onBeing, onLog: (m) => logs.push(m) });
  port.start();
  const dial = () => {
    const ws = new Sock();
    servers[0].fire('connection', ws, { url: BEING_PATH });
    const { nonce } = JSON.parse(ws.sent.shift());
    ws.fire('message', Buffer.from(responseFrame('s1', nonce)));
    return ws;
  };
  return { port, dial, logs };
}
function tunnelLink() {
  const t = { sent: [], closed: 0, sink: null };
  return {
    t,
    identify: (mac, nonce) => (macMatches(mac, authMac('s1', nonce)) ? DIEGO : null),
    ask: async (who, frame, sinkArg) => {
      t.sink = sinkArg;
      return { ok: true, detail: 'group shared', tunnel: { send: (x) => t.sent.push(x), close: () => { t.closed++; } } };
    },
  };
}

describe('shell-port — after `browser cdp` the connection is a tunnel', () => {
  it('the answer goes out first; every later frame is handed to the tunnel verbatim; a close closes it', async () => {
    const link = tunnelLink();
    const { dial, port } = limbWith(link);
    const ws = dial();
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'cdp' })));
    await tick();
    expect(JSON.parse(ws.sent[0])).toEqual({ ask: 'result', ok: true, detail: 'group shared' });
    ws.fire('message', Buffer.from(cmd(1, 'Target.getTargets')));
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'start' })));   // a CDP frame now, not an ask
    expect(link.t.sent).toEqual([cmd(1, 'Target.getTargets'), askFrame({ ask: 'browser', action: 'start' })]);
    link.t.sink.send('{"id":1,"result":{}}');
    expect(ws.sent[1]).toBe('{"id":1,"result":{}}');
    ws.close();
    expect(link.t.closed).toBe(1);
    port.stop();
  });

  it('a being more than 64 MB behind is closed, and its tunnel with it', async () => {
    const link = tunnelLink();
    const { dial, logs, port } = limbWith(link);
    const ws = dial();
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'cdp' })));
    await tick();
    ws.bufferedAmount = 64 * 1024 * 1024 + 1;
    link.t.sink.send('{"method":"Page.screencastFrame","params":{}}');
    expect(ws.closed).toBe(true);
    expect(ws.sent).toHaveLength(1);                     // only the answer ever went out
    expect(link.t.closed).toBe(1);
    expect(logs.join('\n')).toMatch(/64 MB behind/);
    port.stop();
  });

  it('a frame the tunnel cannot carry closes that being — it never escapes into the socket loop', async () => {
    const link = tunnelLink();
    const { dial, logs, port } = limbWith(link);
    const ws = dial();
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'cdp' })));
    await tick();
    link.t.sent.push = () => { throw new RangeError('Maximum call stack size exceeded'); };
    expect(() => ws.fire('message', Buffer.from('[[[[[[[[[['))).not.toThrow();
    expect(ws.closed).toBe(true);
    expect(logs.join('\n')).toMatch(/could not be carried/);
    port.stop();
  });

  it('a tunnel that opens after its connection closed is closed on the spot', async () => {
    const link = tunnelLink();
    let release;
    const slow = { ...link, ask: (...a) => new Promise((r) => { release = () => r(link.ask(...a)); }) };
    const { dial, port } = limbWith(slow);
    const ws = dial();
    ws.fire('message', Buffer.from(askFrame({ ask: 'browser', action: 'cdp' })));
    ws.close();
    release();
    await tick();
    expect(link.t.closed).toBe(1);
    port.stop();
  });
});

// ── 5. THE BEING'S SIDE: fetch + WebSocket over the link ─────────────────────────────────────
describe('being-cdp — /json and ws://…/devtools over the link, everything else untouched', () => {
  const saved = {};
  afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  async function realSpine(shared = fakeChrome('shared')) {
    const { link } = linkWith({ shared });
    const port = createShellPort({ port: 0, token: 'shell-token', reapPort: () => 0, onBeing: link, onLog: () => {} });
    const wss = port.start();
    await new Promise((r) => wss.once('listening', r));
    const m = link.forBeing(DIEGO).mint();
    for (const e of m.env) {
      const k = e.slice(0, e.indexOf('='));
      saved[k] = process.env[k];
      process.env[k] = e.slice(e.indexOf('=') + 1);
    }
    process.env[SPINE_PORT_ENV] = String(wss.address().port);
    return { shared, port };
  }

  it('fetch(/json/list) and WebSocket(webSocketDebuggerUrl) round-trip to the group\'s Chrome', async () => {
    const { shared, port } = await realSpine();
    const { fetch, WebSocket } = await import('../src/tools/being-cdp.mjs');
    const list = await (await fetch('http://127.0.0.1:9221/json/list')).json();
    expect(list.map((t) => [t.id, t.webSocketDebuggerUrl])).toEqual([
      ['T-page', 'ws://localhost:9221/devtools/page/T-page'],
      ['T-ext', 'ws://localhost:9221/devtools/page/T-ext'],
    ]);
    const ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    const got = new Promise((r) => { ws.onmessage = (e) => r(JSON.parse(e.data)); });
    ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: 'document.title' } }));
    expect(await got).toEqual({ id: 7, result: { result: { value: 'document.title' } } });
    expect(shared.of('Target.attachToTarget').at(-1).params).toEqual({ targetId: 'T-page', flatten: true });
    expect(shared.of('Runtime.evaluate')[0].sessionId).toMatch(/^shared-P/);
    ws.close();
    await until(() => shared.of('Target.detachFromTarget').length >= 2);
    port.stop();
  });

  it('/json/version names a browser endpoint that works; /json/new opens the tab its query names', async () => {
    const { shared, port } = await realSpine();
    const { fetch, WebSocket } = await import('../src/tools/being-cdp.mjs');
    const v = await (await fetch('http://localhost:9221/json/version')).json();
    expect(v.Browser).toBe('Chrome/140');
    const tab = await (await fetch(`http://localhost:9221/json/new?${encodeURIComponent('https://example.com/?a=1')}`, { method: 'PUT' })).json();
    expect(shared.of('Target.createTarget')[0].params).toEqual({ url: 'https://example.com/?a=1' });
    expect(tab.webSocketDebuggerUrl).toMatch(/^ws:\/\/localhost:9221\/devtools\/page\//);
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const got = new Promise((r) => ws.addEventListener('message', (e) => r(JSON.parse(e.data))));
    ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    expect((await got).result.targetInfos).toHaveLength(2);
    ws.close();
    port.stop();
  });

  it('fetch honours an AbortSignal, so cdp.mjs\'s deadline reaches through the being wire', async () => {
    const shared = fakeChrome('shared', { silent: ['Target.getTargets'] });
    const { port } = await realSpine(shared);
    const { fetch } = await import('../src/tools/being-cdp.mjs');
    const before = new AbortController();
    before.abort();
    await expect(fetch('http://localhost:9221/json', { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const ac = new AbortController();
    const pending = fetch('http://localhost:9221/json', { signal: ac.signal });
    await until(() => shared.of('Target.getTargets').length === 1);   // dialled, and the Chrome never answers
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => shared.of('Target.detachFromTarget').length >= 1);   // and the link is closed
    port.stop();
  });

  it('a non-9221 URL goes to the real fetch / WebSocket, untouched', async () => {
    const { fetch, WebSocket } = await import('../src/tools/being-cdp.mjs');
    const realFetch = globalThis.fetch, RealWS = globalThis.WebSocket;
    const calls = [];
    class Stub { constructor(u) { this.u = u; } }
    globalThis.fetch = async (...a) => { calls.push(a); return new Response('x'); };
    globalThis.WebSocket = Stub;
    try {
      const init = { method: 'POST' };
      await fetch('http://localhost:9222/json', init);
      await fetch('https://example.com/json/list');
      await fetch('http://127.0.0.1:92210/json');
      expect(calls.map(([u, i]) => [String(u), i])).toEqual([['http://localhost:9222/json', init], ['https://example.com/json/list', undefined], ['http://127.0.0.1:92210/json', undefined]]);
      const w = new WebSocket('ws://example.com/devtools/page/x');
      expect(w).toBeInstanceOf(Stub);
      expect(w.u).toBe('ws://example.com/devtools/page/x');
    } finally { globalThis.fetch = realFetch; globalThis.WebSocket = RealWS; }
  });

  const SHIM = pathToFileURL(join(import.meta.dirname, '..', 'src', 'tools', 'being-cdp.mjs')).href;

  it('cdp.mjs dials with the globals outside a being session, and with the shim inside one', async () => {
    saved[CDP_MODULE_ENV] = process.env[CDP_MODULE_ENV];
    delete process.env[CDP_MODULE_ENV];
    expect(await cdpWire()).toBe(globalThis);
    process.env[CDP_MODULE_ENV] = SHIM;
    const shim = await import('../src/tools/being-cdp.mjs');
    const wire = await cdpWire();
    expect([wire.fetch, wire.WebSocket]).toEqual([shim.fetch, shim.WebSocket]);
  });

  it('browser-tools from ~/src, with EGPT_CDP set, opens and reads tabs in the group\'s Chrome', async () => {
    const { shared, port } = await realSpine();
    process.env[CDP_MODULE_ENV] = SHIM;
    const browser = await import('../src/tools/browser-tools.mjs');
    // A call that slipped past the shim would reach this box's real :9221 — make it fail instead.
    const realFetch = globalThis.fetch, RealWS = globalThis.WebSocket;
    globalThis.fetch = () => { throw new Error('dialled the real fetch'); };
    // The /being link itself dials with the built-in WebSocket, so only a :9221 dial is refused.
    globalThis.WebSocket = class extends RealWS { constructor(u, p) { if (/:9221\//.test(String(u))) throw new Error('dialled the real WebSocket'); super(u, p); } };
    try {
      await browser.openTab('https://example.com/');
      expect(shared.of('Target.createTarget')[0].params).toEqual({ url: 'https://example.com/' });
      expect(await browser.getUrl('T-page')).toBe('location.href');
      expect(shared.of('Runtime.evaluate').at(-1)).toMatchObject({ sessionId: expect.stringMatching(/^shared-P/), params: { expression: 'location.href' } });
    } finally { globalThis.fetch = realFetch; globalThis.WebSocket = RealWS; port.stop(); }
  });

  it('browser-tools as a shell command: finds the tab by url, brings it up, reads it, and exits by itself', async () => {
    const { shared, port } = await realSpine();
    const tool = join(import.meta.dirname, '..', 'src', 'tools', 'browser-tools.mjs');
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [tool, 'mail.google', 'text', '12'], { env: { ...process.env, [CDP_MODULE_ENV]: SHIM } });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const kill = setTimeout(() => child.kill(), 10000);
      child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err }); });
    });
    expect(run).toEqual({ code: 0, out: 'location.href || document.title || (document.qu\n', err: '' });   // the fake Chrome echoes each expression
    expect(shared.of('Target.activateTarget').at(-1).params).toEqual({ targetId: 'T-page' });
    port.stop();
  });

  it('a script 0038 migrated runs as a being runs it — its own node, the minted env — and exits by itself', async () => {
    const { shared, port } = await realSpine();
    const script = join(mkdtempSync(join(tmpdir(), 'egpt-0038-run-')), 'tab-peek.mjs');
    writeFileSync(script, withInsert([
      "const list = await (await fetch('http://localhost:9221/json')).json();",
      "const tab = list.find((t) => t.type === 'page' && t.url.startsWith(process.argv[2]));",
      'const ws = new WebSocket(tab.webSocketDebuggerUrl);',
      'const pend = new Map();',
      'ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };',
      "await new Promise((r) => { ws.onopen = r; });",
      "const r = await new Promise((res) => { pend.set(1, res); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } })); });",
      'console.log(r.result.result.value);',
      'ws.close();',
      '',
    ].join('\n')));
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, 'https://mail.google.com'], { env: { ...process.env, [CDP_MODULE_ENV]: SHIM } });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const kill = setTimeout(() => child.kill(), 10000);
      child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err }); });
    });
    expect(run).toEqual({ code: 0, out: 'location.href\n', err: '' });
    expect(shared.of('Target.attachToTarget').at(-1).params).toEqual({ targetId: 'T-page', flatten: true });
    port.stop();
  });
});

// ── 6. THE MINT: unboxed sessions and boxed beats get a credential too ──────────────────────
describe('mint — every being session gets its chat\'s group browser', () => {
  function fakeSpawn() {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.stdin = { write: () => {}, end: () => {} };
      proc.kill = () => {};
      return proc;
    };
    return { spawn, calls };
  }
  const handle = () => {
    const h = { minted: 0, revoked: 0 };
    h.mint = () => { h.minted++; return { env: ['EGPT_SPINE_PORT=1', 'EGPT_BEING_TOKEN=tok', `${CDP_MODULE_ENV}=file:///x/being-cdp.mjs`], revoke: () => { h.revoked++; } }; };
    return h;
  };

  it('an UNBOXED warm session spawns with the credential in its env and revokes it at close', () => {
    const f = fakeSpawn();
    const h = handle();
    const s = createWarmCliSession({ spawn: f.spawn, beingLink: h });
    s.turn('hi').catch(() => {});
    expect(f.calls[0].opts.env).toMatchObject({ EGPT_BEING_TOKEN: 'tok', [CDP_MODULE_ENV]: 'file:///x/being-cdp.mjs', PATH: process.env.PATH });
    s.close();
    expect([h.minted, h.revoked]).toEqual([1, 1]);
  });

  it('with no link the spawn options are what they were', () => {
    const f = fakeSpawn();
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('hi').catch(() => {});
    expect(f.calls[0].opts).not.toHaveProperty('env');
    s.close();
  });

  it('a BOXED session still mints once — through the launcher, not the inner warm session', () => {
    const f = fakeSpawn();
    const h = handle();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: 'tok', jsonlStoreRoot: join(process.env.EGPT_HOME, 'jsonl'), sessionId: 't', gitBashCandidates: [], beingLink: h });
    s.turn('hi').catch(() => {});
    expect(h.minted).toBe(1);
    expect(f.calls[0].opts).not.toHaveProperty('env');
    s.close();
    expect(h.revoked).toBe(1);
  });

  it('a boxed COMMAND BEAT mints one per run and revokes it when the run ends', () => {
    const f = fakeSpawn();
    const h = handle();
    const proc = spawnBoxedCommand({ targetFolder: process.cwd(), command: 'echo hi', commandFile: 'x.sh', spawn: f.spawn, platform: 'win32', gitBashCandidates: [process.execPath], beingLink: h });
    const setEnv = JSON.parse(f.calls[0].args[f.calls[0].args.indexOf('-SetEnv') + 1]);
    expect(setEnv).toContain('EGPT_BEING_TOKEN=tok');
    expect(h.revoked).toBe(0);
    proc.emit('close', 0);
    expect([h.minted, h.revoked]).toEqual([1, 1]);
  });
});
