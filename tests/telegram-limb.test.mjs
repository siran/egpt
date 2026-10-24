// telegram-limb.test.mjs — the Telegram Bot API limb (src/bridges/telegram.mjs) over a fake fetch.
// No network, no real token: every Bot API call is answered by the fake below.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
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
  const sentMedia = (b) => ok({ message_id: nextId++, chat: { id: Number(b.chat_id) } });
  for (const m of ['sendPhoto', 'sendVideo', 'sendVoice', 'sendAudio', 'sendDocument']) answers[m] = sentMedia;
  // getFile names a path; the file URL (GET, token in it) answers with `files[path]`.
  const files = {};
  answers.getFile = (b) => ok({ file_id: b.file_id, file_path: Object.keys(files).find((p) => p.includes(b.file_id)) ?? `x/${b.file_id}` });
  const downloads = [];
  const fetch = async (url, init) => {
    if (url.includes('/file/bot')) {
      downloads.push(url);
      const path = url.split(`/file/bot${TOKEN}/`)[1];
      if (!(path in files)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      if (files[path] instanceof Error) throw files[path];
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(files[path]).buffer };
    }
    const method = url.split('/').pop();
    const body = init.body instanceof FormData ? formFields(init.body) : JSON.parse(init.body);
    calls.push({ url, method, body, headers: init.headers ?? null });
    if (method === 'getUpdates') {
      if (queue.length) return queue.shift();
      return new Promise((resolve, reject) => {
        parked = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return answers[method](body);
  };
  const push = (r) => { if (parked) { const p = parked; parked = null; p(r); } else queue.push(r); };
  return {
    fetch, calls, answers, ok, err, files, downloads,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    raw: (...ups) => push(ok(ups.map((u) => ({ update_id: ++updateId, ...u })))),
    lastUpdateId: () => updateId,
    pushError: (code, description, parameters) => push(err(code, description, parameters)),
    of: (method) => calls.filter((c) => c.method === method),
  };
}

// A multipart body as plain fields; a file part as { name, type, size }.
function formFields(form) {
  const out = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size };
  return out;
}

function start(api, extra = {}) {
  const lines = [];
  const incoming = [];
  const bridge = startTelegramBridge({
    telegramToken: TOKEN, connection: 'main', fetch: api.fetch,
    isAllowedUser: (id, net) => net === 'telegram' && id === '42',
    wakeWords: ['ed'], nodeName: 'EDW',
    personaStamps: () => [{ being: 'lark', bodyEmoji: '🐦', label: 'Lark' }, { being: 'ed', bodyEmoji: '🦉', label: 'ED' }],
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
    expect(api.of('getUpdates')[0].body).toMatchObject({ offset: 0, timeout: 25, allowed_updates: ['message', 'edited_message', 'message_reaction'] });
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

  // No invisible frame on Telegram: the bot's message is known by its sender, its being by the visible stamp.
  it('a reply to the bot is replyToBot, carries its id, and names the quoted being from its visible stamp', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    const bot = { id: 99, is_bot: true };
    api.updates(
      groupMsg({ message_id: 20, text: 'and then?', reply_to_message: { message_id: 5, from: bot, text: '🌉 🦉 ED: hi, Lark said 🐦 Lark: no 💸' } }),
      groupMsg({ message_id: 21, text: 'ok', reply_to_message: { message_id: 6, from: bot, text: '📨 status line' } }),
      groupMsg({ message_id: 22, text: 'lol', reply_to_message: { message_id: 4, from: { id: 77 }, text: `🦉 ED: pasted${encodeNodeSignature('EDW', 'ed')}` } }),
    );
    await vi.waitFor(() => expect(incoming).toHaveLength(3));
    expect(incoming[0].from).toMatchObject({ replyToId: '5', replyToBot: true, replyToBeing: 'ed', replyToNode: 'EDW' });
    expect(incoming[1].from).toMatchObject({ replyToId: '6', replyToBot: true, replyToBeing: null, replyToNode: 'EDW' });
    expect(incoming[2].from).toMatchObject({ replyToId: '4', replyToBot: false, replyToBeing: null, replyToNode: null });
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

  it('channel posts deliver nothing', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates({ message_id: 9, date: NOW_S, chat: { id: -100555, type: 'channel', title: 'news' }, text: 'post' }, privateMsg());
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].body).toBe('@ed hola');
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

// Media goes through the same intake as Beeper's (src/bridges/limb-intake.mjs): onMedia saves it,
// the announce line names media/<file>, a voice note is two lines, and a bare name reply reads back.
describe('telegram limb — inbound media (the shared intake)', () => {
  const withDir = () => mkdtempSync(join(tmpdir(), 'egpt-tg-in-'));
  const saver = () => {
    const saved = [];
    return { saved, onMedia: async (m) => { saved.push(m); return `/conv/media/${m.kind}-${m.msgId}.${m.fileName?.split('.').pop() ?? 'bin'}`; } };
  };

  // contract 8.1
  it('a photo is downloaded (getFile + file URL), saved through onMedia, announced after its caption; the temp file is removed', async () => {
    const dir = withDir();
    try {
      const api = fakeApi();
      api.files['photos/p1.jpg'] = 'jpegbytes';
      const { saved, onMedia } = saver();
      const { bridge, incoming } = start(api, { onMedia, mediaDir: dir });
      await bridge.startupReady;
      api.updates(privateMsg({ text: undefined, photo: [{ file_id: 'small' }, { file_id: 'p1', file_size: 9 }], caption: 'look' }));
      await vi.waitFor(() => expect(incoming).toHaveLength(1));
      expect(api.of('getFile')[0].body).toEqual({ file_id: 'p1' });
      expect(saved[0]).toMatchObject({ chatID: 'tg:42', network: 'telegram', kind: 'image', mime: 'image/jpeg', caption: 'look', msgId: '7', isVoiceNote: false });
      expect(incoming[0].body).toBe('look\n(image) [saved: media/image-7.bin]');
      await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]));
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a captionless document is its announce line alone; whatsapp.media.download off saves and announces nothing', async () => {
    const dir = withDir();
    try {
      const api = fakeApi();
      api.files['documents/d1.pdf'] = 'pdf';
      const { saved, onMedia } = saver();
      const { bridge, incoming } = start(api, { onMedia, mediaDir: dir });
      await bridge.startupReady;
      api.updates(privateMsg({ text: undefined, document: { file_id: 'd1', file_name: 'plan.pdf', mime_type: 'application/pdf' } }));
      await vi.waitFor(() => expect(incoming).toHaveLength(1));
      expect(incoming[0].body).toBe('(document plan.pdf) [saved: media/document-7.pdf]');
      bridge.stop();

      const off = fakeApi();
      const o = start(off, { onMedia, media: { download: 'off' }, mediaDir: dir });
      await o.bridge.startupReady;
      off.updates(privateMsg({ text: undefined, document: { file_id: 'd1', file_name: 'plan.pdf', mime_type: 'application/pdf' }, caption: 'the plan' }));
      await vi.waitFor(() => expect(o.incoming).toHaveLength(1));
      expect(o.incoming[0].body).toBe('the plan');
      expect(off.of('getFile')).toHaveLength(0);
      expect(saved).toHaveLength(1);
      o.bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('over the Bot API\'s 20 MB: not downloaded, said once, the caption still passes; a failed download never logs the token', async () => {
    const dir = withDir();
    try {
      const api = fakeApi();
      api.files['videos/v1.mp4'] = new Error(`connect ECONNRESET https://api.telegram.org/file/bot${TOKEN}/videos/v1.mp4`);
      const { onMedia } = saver();
      const { bridge, incoming, lines } = start(api, { onMedia, mediaDir: dir });
      await bridge.startupReady;
      api.updates(
        privateMsg({ text: undefined, video: { file_id: 'big', file_size: 25 * 1024 * 1024 }, caption: 'huge' }),
        privateMsg({ message_id: 8, text: undefined, video: { file_id: 'v1', file_size: 10 }, caption: 'small' }),
      );
      await vi.waitFor(() => expect(incoming).toHaveLength(2));
      expect(incoming.map((m) => m.body).sort()).toEqual(['huge', 'small']);
      expect(lines.filter((l) => /over the Bot API's 20 MB/.test(l))).toHaveLength(1);
      expect(lines.some((l) => /video download failed/.test(l))).toBe(true);
      expect(lines.join('\n')).not.toContain(TOKEN);
      expect(api.of('getFile').map((c) => c.body.file_id)).toEqual(['v1']);
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // contract 8.3
  it('a voice note is two lines (arrival, then its transcription), the 👂 echo replies to it, the audio is saved with the transcript, 🎧 asked of the one placement', async () => {
    const dir = withDir();
    try {
      const api = fakeApi();
      api.files['voice/n1.oga'] = 'opus';
      const { saved, onMedia } = saver();
      const reacts = [];
      const outboundFor = (chatId) => ({
        keyOf: () => async () => ({ msgKey: null, timestamp: null }),
        react: async (msgId, emoji, keyOf, what, o = {}) => { reacts.push({ chatId, msgId, emoji, remove: !!o.remove }); return true; },
      });
      const transcribe = async (p, cfg, log, meta, listening) => {
        const off = await listening?.();
        meta.durationSec = 3;
        await off?.();
        return '@ed hola';
      };
      const { bridge, incoming } = start(api, {
        onMedia, mediaDir: dir, transcribe, outboundFor, postsBackDelayMs: 0,
        resolveTranscriptionService: async () => ({ enabled: true, postsBack: true, listeningReaction: true }),
      });
      await bridge.startupReady;
      api.updates(privateMsg({ text: undefined, voice: { file_id: 'n1', duration: 3, mime_type: 'audio/ogg' } }));
      await vi.waitFor(() => expect(incoming).toHaveLength(2));
      expect(incoming[0].body).toBe('(voice note, 3s — being transcribed…)');
      expect(incoming[0].from).toMatchObject({ voiceLine: 'arrival', isTranscriptFromVoice: false, voiceListening: true, msgKey: '7' });
      expect(incoming[0].from.voicePath).toContain(dir);
      expect(incoming[1].body).toBe('(voice transcription, 3s) @ed hola');
      expect(incoming[1].from).toMatchObject({ voiceLine: 'outcome', isTranscriptFromVoice: true, atEAnywhere: true });
      const echo = api.of('sendMessage').find((c) => c.body.text.startsWith('👂'));
      expect(echo.body.text).toBe('👂 An R (3s): @ed hola');   // no invisible frame (nodeName is set)
      expect(echo.body.reply_parameters.message_id).toBe(7);
      expect(saved[0]).toMatchObject({ kind: 'audio', isVoiceNote: true, caption: '@ed hola' });
      expect(reacts).toEqual([
        { chatId: 'tg:42', msgId: '7', emoji: '🎧', remove: false },
        { chatId: 'tg:42', msgId: '7', emoji: '🎧', remove: true },
      ]);
      await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]));
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // contract 8.4
  it('a bare name reply from the owner to a voice note posts its 👂 transcript from transcript.md and wakes no one', async () => {
    const api = fakeApi();
    const doc = 'An R@[An R].tg (14:32) #5: (voice transcription, 8s) hola que tal\n';
    const { bridge, incoming, lines } = start(api, { readTranscript: async (chatId, o) => (chatId === 'tg:42' && o.network === 'telegram' ? doc : null) });
    await bridge.startupReady;
    api.updates(privateMsg({ text: 'ed', reply_to_message: { message_id: 5, from: { id: 42 }, voice: { file_id: 'old' } } }));
    await vi.waitFor(() => expect(api.of('sendMessage')).toHaveLength(1));
    expect(api.of('sendMessage')[0].body).toMatchObject({ text: '👂 hola que tal', reply_parameters: { message_id: 5 } });
    await vi.waitFor(() => expect(lines.some((l) => /👂 transcript sent/.test(l))).toBe(true));
    expect(incoming).toEqual([]);
    bridge.stop();
  });

  // contract 8.4
  it('a bare name reply to a text, with a voice service: 🔊 reading…, the piper audio as a voice note replying to it, the ack deleted', async () => {
    const api = fakeApi();
    const synthesize = vi.fn(async () => Buffer.from('OggS'));
    const { bridge, incoming } = start(api, { synthesize, voice: 'es_MX', readTranscript: async () => '' });
    await bridge.startupReady;
    api.updates(privateMsg({ text: '@ed', reply_to_message: { message_id: 6, from: { id: 77 }, text: 'lee esto' } }));
    await vi.waitFor(() => expect(api.of('deleteMessage')).toHaveLength(1));
    expect(synthesize.mock.calls[0][0]).toBe('lee esto');
    expect(api.of('sendMessage')[0].body).toMatchObject({ text: '🔊 reading…', reply_parameters: { message_id: 6 } });
    const v = api.of('sendVoice')[0].body;
    expect(JSON.parse(v.reply_parameters).message_id).toBe(6);
    expect(v.voice.type).toBe('audio/ogg');
    expect(api.of('deleteMessage')[0].body).toEqual({ chat_id: '42', message_id: 500 });
    expect(incoming).toEqual([]);
    bridge.stop();
  });

  it('a bare name reply from someone not allowed is an ordinary message (no readback)', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api, { readTranscript: async () => 'x #5: (voice transcription) hola\n' });
    await bridge.startupReady;
    api.updates(groupMsg({ text: 'ed', reply_to_message: { message_id: 5, from: { id: 1 }, voice: { file_id: 'o' } } }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].body).toBe('ed');
    expect(api.of('sendMessage')).toHaveLength(0);
    bridge.stop();
  });
});

// Human reactions and edits are input, as on Beeper (dispatch-line reactionAction / editAction).
describe('telegram limb — inbound reactions and edits', () => {
  const reaction = (over = {}) => ({ message_reaction: { chat: { id: 42, type: 'private', first_name: 'An', last_name: 'R' }, message_id: 7, user: { id: 42, first_name: 'An', last_name: 'R' }, date: NOW_S, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }], ...over } });

  it('a new reaction is "reacted 👍 to #7 …" naming the target text, isReaction, authorized by the reactor\'s id', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(privateMsg({ text: 'nos vemos mañana' }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    api.raw(reaction());
    await vi.waitFor(() => expect(incoming).toHaveLength(2));
    expect(incoming[1].body).toBe('reacted 👍 to #7 "nos vemos mañana"');
    expect(incoming[1].from).toMatchObject({ chatId: 'tg:42', isReaction: true, authorized: true, msgKey: '7', userId: '42', replyToBot: false });
    bridge.stop();
  });

  it('a reaction to the bot\'s own message is replyToBot and names the being from its stamp; a removed or unchanged one, and an old one, are not input', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    const r = await bridge.send(`🐦 Lark: hola${encodeNodeSignature('EDW', 'lark')}`, { chatId: 'tg:42' });
    api.raw(
      reaction({ message_id: Number(r.messageId), user: { id: 77, first_name: 'Diego' } }),
      reaction({ old_reaction: [{ type: 'emoji', emoji: '👍' }], new_reaction: [] }),
      reaction({ message_id: 3, date: NOW_S - 3600 }),
      reaction({ message_id: 4, new_reaction: [{ type: 'custom_emoji', custom_emoji_id: 'x' }] }),
    );
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    await new Promise((res) => setTimeout(res, 20));
    expect(incoming).toHaveLength(1);
    expect(incoming[0].body).toBe(`reacted 👍 to #${r.messageId} "🐦 Lark: hola"`);
    expect(api.of('sendMessage')[0].body.text).toBe('🐦 Lark: hola');
    expect(incoming[0].from).toMatchObject({ replyToBot: true, replyToBeing: 'lark', replyToNode: 'EDW', authorized: false });
    bridge.stop();
  });

  it('an edit of a message seen is "edited #id" with old and new text, a stage direction; one never seen is recorded, not surfaced', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(privateMsg({ text: 'imbécil' }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    api.raw(
      { edited_message: privateMsg({ text: 'pobrecito', edit_date: NOW_S }) },
      { edited_message: privateMsg({ message_id: 99, text: 'never seen', edit_date: NOW_S }) },
    );
    await vi.waitFor(() => expect(incoming).toHaveLength(2));
    await new Promise((res) => setTimeout(res, 20));
    expect(incoming).toHaveLength(2);
    expect(incoming[1].body).toBe('edited #7\n    - imbécil\n    + pobrecito');
    expect(incoming[1].from).toMatchObject({ isStageDirection: true, isReaction: false, atEAnywhere: false, authorized: true, msgKey: '7' });
    bridge.stop();
  });

  it('the raw edit hook (the mesh mirror) consumes an edit before it is surfaced', async () => {
    const api = fakeApi();
    const seen = [];
    const { bridge, incoming } = start(api, { onMessageEdit: async (...a) => { seen.push(a); return true; } });
    await bridge.startupReady;
    api.updates(privateMsg({ text: 'a' }));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    api.raw({ edited_message: privateMsg({ text: 'b', edit_date: NOW_S }) });
    await vi.waitFor(() => expect(seen).toEqual([['tg:42', '7', 'b', 'a']]));
    expect(incoming).toHaveLength(1);
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

  it('a reaction Telegram refuses (not in the bot set) is logged once per emoji and skipped after — never text', async () => {
    const api = fakeApi();
    api.answers.setMessageReaction = (b) => (b.reaction[0]?.emoji === '🎧' ? api.err(400, 'Bad Request: REACTION_INVALID') : api.ok(true));
    const { bridge, lines } = start(api);
    expect(await bridge.sendReaction('tg:42', '9', '🎧')).toBe(false);
    expect(await bridge.sendReaction('tg:42', '10', '🎧')).toBe(false);
    expect(await bridge.sendReaction('tg:-5', '3', '🎧')).toBe(false);
    expect(await bridge.sendReaction('tg:42', '11', '👀')).toBe(true);
    expect(lines.filter((l) => /refuses 🎧/.test(l))).toHaveLength(1);
    expect(api.of('setMessageReaction').map((c) => `${c.body.chat_id}/${c.body.message_id}`)).toEqual(['42/9', '-5/3', '42/11']);
    expect(api.of('sendMessage')).toHaveLength(0);
    bridge.stop();
  });

  it('sendMedia uploads multipart: photo, video, mp3 audio, an .ogg as a voice note, anything else a document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tg-media-'));
    try {
      const api = fakeApi();
      const { bridge } = start(api);
      const files = ['a.jpg', 'b.mp4', 'c.mp3', 'd.ogg', 'e.pdf', 'f.wav'].map((n) => { const p = join(dir, n); writeFileSync(p, 'bytes'); return p; });
      const results = [];
      for (const f of files) results.push(await bridge.sendMedia('tg:42', f, { caption: f.endsWith('a.jpg') ? 'look' : null, replyTo: f.endsWith('d.ogg') ? '7' : null }));
      expect(api.calls.filter((c) => c.method.startsWith('send')).map((c) => c.method)).toEqual(['sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument', 'sendDocument']);
      const [photo, , , voice] = api.calls.filter((c) => c.method.startsWith('send'));
      expect(photo.body).toMatchObject({ chat_id: '42', caption: 'look', photo: { name: 'a.jpg', type: 'image/jpeg', size: 5 } });
      expect(photo.headers).toBeNull();
      expect(voice.body).toMatchObject({ chat_id: '42', voice: { name: 'd.ogg', type: 'audio/ogg' } });
      expect(JSON.parse(voice.body.reply_parameters)).toEqual({ message_id: 7, allow_sending_without_reply: true });
      expect(results.every((r) => r?.ok === true)).toBe(true);
      expect(bridge.wasSentByUs('tg:42', results[3].confirmedId)).toBe(true);
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('sendMedia: a caption over the limit follows as a text reply; a refused upload is false with its reason, token scrubbed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tg-media-'));
    try {
      const api = fakeApi();
      const { bridge, lines } = start(api);
      const p = join(dir, 'x.png'); writeFileSync(p, 'png');
      const r = await bridge.sendMedia('tg:42', p, { caption: 'c'.repeat(1500) });
      const photo = api.of('sendPhoto')[0];
      expect(photo.body.caption).toBeUndefined();
      expect(api.of('sendMessage')[0].body).toMatchObject({ text: 'c'.repeat(1500), reply_parameters: { message_id: Number(r.messageId) } });
      api.answers.sendPhoto = () => api.err(413, `Request Entity Too Large ${TOKEN}`);
      expect(await bridge.sendMedia('tg:42', p, {})).toBe(false);
      expect(bridge.sendFailure('tg:42')).toMatch(/Too Large/);
      expect(lines.join('\n')).not.toContain(TOKEN);
      expect(await bridge.sendMedia('!room:beeper.local', p, {})).toBe(false);
      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a reaction emoji is sent without U+FE0F (Telegram\'s set spells the heart bare)', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    await bridge.sendReaction('tg:42', '9', '❤️');
    expect(api.of('setMessageReaction')[0].body.reaction).toEqual([{ type: 'emoji', emoji: '❤' }]);
    bridge.stop();
  });
});

// Telegram deleted two groups the bot posted in (2026-10-24); hidden text is a spam signal. So no
// Telegram send or edit carries an invisible character: no structural frame, no zero-width, no BOM,
// no bidi control. The visible stamp and the visible bridge layers stay; emoji stay intact.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200B\u200C\u2060-\u2064\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const textsOut = (api) => api.calls.flatMap((c) => [c.body?.text, c.body?.caption]).filter((t) => typeof t === 'string');

describe('telegram limb behind the shared port adapter (beeper-port createBeeperBridgePort, start injected)', () => {
  const portOn = (api, extra = {}) => createBeeperBridgePort(
    { telegramToken: TOKEN, connection: 'main', fetch: api.fetch, nodeName: 'EDW', bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸', onLog: () => {}, ...extra },
    { start: startTelegramBridge },
  );
  const ed = { persona: 'ed', bodyEmoji: '🦉', label: 'ED' };

  it('REPRODUCE-FIRST: a persona send carries the visible stamp and layers, and no invisible character', async () => {
    const api = fakeApi();
    const port = await portOn(api);
    await port.send('tg:42', 'hola\u200B mundo\u2060', { ...ed, replyTo: '7' });
    const sent = api.of('sendMessage')[0].body;
    expect(sent.text).toBe('🌉 🦉 ED: hola mundo 💸');
    expect(sent.text).not.toMatch(INVISIBLE);
    expect(sent.reply_parameters.message_id).toBe(7);
    port.stop();
  });

  it('every outbound path is clean: stream placeholder + edits, status, editOwn, caption, verbatim, raw edit, canary, skipSignature, a public being', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tg-clean-'));
    try {
      const api = fakeApi();
      const port = await portOn(api, { plainOf: (b) => b === 'pub' });
      const tagged = `🦉 ED: from the peer${encodeNodeSignature('kg', 'e')}\u200E`;
      const h = port.startStream('tg:42', '⏳ Thinking…', ed);
      h.update('a\u2060b');
      await h.finish('final ❤️‍🔥 👩🏽‍💻 1️⃣\uFEFF');
      const id = await port.postStatus('tg:42', '📨 status\u200C');
      await port.editStatus('tg:42', id, '📨 done\u202E');
      await port.editOwn('tg:42', id, 'fixed\u2066', ed);
      const p = join(dir, 'a.png'); writeFileSync(p, 'png');
      await port.sendMedia('tg:42', p, { ...ed, caption: 'look\u200B' });
      await port.postVerbatim('tg:42', tagged);
      const v = port.startStreamVerbatim('tg:42', tagged);
      await v.finish(`${tagged} more`);
      await port.editMessage('tg:42', id, `marker${encodeNodeSignature('EDW')}`);
      await port.send('tg:42', 'opener', { ...ed, canary: { group: 'g1', origin: 'o1' } });
      await port.send('tg:42', 'as the operator', { skipSignature: true });
      await port.send('tg:42', 'public text\u200B', { persona: 'pub' });
      const out = textsOut(api);
      expect(out.length).toBeGreaterThanOrEqual(12);
      for (const t of out) expect(t).not.toMatch(INVISIBLE);
      expect(out).toContain('🌉 🦉 ED: ⏳ Thinking… 💸');
      expect(out).toContain('🌉 🦉 ED: final ❤️‍🔥 👩🏽‍💻 1️⃣ 💸');
      expect(out).toContain('🌉 🦉 ED: look 💸');
      expect(out).toContain('🦉 ED: from the peer');
      expect(out).toContain('public text');
      expect(port.renderFrame(ed, 'x\u200B')).toBe('🌉 🦉 ED: x 💸');
      port.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the port still streams through the limb and reacts', async () => {
    const api = fakeApi();
    const port = await portOn(api);
    const h = port.startStream('tg:42', '⏳ Thinking…', {});
    await h.finish('done');
    expect(h.delivered).toBe(true);
    expect(await port.postStatus('tg:42', 'status')).toBe('501');
    expect(await port.react('tg:42', '501', '👀')).toBe(true);
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
