// secret-command.test.mjs — /<handle> secret [name] (the secrets page). Operator-only (the same gate every
// command uses); the reply is the link and its expiry, nothing secret; without limbs.http.public_url or
// an http limb it says what to set.
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-secret-command-home`;
});

import { createCommands } from '../src/spine/commands.mjs';
import { createSecretSessions } from '../src/bridges/http-secrets.mjs';
import { COMMANDS } from '../src/interpreter.mjs';

const OPERATOR = '@an:beeper.com';
const NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const cfg = (http) => ({ networks: { whatsapp: { chat_ids: ['!self'], allowed_users: [OPERATOR] } }, agents: { edu: {} }, ...(http ? { limbs: { http } } : {}) });
const msg = (body, over = {}) => ({ surface: 'whatsapp', node: 'wa', chatId: '!grp', chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' }, senderId: '@x:beeper.com', senderName: 'X', msgId: 'm1', isSender: false, authorized: false, body, ...over });
const op = (body, over = {}) => msg(body, { senderId: OPERATOR, senderName: 'An', authorized: true, ...over });

function harness({ http = { port: 8095, public_url: 'https://example.org/' }, wired = true } = {}) {
  const sent = [], sessions = createSecretSessions({ now: () => NOW });
  const cmds = createCommands({ getConfig: () => cfg(http), send: async (chatId, text) => sent.push({ chatId, text }), exit: () => {}, logTranscript: async () => true, ...(wired ? { secretSessions: sessions } : {}) });
  const run = async (ev) => { const e = cmds.commandOf(ev) ?? ev; return { gate: await cmds.isCommand(e), out: await cmds.run(e) }; };
  return { cmds, sent, sessions, run };
}
const linkOf = (h) => /https:\/\/\S+/.exec(h.sent.at(-1).text)[0];

describe('/<handle> secret', () => {
  it('replies with the link to a 15-minute session bound to who asked, and the expiry; nothing else', async () => {
    const h = harness();
    expect((await h.run(op('/edu secret'))).gate).toBe(true);
    const url = linkOf(h);
    const m = /^https:\/\/example\.org\/ayde\/secret\/([A-Za-z0-9_-]{43})$/.exec(url);
    expect(m).toBeTruthy();
    expect(h.sessions.check(m[1])).toEqual({ who: 'An', expires: NOW + 15 * 60_000 });
    expect(h.sent.at(-1).text).toContain('10:15 UTC');
    expect(h.sent).toHaveLength(1);
  });

  it('with a name the link opens on that secret; the path follows ayde.path', async () => {
    const h = harness({ http: { port: 1, public_url: 'https://example.org', ayde: { path: '/team' } } });
    await h.run(op('/edu secret bot.token'));
    expect(linkOf(h)).toMatch(/^https:\/\/example\.org\/team\/secret\/[A-Za-z0-9_-]{43}\?name=bot\.token$/);
  });

  it('is operator-only: a stranger is not admitted, a direct run opens no session', async () => {
    const h = harness();
    expect(await h.cmds.isCommand(h.cmds.commandOf(msg('/edu secret')))).toBe(false);
    await h.cmds.run(h.cmds.commandOf(msg('/edu secret')));
    expect(h.sent.at(-1).text).toMatch(/secret. is operator-only/);
    expect(h.sent.at(-1).text).not.toMatch(/https:/);
  });

  it('even where public_commands lists it, a stranger gets no link', async () => {
    const h = harness();
    const c = createCommands({ getConfig: () => ({ ...cfg({ port: 1, public_url: 'https://example.org' }), public_commands: ['secret'] }), send: async (chatId, text) => h.sent.push({ chatId, text }), exit: () => {}, logTranscript: async () => true, secretSessions: h.sessions });
    h.sent.length = 0;
    await c.run(c.commandOf(msg('/edu secret')));
    expect(h.sent.map((s) => s.text).join()).not.toMatch(/https:/);
  });

  it('no public_url, or no http limb: it says what to set and opens nothing', async () => {
    for (const h of [harness({ http: { port: 8095 } }), harness({ http: null }), harness({ wired: false })]) {
      await h.run(op('/edu secret'));
      expect(h.sent.at(-1).text).toMatch(/limbs\.http\.port and limbs\.http\.public_url/);
    }
  });

  it('a bad name is a usage line, no session; the command is in the help menu', async () => {
    const h = harness();
    await h.run(op('/edu secret ../x'));
    expect(h.sent.at(-1).text).toMatch(/^usage: \/edu secret \[name\]/);
    expect(COMMANDS.some((c) => c.cmd === '/secret' && c.usage === '/<handle> secret [name]')).toBe(true);
  });
});
