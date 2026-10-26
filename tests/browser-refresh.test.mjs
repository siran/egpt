// tests/browser-refresh.test.mjs — /<handle> browser refresh [group] [url] (operator 2026-10-26): sites refuse
// eGPT's pipe Chrome (Google sign-in, NYSCEF's captcha), so a human signs in in a PLAIN Chrome on the
// group's profile. The command closes eGPT's Chrome through the pool, opens the plain one through the
// daemon, and holds the group until that window's Chrome exits. Fake chrome-host (fake-pipe-chrome.mjs).
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { createCommands, CHROME_BRAIN_PROFILE } from '../src/spine/commands.mjs';
import { chromePipeArgs, chromePlainArgs } from '../src/tools/chrome-launcher.mjs';
import { fakePipeChrome } from './fake-pipe-chrome.mjs';

const MB = 1024 * 1024;
const conv = (slug) => ({ slug, conversation_path: `.egpt/conversations/whatsapp/${slug}` });
const STATE = { contacts: { whatsapp: {
  '!admin': conv('eGPT Admin-2609121344'),
  '!nys': conv('NYSCEF case-2610200000'),
  '!dup': conv('Twice-2601010000'),
  '!bad': conv('Bad-2601010000'),
} } };
const GROUPS = { brain: ['eGPT Admin'], work: ['NYSCEF case', 'Twice'], other: ['Twice'], 'no/good': ['Bad'] };
const WORK = { key: 'NYSCEF case-2610200000', name: 'NYSCEF case', group: 'work' };
const workDir = join(dirname(CHROME_BRAIN_PROFILE), 'work');
const NYSCEF = 'https://iapps.courts.state.ny.us/nyscef/Login';
const FOLDERS = ['brain', 'Old Chrome', 'legacy'];

function build({ profileHolder = () => null, chromeHost } = {}) {
  const fake = fakePipeChrome({ listTabs: async () => [{ id: 'P1', url: 'https://x/', title: 'x' }] });
  const logs = [], sent = [];
  const cmds = createCommands({
    getConfig: () => ({ node_name: 'kg', agents: { e: {} }, whatsapp: { chat_id: '!admin' }, chrome: { bin: 'C:/x/chrome.exe' } }),
    chromeHost: chromeHost === undefined ? fake.chromeHost : chromeHost,
    profileHolder, freeMem: () => 8192 * MB, rssOf: () => null,
    onChromeLog: (m) => logs.push(m),
    browserGroups: async () => GROUPS,
    profileFolders: () => FOLDERS,
    loadState: async () => STATE, writeState: async () => {},
    send: async (chatId, text) => sent.push({ chatId, text }),
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
  });
  return { cmds, ...fake, logs, sent };
}
const run = (cmds, chatId, body) => cmds.run({ chatId, surface: 'whatsapp', authorized: true, commandHandle: 'e', body });
const lastText = (sent) => sent.at(-1).text;

describe('/browser refresh — the plain sign-in window', () => {
  it('closes eGPT\'s Chrome through the pool, THEN opens a plain Chrome on the same profile, and says what to do', async () => {
    const w = build();
    await w.cmds.startBrowser(WORK);
    await run(w.cmds, '!nys', `/browser refresh ${NYSCEF}`);
    expect(w.handles[0].child.killed).toBe(true);
    expect(w.events).toEqual(['launch:work', 'kill:work', 'plain:work']);
    expect(w.plain).toHaveLength(1);
    expect(w.plain[0]).toMatchObject({ group: 'work', profileDir: workDir, bin: 'C:/x/chrome.exe', argv: chromePlainArgs({ userDataDir: workDir, url: NYSCEF }) });
    expect(w.plain[0].argv).toEqual([`--user-data-dir=${workDir}`, '--no-first-run', NYSCEF]);
    expect(lastText(w.sent)).toMatch(new RegExp(`^I closed my browser for work\\. A normal Chrome window opened on kg at ${NYSCEF.replace(/[.?/]/g, '\\$&')}: sign in / pass the check yourself, then close that window — I'll use the session next time\\.`));
    expect(lastText(w.sent).includes('VNC')).toBe(process.platform !== 'win32');
  });

  it('holds the group until the plain Chrome exits: a being is told why, nothing relaunches; then the chat hears it is back', async () => {
    const w = build();
    await w.cmds.startBrowser(WORK);
    await run(w.cmds, '!nys', '/browser refresh');
    expect(w.plain[0].argv.at(-1)).toBe('about:blank');

    const asked = await w.cmds.startBrowser(WORK);
    expect(asked).toMatchObject({ ok: false, reason: 'no-browser' });
    expect(asked.detail).toMatch(/the "work" browser is held for sign-in/);
    await run(w.cmds, '!nys', '/chrome');
    expect(lastText(w.sent)).toMatch(/held for sign-in/);
    expect(w.calls).toHaveLength(1);                      // the kill's own exit did not release the hold

    w.plain[0].close();                                   // the human closed the window
    expect(w.sent.at(-1)).toEqual({ chatId: '!nys', text: 'browser work is back — signed-in session will be used' });
    expect(await w.cmds.startBrowser(WORK)).toMatchObject({ ok: true, launched: true });
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1].argv).toEqual(chromePipeArgs({ userDataDir: workDir, windowName: 'work' }));   // ensureChrome unchanged
  });

  it('no eGPT Chrome up → nothing to close, the plain window still opens', async () => {
    const w = build();
    await run(w.cmds, '!nys', '/browser refresh accounts.google.com');
    expect(w.events).toEqual(['plain:work']);
    expect(w.plain[0].argv.at(-1)).toBe('https://accounts.google.com/');
    expect(lastText(w.sent)).toMatch(/^My browser for work was not open\. A normal Chrome window opened on kg at https:\/\/accounts\.google\.com\//);
  });

  it('a second refresh while held opens nothing more', async () => {
    const w = build();
    await run(w.cmds, '!nys', '/browser refresh');
    await run(w.cmds, '!nys', '/browser refresh');
    expect(w.plain).toHaveLength(1);
    expect(lastText(w.sent)).toMatch(/"work" browser is already held for sign-in — close that Chrome window first/);
  });

  it('another Chrome already on the profile → refused, nothing opened, the group not held', async () => {
    const w = build({ profileHolder: () => 'EBUSY' });
    await run(w.cmds, '!nys', '/browser refresh');
    expect(w.plain).toHaveLength(0);
    expect(lastText(w.sent)).toMatch(/another Chrome holds the "work" profile \(EBUSY\) — close it first/);
    expect((await w.cmds.startBrowser(WORK)).detail).toMatch(/open in a normal window/);
  });

  it('a failed plain launch releases the hold and says why', async () => {
    const fake = fakePipeChrome();
    const w = build({ chromeHost: { ...fake.chromeHost, launchPlain: async () => { throw new Error('a plain Chrome takes no --remote-debugging switch'); } } });
    await run(w.cmds, '!nys', '/browser refresh');
    expect(lastText(w.sent)).toMatch(/refresh: a plain Chrome takes no --remote-debugging switch/);
    expect(await w.cmds.startBrowser(WORK)).toMatchObject({ ok: true, launched: true });
  });

  it('an ambiguous or unusable group → a clear no-browser line, nothing closed or opened', async () => {
    const w = build();
    await run(w.cmds, '!dup', '/browser refresh');
    expect(lastText(w.sent)).toBe('no browser for this chat — "Twice" is listed in browser groups work, other');
    await run(w.cmds, '!bad', '/browser refresh');
    expect(lastText(w.sent)).toBe('no browser for this chat — browser group "no/good" is not a safe profile dir name');
    expect(w.events).toEqual([]);
  });

  it('no daemon chrome-host → says so, opens nothing', async () => {
    const w = build({ chromeHost: null });
    await run(w.cmds, '!nys', '/browser refresh');
    expect(lastText(w.sent)).toMatch(/no browser for this chat — this spine has no daemon chrome-host/);
  });

  it('the url is a page, never a Chrome switch; anything but refresh is the usage line', async () => {
    const w = build();
    for (const bad of ['/browser refresh file:///C:/x', '/browser refresh chrome://settings', '/browser', '/browser open https://x', `/browser refresh ${NYSCEF} extra`, '/browser refresh --remote-debugging-port=9222', '/browser refresh work file:///C:/x', `/browser refresh work ${NYSCEF} extra`]) {
      await run(w.cmds, '!nys', bad);
      expect(lastText(w.sent)).toMatch(/^usage: \/e browser refresh \[group\] \[url\]/);
    }
    expect(w.plain).toHaveLength(0);
    await run(w.cmds, '!nys', '/browser refresh work --remote-debugging-port=9222');
    expect(w.plain[0].argv.at(-1)).toMatch(/^https:\/\//);
    expect(w.plain[0].argv.filter((a) => a.startsWith('-'))).toEqual([`--user-data-dir=${workDir}`, '--no-first-run']);
  });
});

describe("/browser refresh <group> — a named profile, not this chat's", () => {
  const brainDir = CHROME_BRAIN_PROFILE;

  it('`refresh brain` targets brain from a work chat; the back line comes to that chat', async () => {
    const w = build();
    await w.cmds.startBrowser({ key: '', name: '', group: 'brain' });
    await run(w.cmds, '!nys', '/browser refresh brain');
    expect(w.events).toEqual(['launch:brain', 'kill:brain', 'plain:brain']);
    expect(w.plain[0]).toMatchObject({ group: 'brain', profileDir: brainDir, argv: chromePlainArgs({ userDataDir: brainDir, url: 'about:blank' }) });
    expect(lastText(w.sent)).toMatch(/^I closed my browser for brain\. A normal Chrome window opened on kg at about:blank:/);
    w.plain[0].close();
    expect(w.sent.at(-1)).toEqual({ chatId: '!nys', text: 'browser brain is back — signed-in session will be used' });
  });

  it('`refresh Brain accounts.google.com` targets brain with that url (group matched case-insensitively)', async () => {
    const w = build();
    await run(w.cmds, '!nys', '/browser refresh Brain accounts.google.com');
    expect(w.plain[0]).toMatchObject({ group: 'brain', profileDir: brainDir });
    expect(w.plain[0].argv.at(-1)).toBe('https://accounts.google.com/');
  });

  it("`refresh accounts.google.com` is still this chat's group", async () => {
    const w = build();
    await run(w.cmds, '!nys', '/browser refresh accounts.google.com');
    expect(w.plain[0]).toMatchObject({ group: 'work', profileDir: workDir });
    expect(w.plain[0].argv.at(-1)).toBe('https://accounts.google.com/');
  });

  it('a browsers.yaml group or a folder under the profiles root is a target too', async () => {
    const w = build();
    await run(w.cmds, '!admin', '/browser refresh WORK');
    expect(w.plain[0]).toMatchObject({ group: 'work', profileDir: workDir });
    await run(w.cmds, '!admin', '/browser refresh legacy https://x.example/');
    expect(w.plain[1]).toMatchObject({ group: 'legacy', profileDir: join(dirname(CHROME_BRAIN_PROFILE), 'legacy') });
    expect(w.plain[1].argv.at(-1)).toBe('https://x.example/');
  });

  it('an unknown word with no url shape → the usage and the known group names, nothing opened', async () => {
    const w = build();
    await run(w.cmds, '!nys', '/browser refresh nosuch');
    expect(lastText(w.sent)).toMatch(/^usage: \/e browser refresh \[group\] \[url\]/);
    expect(lastText(w.sent)).toMatch(/groups: brain, legacy, other, shared, work$/);
    await run(w.cmds, '!nys', '/browser refresh nosuch x.example');
    expect(lastText(w.sent)).toMatch(/groups: brain, legacy, other, shared, work$/);
    expect(w.events).toEqual([]);
  });
});

describe('/browser refresh — who may run it', () => {
  const ev = (over) => ({ surface: 'whatsapp', chatId: '!nys', senderId: '@lulu:beeper.local', isSender: false, authorized: false, body: '/e browser refresh', ...over });

  it('an owner runs it; anyone else is refused (not a public command)', async () => {
    const { cmds } = build();
    const owner = cmds.commandOf(ev({ authorized: true }));
    expect(owner).toMatchObject({ body: '/browser refresh', commandBeing: 'e' });
    expect(await cmds.isCommand(owner)).toBe(true);
    expect(await cmds.isCommand(cmds.commandOf(ev()))).toBe(false);
  });
});

describe('/browser refresh on a node with no desktop of its own', () => {
  const real = process.platform;
  afterEach(() => { Object.defineProperty(process, 'platform', { value: real }); });

  it('a Linux/container node tells the operator to open VNC (:6080)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const w = build();
    await run(w.cmds, '!nys', '/browser refresh');
    expect(lastText(w.sent)).toMatch(/close that window — I'll use the session next time\. Open VNC \(:6080\) to see it\.$/);
  });
});
