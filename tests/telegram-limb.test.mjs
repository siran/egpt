// telegram-limb.test.mjs — the Telegram Bot API limb (src/bridges/telegram.mjs) over a fake fetch.
// No network, no real token: every Bot API call is answered by the fake below.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTelegramBridge, readTelegramToken, telegramTokenPath, isTelegramChatId, secretTag } from '../src/bridges/telegram.mjs';
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

const TOKEN = '123456:FAKE-bot-token-never-logged';
const ME = { id: 99, is_bot: true, username: 'edw_bot', can_read_all_group_messages: true };

function fakeApi({ me = ME } = {}) {
  const calls = [];
  const queue = [];
  let parked = null;
  let nextId = 500;
  let updateId = 1000;
  const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
  const err = (code, description, parameters) => ({ status: code, json: async () => ({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }) });
  const answers = {
    getMe: () => (typeof me === 'function' ? me() : ok(me)),
    sendMessage: (b) => ok({ message_id: nextId++, chat: { id: Number(b.chat_id) }, text: b.text }),
    editMessageText: () => ok(true),
    deleteMessage: () => ok(true),
    setMessageReaction: () => ok(true),
  };
  const fetch = async (url, init) => {
    const method = url.split('/').pop();
    calls.push({ url, method, body: JSON.parse(init.body) });
    if (method === 'getUpdates') {
      if (queue.length) return queue.shift();
      return new Promise((resolve, reject) => {
        parked = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return answers[method](JSON.parse(init.body));
  };
  const push = (r) => { if (parked) { const p = parked; parked = null; p(r); } else queue.push(r); };
  return {
    fetch, calls, answers, ok, err,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    lastUpdateId: () => updateId,
    pushError: (code, description, parameters) => push(err(code, description, parameters)),
    of: (method) => calls.filter((c) => c.method === method),
  };
}

function start(api, extra = {}) {
  const lines = [];
  const incoming = [];
  const bridge = startTelegramBridge({
    telegramToken: TOKEN, connection: 'main', fetch: api.fetch,
    isAllowedUser: (id, net) => net === 'telegram' && id === '42',
    wakeWords: ['ed'], nodeName: 'EDW',
    onIncoming: (body, from) => { incoming.push({ body, from }); },
    onLog: (m) => lines.push(m),
    ...extra,
  });
  return { bridge, lines, incoming };
}

const NOW_S = Math.floor(Date.now() / 1000);
const privateMsg = (over = {}) => ({ message_id: 7, date: NOW_S, chat: { id: 42, type: 'private', first_name: 'An', last_name: 'R' }, from: { id: 42, is_bot: false, first_name: 'An', last_name: 'R', username: 'anr' }, text: '@ed hola', ...over });
const groupMsg = (over = {}) => ({ message_id: 8, date: NOW_S, chat: { id: -1001234, type: 'supergroup', title: 'SI+EduWeb' }, from: { id: 77, is_bot: false, first_name: 'Diego' }, text: 'buenas', ...over });

describe('telegram limb — boot: getMe names the bot, never the token', () => {
  it('logs @username and polls; no line carries the token', async () => {
    const api = fakeApi();
    const { bridge, lines } = start(api);
    await bridge.startupReady;
    await vi.waitFor(() => expect(api.of('getUpdates')).toHaveLength(1));
    expect(lines.some((l) => l.includes('@edw_bot'))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(api.of('getUpdates')[0].body).toMatchObject({ offset: 0, timeout: 25, allowed_updates: ['message'] });
    bridge.stop();
  });

  it('a rejected token is named by length + sha only, and nothing polls', async () => {
    const api = fakeApi({ me: () => ({ status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }) });
    const { bridge, lines } = start(api);
    await bridge.startupReady;
    expect(lines.some((l) => l.includes(secretTag(TOKEN)))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(api.of('getUpdates')).toHaveLength(0);
    bridge.stop();
  });

  it('privacy mode ON is said at boot (with the @BotFather fix) and once at the first group message', async () => {
    const api = fakeApi({ me: { ...ME, can_read_all_group_messages: false } });
    const { bridge, lines } = start(api);
    await bridge.startupReady;
    expect(lines.filter((l) => /privacy mode ON/.test(l) && /@BotFather/.test(l) && /setprivacy/.test(l))).toHaveLength(1);
    api.updates(groupMsg(), groupMsg({ message_id: 9 }));
    await vi.waitFor(() => expect(lines.filter((l) => /first group message/.test(l))).toHaveLength(1));
    bridge.stop();
  });
});

describe('telegram limb — inbound', () => {
  it('a private text reaches the spine as a telegram message on chat tg:<id>', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(privateMsg());
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    const { body, from } = incoming[0];
    expect(body).toBe('@ed hola');
    expect(from).toMatchObject({
      chatId: 'tg:42', chatName: 'An R', chatType: 'private', network: 'telegram',
      userId: '42', senderName: 'An R', authorized: true, isSender: false,
      msgKey: '7', replyToId: null, replyToBot: false, backlog: false, atEAnywhere: true,
    });
    bridge.stop();
  });

  // contract 7.1
  it('authorization is networks.telegram.allowed_users by numeric id — anyone else is not authorized', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(groupMsg());
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].from).toMatchObject({ chatId: 'tg:-1001234', chatName: 'SI+EduWeb', chatType: 'group', userId: '77', authorized: false });
    bridge.stop();
  });

  it('a reply to the bot is replyToBot, carries its id, and names the quoted being from its frame', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    const quoted = { message_id: 5, from: { id: 99, is_bot: true }, text: `🐦 hi${encodeNodeSignature('EDW', 'ed')}` };
    api.updates(groupMsg({ text: 'and then?', reply_to_message: quoted }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].from).toMatchObject({ replyToId: '5', replyToBot: true, replyToBeing: 'ed', replyToNode: 'EDW' });
    bridge.stop();
  });

  it('/cmd@thisbot in a group is the command itself', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(groupMsg({ text: '/status@edw_bot now' }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].body).toBe('/status now');
    bridge.stop();
  });

  it('media: the caption passes with a "not handled yet" line; captionless media and channel posts deliver nothing', async () => {
    const api = fakeApi();
    const { bridge, incoming, lines } = start(api);
    await bridge.startupReady;
    api.updates(
      privateMsg({ text: undefined, photo: [{ file_id: 'p' }], caption: 'look' }),
      privateMsg({ message_id: 8, text: undefined, voice: { file_id: 'v' } }),
      { message_id: 9, date: NOW_S, chat: { id: -100555, type: 'channel', title: 'news' }, text: 'post' },
    );
    await vi.waitFor(() => expect(lines.filter((l) => /media not handled yet/.test(l))).toHaveLength(2));
    expect(incoming.map((m) => m.body)).toEqual(['look']);
    bridge.stop();
  });

  it('a message from before the wake window is backlog (recorded, never dispatched)', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(privateMsg({ date: NOW_S - 3600 }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].from.backlog).toBe(true);
    bridge.stop();
  });

  it('the offset advances past every update handled', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(privateMsg());
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    await vi.waitFor(() => expect(api.of('getUpdates')).toHaveLength(2));
    expect(api.of('getUpdates')[1].body.offset).toBe(api.lastUpdateId() + 1);
    bridge.stop();
  });
});

describe('telegram limb — polling never fights', () => {
  it('409 Conflict backs off (60s, then 120s), logs it, and never polls concurrently', async () => {
    const api = fakeApi();
    const delays = [];
    const { bridge, lines } = start(api, { setTimeout: (fn, ms) => { delays.push(ms); queueMicrotask(fn); return delays.length; }, clearTimeout: () => {} });
    await bridge.startupReady;
    api.pushError(409, 'Conflict: terminated by other getUpdates request');
    api.pushError(409, 'Conflict: terminated by other getUpdates request');
    await vi.waitFor(() => expect(api.of('getUpdates')).toHaveLength(3));
    expect(delays).toEqual([60_000, 120_000]);
    expect(lines.filter((l) => /409 Conflict/.test(l) && /not fighting/.test(l))).toHaveLength(2);
    bridge.stop();
  });

  it('a network failure retries with backoff; isAlive follows the poll', async () => {
    const api = fakeApi();
    const delays = [];
    const { bridge } = start(api, { setTimeout: (fn, ms) => { delays.push(ms); queueMicrotask(fn); return delays.length; }, clearTimeout: () => {} });
    await bridge.startupReady;
    api.pushError(502, 'Bad Gateway');
    await vi.waitFor(() => expect(api.of('getUpdates')).toHaveLength(2));
    expect(delays).toEqual([3_000]);
    api.updates();
    await vi.waitFor(() => expect(bridge.isAlive()).toBe(true));
    bridge.stop();
  });

  it('stop() ends the poll', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    await bridge.startupReady;
    await vi.waitFor(() => expect(api.of('getUpdates')).toHaveLength(1));
    bridge.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(api.of('getUpdates')).toHaveLength(1);
  });
});

describe('telegram limb — outbound', () => {
  // contract 4.5
  it('send posts to the bare chat id with reply_parameters, remembers it as ours, and refuses a non-telegram chat', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    const r = await bridge.send('hi', { chatId: 'tg:-1001234', replyToMessageID: '8' });
    expect(api.of('sendMessage')[0].body).toEqual({ chat_id: '-1001234', text: 'hi', reply_parameters: { message_id: 8, allow_sending_without_reply: true } });
    expect(r.messageId).toBe('500');
    expect(bridge.wasSentByUs('tg:-1001234', '500')).toBe(true);
    expect(bridge.wasSentByUs('tg:-1001234', '7')).toBe(false);
    expect(await bridge.send('hi', { chatId: '!room:beeper.local' })).toBeNull();
    expect(api.of('sendMessage')).toHaveLength(1);
    bridge.stop();
  });

  it('a long text goes out in chunks under the 4096 limit, only the first replying', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    await bridge.send('x'.repeat(9000), { chatId: 'tg:42', replyToMessageID: 3 });
    const sends = api.of('sendMessage');
    expect(sends.map((s) => s.body.text.length)).toEqual([4000, 4000, 1000]);
    expect(sends.map((s) => !!s.body.reply_parameters)).toEqual([true, false, false]);
    bridge.stop();
  });

  it('429 is retried once after retry_after', async () => {
    const api = fakeApi();
    let n = 0;
    const real = api.answers.sendMessage;
    api.answers.sendMessage = (b) => (n++ === 0 ? api.err(429, 'Too Many Requests: retry after 2', { retry_after: 2 }) : real(b));
    const delays = [];
    const { bridge } = start(api, { setTimeout: (fn, ms) => { delays.push(ms); queueMicrotask(fn); return 1; }, clearTimeout: () => {} });
    const r = await bridge.send('hi', { chatId: 'tg:42' });
    expect(r).toBeTruthy();
    expect(delays).toContain(2000);
    expect(api.of('sendMessage')).toHaveLength(2);
    bridge.stop();
  });

  it('a failed send is null and its reason is the chat\'s sendFailure', async () => {
    const api = fakeApi();
    api.answers.sendMessage = () => api.err(403, 'Forbidden: bot was kicked from the group chat');
    const { bridge } = start(api);
    expect(await bridge.send('hi', { chatId: 'tg:-5' })).toBeNull();
    expect(bridge.sendFailure('tg:-5')).toMatch(/kicked/);
    bridge.stop();
  });

  it('startStreamMessage: placeholder, throttled in-place edits, the final in the same message', async () => {
    const api = fakeApi();
    let clock = 10_000;
    const { bridge } = start(api, { now: () => clock });
    const h = bridge.startStreamMessage('⏳ Thinking…', { chatId: 'tg:42', replyToMessageID: '7' });
    h.update('par');          // first edit goes now
    h.update('parti');        // within 1s: held for the timer
    clock += 50;
    await h.finish('partial and final');
    expect(api.of('sendMessage')).toHaveLength(1);
    expect(api.of('sendMessage')[0].body.reply_parameters.message_id).toBe(7);
    const edits = api.of('editMessageText').map((c) => c.body);
    expect(edits.every((e) => e.message_id === 500 && e.chat_id === '42')).toBe(true);
    expect(edits.at(-1).text).toBe('partial and final');
    expect(edits.map((e) => e.text)).not.toContain('parti');
    expect(h.delivered).toBe(true);
    expect(h.confirmedId).toBe('500');
    bridge.stop();
  });

  it('a stream\'s delete removes its own placeholder (a Telegram delete leaves no tombstone)', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    const h = bridge.startStreamMessage('⏳', { chatId: 'tg:42' });
    expect(await h.delete()).toBe(true);
    expect(api.of('deleteMessage')[0].body).toEqual({ chat_id: '42', message_id: 500 });
    bridge.stop();
  });

  it('a failed final edit says so in place and stays undelivered', async () => {
    const api = fakeApi();
    let n = 0;
    api.answers.editMessageText = () => (n++ === 0 ? api.err(400, 'Bad Request: message to edit not found') : api.ok(true));
    const { bridge } = start(api);
    const h = bridge.startStreamMessage('⏳', { chatId: 'tg:42' });
    await h.finish('done');
    expect(h.delivered).toBe(false);
    expect(api.of('editMessageText').at(-1).body.text).toMatch(/^⚠️ could not deliver this reply/);
    bridge.stop();
  });

  it('edit treats "message is not modified" as done; react sets and clears one emoji; delete is deleteMessage', async () => {
    const api = fakeApi();
    api.answers.editMessageText = () => api.err(400, 'Bad Request: message is not modified');
    const { bridge } = start(api);
    expect(await bridge.editMessage('tg:42', '9', 'same')).toBe(true);
    expect(await bridge.sendReaction('tg:42', '9', '👍')).toBe(true);
    expect(await bridge.removeReaction('tg:42', '9', '👍')).toBe(true);
    expect(await bridge.deleteMessage('tg:42', '9')).toBe(true);
    expect(api.of('setMessageReaction').map((c) => c.body)).toEqual([
      { chat_id: '42', message_id: 9, reaction: [{ type: 'emoji', emoji: '👍' }] },
      { chat_id: '42', message_id: 9, reaction: [] },
    ]);
    expect(api.of('deleteMessage')[0].body).toEqual({ chat_id: '42', message_id: 9 });
    bridge.stop();
  });

  it('sendMedia is not handled yet: false, and nothing reaches the API', async () => {
    const api = fakeApi();
    const { bridge, lines } = start(api);
    expect(await bridge.sendMedia('tg:42', '/x.ogg', {})).toBe(false);
    expect(lines.some((l) => /media not handled yet/.test(l))).toBe(true);
    expect(api.calls.filter((c) => c.method !== 'getMe' && c.method !== 'getUpdates')).toHaveLength(0);
    bridge.stop();
  });
});

describe('telegram limb behind the shared port adapter (beeper-port createBeeperBridgePort, start injected)', () => {
  it('the port signs every send with the node layer and streams through the limb', async () => {
    const api = fakeApi();
    const port = await createBeeperBridgePort(
      { telegramToken: TOKEN, connection: 'main', fetch: api.fetch, nodeName: 'EDW', onLog: () => {} },
      { start: startTelegramBridge },
    );
    await port.send('tg:42', 'hi', { replyTo: '7' });
    const sent = api.of('sendMessage')[0].body;
    expect(sent.text.startsWith('hi')).toBe(true);
    expect(sent.text).toContain(encodeNodeSignature('EDW'));
    expect(sent.reply_parameters.message_id).toBe(7);
    const h = port.startStream('tg:42', '⏳ Thinking…', {});
    await h.finish('done');
    expect(h.delivered).toBe(true);
    expect(await port.postStatus('tg:42', 'status')).toBe('502');
    expect(await port.react('tg:42', '502', '👀')).toBe(true);
    port.stop();
  });
});

describe('telegram limb — ids and the token file', () => {
  it('ownership is the tg: prefix', () => {
    expect(isTelegramChatId('tg:-1001')).toBe(true);
    expect(isTelegramChatId('tg:42')).toBe(true);
    expect(isTelegramChatId('lobby')).toBe(false);
    expect(isTelegramChatId('aBcDeFgHiJkLmNoPqRsT')).toBe(false);
  });

  it('reads $EGPT_HOME/secrets/telegram-<connection>.token, trimmed; says missing, empty, and an open mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'egpt-tg-token-'));
    try {
      expect(telegramTokenPath(home, 'main')).toBe(join(home, 'secrets', 'telegram-main.token'));
      expect(readTelegramToken(home, 'main')).toMatchObject({ token: null, problem: 'missing' });
      const p = telegramTokenPath(home, 'main');
      mkdirSync(join(home, 'secrets'));
      writeFileSync(p, '  \n');
      expect(readTelegramToken(home, 'main')).toMatchObject({ token: null, problem: 'empty' });
      writeFileSync(p, `${TOKEN}\n`, { mode: 0o644 });
      expect(readTelegramToken(home, 'main', { platform: 'win32' })).toMatchObject({ token: TOKEN, warn: null });
      if (process.platform !== 'win32') expect(readTelegramToken(home, 'main').warn).toMatch(/expected 600/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
