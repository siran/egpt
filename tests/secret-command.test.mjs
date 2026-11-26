// secret-command.test.mjs — /<handle> secret [name] and /<handle> secret confirm <code> (the secrets page).
// Operator-only (the same gate every command uses); the reply is the link, only in the chat it was typed in, nothing
// secret in it. With limbs.http.public_url the link is the site's; without, a tunnel (fake here). The session
// activates only when the operator who asked types the page's code in that chat.
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-secret-command-home`;
});

import { createCommands } from '../src/spine/commands.mjs';
import { createSecretSessions, createSecretLink } from '../src/bridges/http-secrets.mjs';
import { COMMANDS } from '../src/interpreter.mjs';

const OPERATOR = '@an:beeper.com';
const NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const cfg = (http) => ({ networks: { whatsapp: { chat_ids: ['!self'], allowed_users: [OPERATOR, '@bo:beeper.com'] } }, agents: { edu: {} }, ...(http ? { limbs: { http } } : {}) });
const msg = (body, over = {}) => ({ surface: 'whatsapp', node: 'wa', chatId: '!grp', chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' }, senderId: '@x:beeper.com', senderName: 'X', msgId: 'm1', isSender: false, authorized: false, body, ...over });
const op = (body, over = {}) => msg(body, { senderId: OPERATOR, senderName: 'An', authorized: true, ...over });

function harness({ http = undefined, httpLimb = false, wired = true, tunnelFails = false } = {}) {
  const sent = [], opened = [], closed = [];
  const door = { port: null, async start() { this.port = 40123; return this.port; }, stop: async () => {} };
  const tunnel = {
    open: async (key) => { if (tunnelFails) throw new Error('cloudflared gave no tunnel URL'); opened.push(key); return { url: 'https://quick-abc.trycloudflare.com' }; },
    close: (key) => { closed.push(key); },
  };
  let link = null;
  const sessions = createSecretSessions({ now: () => NOW, onEnd: (s, n) => link?.ended(s, n) });
  link = createSecretLink({ sessions, door, tunnel, httpLimb: () => httpLimb });
  const cmds = createCommands({ getConfig: () => cfg(http), send: async (chatId, text) => sent.push({ chatId, text }), exit: () => {}, logTranscript: async () => true, ...(wired ? { secretLink: link } : {}) });
  const run = async (ev) => { const e = cmds.commandOf(ev) ?? ev; return { gate: await cmds.isCommand(e), out: await cmds.run(e) }; };
  // The "browser": claim the page (what POST /claim does) and read the code it would show.
  const claimed = (token) => { const s = sessions.check(token); s.claim = Buffer.from('c'); s.code = '12345678'; return s.code; };
  return { cmds, sent, sessions, run, opened, closed, claimed, tokenOf: () => /\/secret\/([A-Za-z0-9_-]{43})/.exec(sent.at(-1).text)[1] };
}
const linkOf = (h) => /https:\/\/\S+/.exec(h.sent.at(-1).text)[0];

describe('/<handle> secret', () => {
  it('without public_url: a tunnel link to the page, in the chat it was typed in, bound to who asked; 15 minutes', async () => {
    const h = harness();
    expect((await h.run(op('/edu secret'))).gate).toBe(true);
    expect(h.opened).toEqual(['secrets']);
    const m = /^https:\/\/quick-abc\.trycloudflare\.com\/secret\/([A-Za-z0-9_-]{43})$/.exec(linkOf(h));
    expect(m).toBeTruthy();
    expect(h.sessions.check(m[1])).toMatchObject({ who: 'An', operator: OPERATOR, chatId: '!grp', expires: NOW + 15 * 60_000, confirmed: false });
    expect(h.sent.at(-1).text).toContain('10:15 UTC');
    expect(h.sent.at(-1).text).toMatch(/secret confirm/);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].chatId).toBe('!grp');
  });

  it('with a name the link opens on that secret', async () => {
    const h = harness();
    await h.run(op('/edu secret bot.token'));
    expect(linkOf(h)).toMatch(/^https:\/\/quick-abc\.trycloudflare\.com\/secret\/[A-Za-z0-9_-]{43}\?name=bot\.token$/);
  });

  it('limbs.http.public_url set (and the http limb on): the site link under ayde.path, no tunnel', async () => {
    const h = harness({ http: { port: 1, public_url: 'https://example.org/', ayde: { path: '/team' } }, httpLimb: true });
    await h.run(op('/edu secret bot.token'));
    expect(linkOf(h)).toMatch(/^https:\/\/example\.org\/team\/secret\/[A-Za-z0-9_-]{43}\?name=bot\.token$/);
    expect(h.opened).toEqual([]);
    const d = harness({ http: { port: 1, public_url: 'https://example.org' }, httpLimb: true });
    await d.run(op('/edu secret'));
    expect(linkOf(d)).toMatch(/^https:\/\/example\.org\/ayde\/secret\//);
  });

  it('public_url without an http limb says so, opens no session and no tunnel', async () => {
    const h = harness({ http: { public_url: 'https://example.org' }, httpLimb: false });
    await h.run(op('/edu secret'));
    expect(h.sent.at(-1).text).toMatch(/public_url is set but this node has no http limb/);
    expect(h.opened).toEqual([]);
    expect(h.sessions.count()).toBe(0);
  });

  it('a tunnel that does not come up: the error is said, the session is dropped', async () => {
    const h = harness({ tunnelFails: true });
    await h.run(op('/edu secret'));
    expect(h.sent.at(-1).text).toMatch(/no link: cloudflared gave no tunnel URL/);
    expect(h.sessions.count()).toBe(0);
  });

  it('public by default: a non-operator gets a link for /secret and /secret <name>, bound to them', async () => {
    const h = harness();
    expect((await h.run(msg('/edu secret'))).gate).toBe(true);
    expect(h.sessions.check(h.tokenOf())).toMatchObject({ who: 'X', operator: '@x:beeper.com' });
    await h.run(msg('/edu secret team.key'));
    expect(linkOf(h)).toMatch(/\?name=team\.key$/);
  });

  it('public_commands without secret: a non-operator is refused (not a command, no session), the operator still works', async () => {
    const h = harness();
    const c = createCommands({ getConfig: () => ({ ...cfg(), public_commands: ['split'] }), send: async (chatId, text) => h.sent.push({ chatId, text }), exit: () => {}, logTranscript: async () => true, secretLink: createSecretLink({ sessions: h.sessions, door: { start: async () => 1 }, tunnel: { open: async () => ({ url: 'https://t.trycloudflare.com' }), close() {} } }) });
    expect(await c.isCommand(c.commandOf(msg('/edu secret')))).toBe(false);
    expect(h.sessions.count()).toBe(0);
    expect(await c.isCommand(c.commandOf(op('/edu secret')))).toBe(true);
    await c.run(c.commandOf(op('/edu secret')));
    expect(h.sessions.count()).toBe(1);
  });

  it('never from a website chatbox: an http-surface non-operator is refused, no session; the operator and other public senders are not', async () => {
    const h = harness();
    for (const body of ['/edu secret', '/edu secret team']) {
      await h.run(msg(body, { surface: 'http' }));
      expect(h.sent.at(-1).text).toMatch(/not available here/);
    }
    expect(h.sessions.count()).toBe(0);
    await h.run(op('/edu secret', { surface: 'http' }));
    await h.run(msg('/edu secret'));
    expect(h.sessions.count()).toBe(2);
  });

  it('a stranger cannot confirm someone else\'s session', async () => {
    const h = harness();
    const c = createCommands({ getConfig: () => ({ ...cfg(), public_commands: ['secret'] }), send: async (chatId, text) => h.sent.push({ chatId, text }), exit: () => {}, logTranscript: async () => true, secretLink: createSecretLink({ sessions: h.sessions, door: { start: async () => 1 }, tunnel: { open: async () => ({ url: 'https://t.trycloudflare.com' }), close() {} } }) });
    h.sent.length = 0;
    await h.run(op('/edu secret'));
    const tok = h.tokenOf(), code = h.claimed(tok);
    await c.run(c.commandOf(msg(`/edu secret confirm ${code}`)));
    expect(h.sessions.check(tok).confirmed).toBe(false);
  });

  it('a bad name is a usage line, no session; the command is in the help menu', async () => {
    const h = harness();
    await h.run(op('/edu secret ../x'));
    expect(h.sent.at(-1).text).toMatch(/^usage: \/edu secret \[name\]/);
    expect(h.sessions.count()).toBe(0);
    expect(COMMANDS.some((c) => c.cmd === '/secret' && c.usage === '/<handle> secret [name | confirm <code>]')).toBe(true);
  });
});

describe('/<handle> secret confirm <code>: the session activates only for the operator, in the chat, with the code', () => {
  async function asked() {
    const h = harness();
    await h.run(op('/edu secret'));
    const token = h.tokenOf();
    return { h, token, code: h.claimed(token) };
  }

  it('the right code, same chat, same operator: confirmed', async () => {
    const { h, token, code } = await asked();
    expect(h.sessions.check(token).confirmed).toBe(false);
    await h.run(op(`/edu secret confirm ${code}`));
    expect(h.sessions.check(token).confirmed).toBe(true);
    expect(h.sent.at(-1).text).toMatch(/confirmed/);
  });

  it('a wrong code, another chat, another operator, or before the page was opened: refused, still inactive', async () => {
    const { h, token, code } = await asked();
    await h.run(op('/edu secret confirm 00000000'));
    expect(h.sent.at(-1).text).toMatch(/not the code/);
    await h.run(op(`/edu secret confirm ${code}`, { chatId: '!other' }));
    expect(h.sent.at(-1).text).toMatch(/no secrets page is waiting/);
    await h.run(op(`/edu secret confirm ${code}`, { senderId: '@bo:beeper.com', senderName: 'Bo' }));
    expect(h.sent.at(-1).text).toMatch(/no secrets page is waiting/);
    await h.run(msg(`/edu secret confirm ${code}`));   // a stranger: not even a command
    expect(h.sessions.check(token).confirmed).toBe(false);
    const fresh = harness();
    await fresh.run(op('/edu secret'));
    await fresh.run(op('/edu secret confirm 12345678'));   // the page was never opened: there is no code yet
    expect(fresh.sent.at(-1).text).toMatch(/no secrets page is waiting/);
  });

  it('five wrong codes end the session; the right one afterwards does nothing', async () => {
    const { h, token, code } = await asked();
    for (let i = 0; i < 5; i++) await h.run(op('/edu secret confirm 00000001'));
    expect(h.sent.at(-1).text).toMatch(/too many wrong codes/);
    expect(h.sessions.check(token)).toBeNull();
    await h.run(op(`/edu secret confirm ${code}`));
    expect(h.sent.at(-1).text).toMatch(/no secrets page is waiting/);
    expect(h.closed).toEqual(['secrets']);   // and the tunnel went with it
  });

  it('a code cannot be reused: after confirming, the same code is refused', async () => {
    const { h, code } = await asked();
    await h.run(op(`/edu secret confirm ${code}`));
    await h.run(op(`/edu secret confirm ${code}`));
    expect(h.sent.at(-1).text).toMatch(/no secrets page is waiting/);
  });
});
