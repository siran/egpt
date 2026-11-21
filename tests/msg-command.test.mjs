// /<handle> msg <chat> <text> — a being's finished message into ANOTHER chat it already answers in.
// Resolution is commands.resolveTarget (shared with /agents=<slug>); delivery is deliverTo → forkBridge.postReply
// (shared with /send), which boot stamps as the being. Generic fixtures only.
import { describe, it, expect, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/egpt-msg-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { createCommands } from '../src/spine/commands.mjs';
import { ensureContact, recordThread } from '../src/conversations-state.mjs';
import { makeWrapPersona } from '../src/bridges/persona-wrap.mjs';

const ORIGIN = 'tg:100';
// [surface, jid, name, residents]
const CHATS = {
  origin: ['telegram', ORIGIN, 'Ops', ['leo']],
  daniel: ['telegram', 'tg:201', 'Daniel', ['leo']],
  daniRuiz: ['telegram', 'tg:202', 'Dani Ruiz', ['leo']],
  jose: ['telegram', 'tg:203', 'José', ['leo']],
  sales: ['telegram', 'tg:204', 'Sales/Support', ['leo']],
  team: ['telegram', 'tg:-300', 'Team', ['leo']],
  topic: ['telegram', 'tg:-300/7', 'Billing', ['leo']],
  visitor: ['http', 'http:acme-abc', 'Visitor Dani', ['leo']],
  quiet: ['telegram', 'tg:205', 'Quiet Room', ['other']],
};
function build(keys, config = {}) {
  let st = { contacts: {} };
  for (const k of ['origin', ...keys]) {
    const [surface, jid, name, residents] = CHATS[k];
    st = ensureContact(st, surface, jid, { pushedName: name, slugHint: name.toLowerCase().replace(/\W+/g, '-') }).state;
    for (const b of residents) st = recordThread(st, surface, jid, `t-${b}`, '2026-11-01T00:00:00Z', b);
  }
  const sent = [], posts = [];
  const cmds = createCommands({
    getConfig: () => ({ node_name: 'n', agents: { leo: {}, other: {} }, ...config }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st, writeState: async (s) => { st = s; },
    forkBridge: { postReply: async (chatId, text, reply, opts) => { posts.push({ chatId, text, opts }); return true; } },
    onLog: () => {},
  });
  const msg = (body) => cmds.run({ chatId: ORIGIN, surface: 'telegram', msgId: 'm1', body, isSender: true, commandBeing: 'leo', commandHandle: 'leo' });
  // the spine's own path for any line: commandOf, then isCommand, then run
  const via = async (ev) => { const c = cmds.commandOf({ chatId: ORIGIN, surface: 'telegram', msgId: 'm2', ...ev }, undefined); if (c && await cmds.isCommand(c)) { await cmds.run(c); return true; } return false; };
  return { msg, sent, posts, via, run: cmds.run };
}

describe('/msg', () => {
  it('"dani" with only Daniel known sends to Daniel, as the being', async () => {
    const { msg, sent, posts } = build(['daniel']);
    await msg('/msg dani hello there');
    expect(posts).toHaveLength(1);
    expect(posts[0].chatId).toBe('tg:201');
    expect(posts[0].text).toBe('hello there');
    expect(posts[0].opts).toMatchObject({ being: 'leo', surface: 'telegram' });
    expect(sent.at(-1).text).toBe('sent to Daniel');
  });
  it('"dani" with Daniel and Dani Ruiz sends nothing and lists both', async () => {
    const { msg, sent, posts } = build(['daniel', 'daniRuiz']);
    await msg('/msg dani hi');
    expect(posts).toHaveLength(0);
    expect(sent.at(-1).text).toMatch(/Daniel/);
    expect(sent.at(-1).text).toMatch(/Dani Ruiz/);
  });
  it('"jose" finds José (accent-blind)', async () => {
    const { msg, posts } = build(['jose']);
    await msg('/msg jose hi');
    expect(posts[0].chatId).toBe('tg:203');
  });
  it('a quoted target with spaces works', async () => {
    const { msg, posts } = build(['daniel', 'daniRuiz']);
    await msg('/msg "Dani Ruiz" hi');
    expect(posts.map((p) => p.chatId)).toEqual(['tg:202']);
  });
  it('a group name with a slash, and a topic by name and by Group/topic', async () => {
    const { msg, posts } = build(['sales', 'team', 'topic']);
    await msg('/msg "Sales/Support" a');
    await msg('/msg billing b');
    await msg('/msg team/billing c');
    expect(posts.map((p) => p.chatId)).toEqual(['tg:204', 'tg:-300/7', 'tg:-300/7']);
  });
  it('a bare group name does not also match its topics', async () => {
    const { msg, posts } = build(['team', 'topic']);
    await msg('/msg team hi');
    expect(posts.map((p) => p.chatId)).toEqual(['tg:-300']);
  });
  it('never matches the http surface', async () => {
    const { msg, sent, posts } = build(['visitor']);
    await msg('/msg visitor hi');
    expect(posts).toHaveLength(0);
    expect(sent.at(-1).text).toMatch(/no chat matches/);
  });
  it('refuses a chat where the being does not answer', async () => {
    const { msg, sent, posts } = build(['quiet']);
    await msg('/msg quiet hi');
    expect(posts).toHaveLength(0);
    expect(sent.at(-1).text).toBe('`/msg`: leo does not answer in Quiet Room');
  });
  it('msg: false refuses', async () => {
    const { msg, sent, posts } = build(['daniel'], { msg: false });
    await msg('/msg daniel hi');
    expect(posts).toHaveLength(0);
    expect(sent.at(-1).text).toMatch(/msg: false/);
  });
  it('multi-line text arrives intact, and the being stamp wraps it', async () => {
    const { msg, posts } = build(['daniel']);
    await msg('/msg daniel first line\n\n- second\n- third');
    expect(posts[0].text).toBe('first line\n\n- second\n- third');
    const wrap = makeWrapPersona({ nodeName: 'n' });
    const out = wrap({ bodyEmoji: '🐶', label: 'leo', persona: 'leo' }, posts[0].text);
    expect(out.startsWith('🐶 leo: first line\n\n- second\n- third')).toBe(true);
  });
  it('asks for a target and a text', async () => {
    const { msg, sent, posts } = build(['daniel']);
    await msg('/msg daniel');
    expect(posts).toHaveLength(0);
    expect(sent.at(-1).text).toMatch(/say where and what/);
  });

  it("a being's own signed line runs it and posts", async () => {
    const { via, posts } = build(['daniel']);
    expect(await via({ body: '🐶 leo: /leo msg Daniel hi', fromNode: 'n', fromBeing: 'leo' })).toBe(true);
    expect(posts.map((p) => [p.chatId, p.text])).toEqual([['tg:201', 'hi']]);
  });
  it('a non-owner person in a group runs it, with no public_commands entry', async () => {
    const { via, posts } = build(['daniel'], { public_commands: [] });
    expect(await via({ body: '/leo msg Daniel hi', senderId: 'stranger', raw: { chatType: 'group' } })).toBe(true);
    expect(posts).toHaveLength(1);
  });
  it('an http-origin line, a person\'s or a being\'s, is not a command and posts nothing', async () => {
    const { via, posts, sent } = build(['daniel']);
    expect(await via({ surface: 'http', body: '/leo msg Daniel hi', senderId: 'visitor' })).toBe(false);
    expect(await via({ surface: 'http', body: '🐶 leo: /leo msg Daniel hi', fromNode: 'n', fromBeing: 'leo' })).toBe(false);
    expect(posts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
  it('msgTo itself refuses an http origin, whoever sent it', async () => {
    const h = build(['daniel']);
    await h.run({ chatId: 'http:acme-abc', surface: 'http', body: '/msg daniel hi', commandBeing: 'leo', isSender: true });
    expect(h.posts).toHaveLength(0);
    expect(h.sent.at(-1).text).toMatch(/not from a chatbox/);
  });
  it("a being's line with any other command is still not run", async () => {
    const { via, posts } = build(['daniel']);
    for (const body of ['🐶 leo: /leo upgrade', '🐶 leo: /leo browser close all', '🐶 leo: /leo restart', '🐶 leo: /leo agents leo reset']) {
      expect(await via({ body, fromNode: 'n', fromBeing: 'leo' }), body).toBe(false);
    }
    expect(posts).toHaveLength(0);
  });
});
