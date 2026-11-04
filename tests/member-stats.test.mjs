// Per-member message metrics in the stats collector (operator 2026-10-16): length, response
// time, bursts, links, media, bot usage, client (via), plus the dedup, old-file, never-fatal
// and name-flap guarantees. All through recordMemberStat — the ONE per-message collector.
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import {
  recordMemberStat, messageFacts, mergeNameHistory, memberStyle,
  BURST_GAP_MS, RESPONSE_WINDOW_MS,
} from '../src/conversations-state.mjs';

const DIR = '/stats/whatsapp';
const norm = (p) => String(p).replace(/\\/g, '/');
function memIo(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [norm(k), v]));
  const io = {
    readFile: async (p) => { const k = norm(p); if (!files.has(k)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(k); },
    writeFile: async (p, d) => { files.set(norm(p), d); },
    mkdir: async () => {},
    rename: async (a, b) => { const f = norm(a), t = norm(b); if (files.has(f)) { files.set(t, files.get(f)); files.delete(f); } },
    existsSync: (p) => files.has(norm(p)),
    readdir: async (dir) => {
      const prefix = norm(dir).replace(/\/$/, '') + '/';
      return [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
    },
  };
  return { files, io };
}
const get = (files, base) => YAML.parse(files.get(`${DIR}/${base}`));
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
let seq = 0;
const msg = (over = {}) => ({
  kind: 'text', surface: 'whatsapp', chatId: '!c', chatName: 'Chat', senderId: '@a', senderName: 'Ana',
  msgId: `m${++seq}`, ts: T0, msgTs: T0, body: 'hola', mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
  replyToBeing: null, isSender: false, isVoice: false, fromNode: null, ...over,
});
const rec = (io, ev) => recordMemberStat('whatsapp', ev.chatId, ev.senderId, new Date(ev.ts).toISOString(),
  { io, statsDirOf: () => DIR, senderName: ev.senderName, chatName: ev.chatName, ev });

describe('messageFacts — what one event says, structurally', () => {
  it('typed length excludes media announcement lines; media counted by kind; links detected', () => {
    const f = messageFacts(msg({ body: 'mira https://x.io\n(image a.png) [saved: media/a.png]\n(document b.pdf) [saved: media/b.pdf]' }));
    expect(f.len).toBe('mira https://x.io'.length);
    expect(f.link).toBe(true);
    expect(f.media).toEqual({ image: 1, document: 1 });
  });
  it('a voice note counts as media.voice and adds no typed length', () => {
    const f = messageFacts(msg({ isVoice: true, body: '(voice transcription, 4s) hola qué tal' }));
    expect(f.media).toEqual({ voice: 1 });
    expect(f.len).toBe(0);
  });
  it('reactions and edits are not messages', () => {
    expect(messageFacts(msg({ kind: 'reaction' }))).toBe(null);
    expect(messageFacts(msg({ kind: 'edit' }))).toBe(null);
  });
  it('bot usage = addressed a being (mention, reply to a bot, reply to a being)', () => {
    expect(messageFacts(msg()).bot).toBe(false);
    expect(messageFacts(msg({ mention: { atEAnywhere: true } })).bot).toBe(true);
    expect(messageFacts(msg({ mention: { replyToBot: true } })).bot).toBe(true);
    expect(messageFacts(msg({ replyToBeing: 'e' })).bot).toBe(true);
  });
  it('via: only on the sender-account copy of a human send — ms precision = beeper, whole seconds = app', () => {
    expect(messageFacts(msg({ isSender: true, msgTs: T0 + 532 })).via).toBe('beeper');
    expect(messageFacts(msg({ isSender: true, msgTs: T0 })).via).toBe('app');
    expect(messageFacts(msg({ isSender: false, msgTs: T0 + 532 })).via).toBe(null);          // another account's copy
    expect(messageFacts(msg({ isSender: true, fromNode: 'kg', msgTs: T0 + 5 })).via).toBe(null);   // our own output
    expect(messageFacts(msg({ isSender: true, msgTs: null })).via).toBe(null);               // no payload timestamp
  });
  it('times by the message’s own timestamp (msgTs), falling back to ts', () => {
    expect(messageFacts(msg({ ts: T0 + 9000, msgTs: T0 })).at).toBe(T0);
    expect(messageFacts(msg({ ts: T0 + 9000, msgTs: null })).at).toBe(T0 + 9000);
  });
});

describe('recordMemberStat — per-member metrics in the chat file and the contact rollup', () => {
  it('bursts, response time, length, links, media and bot usage add up exactly', async () => {
    const { files, io } = memIo();
    const a = (dt, over = {}) => rec(io, msg({ senderId: '@a', senderName: 'Ana', msgTs: T0 + dt, ts: T0 + dt, ...over }));
    const b = (dt, over = {}) => rec(io, msg({ senderId: '@b', senderName: 'Beto', msgTs: T0 + dt, ts: T0 + dt, ...over }));
    await a(0, { body: 'uno' });                                   // burst 1 opens
    await a(60_000, { body: 'dos https://x.io' });                // same burst (1 min)
    await a(110_000, { body: '(image a.png) [saved: media/a.png]' });   // same burst; media only
    await b(140_000, { body: 'respuesta larga', mention: { atEAnywhere: true } });   // response after 30 s
    await a(140_000 + 7 * 3600_000, { body: 'tarde' });           // 7 h later: outside the window, new burst

    const chat = get(files, 'Chat.yaml');
    const A = chat.members['@a'];
    expect(A.count).toBe(4);
    expect(A.messages).toBe(4);
    expect(A.bursts).toBe(2);
    expect(A.msgs_per_burst).toBe(2);
    expect(A.texts).toBe(3);                                       // the media-only message has no typed text
    expect(A.chars).toBe('uno'.length + 'dos https://x.io'.length + 'tarde'.length);
    expect(A.avg_len).toBe(Math.round(A.chars / 3));
    expect(A.links).toBe(1);
    expect(A.media).toEqual({ image: 1 });
    expect(A.responses ?? 0).toBe(0);                              // 7 h is past RESPONSE_WINDOW_MS
    const B = chat.members['@b'];
    expect(B.responses).toBe(1);
    expect(B.response_ms).toBe(30_000);
    expect(B.avg_response_s).toBe(30);
    expect(B.bot).toBe(1);
    expect(chat.last_msg).toEqual({ sender_id: '@a', at: new Date(T0 + 140_000 + 7 * 3600_000).toISOString() });

    const contactA = get(files, 'Ana.yaml');                       // the rollup carries the same sums
    expect(contactA.messages).toBe(4);
    expect(contactA.bursts).toBe(2);
    expect(contactA.chars).toBe(A.chars);
    expect(contactA.media).toEqual({ image: 1 });
    expect(get(files, 'Beto.yaml').avg_response_s).toBe(30);
    expect(RESPONSE_WINDOW_MS).toBe(6 * 3600_000);
    expect(BURST_GAP_MS).toBe(2 * 60_000);
  });

  it('a duplicate arrival of the same message (same chat, same id) never counts twice', async () => {
    const { files, io } = memIo();
    const ev = msg({ msgId: 'dup-1', body: 'una vez' });
    expect(await rec(io, ev)).toBe(true);
    expect(await rec(io, { ...ev, ts: ev.ts + 400 })).toBe(false);   // second account/install, ~400 ms later
    const A = get(files, 'Chat.yaml').members['@a'];
    expect(A.count).toBe(1);
    expect(A.messages).toBe(1);
    expect(get(files, 'Ana.yaml').count).toBe(1);                  // the contact rollup skipped it too
  });

  it('reactions and edits keep bumping count but are not messages', async () => {
    const { files, io } = memIo();
    await rec(io, msg({ msgId: 'x1' }));
    await rec(io, msg({ msgId: 'x1', kind: 'reaction', body: '[reacted 👍 to #x1]' }));   // a reaction carries its TARGET id
    const A = get(files, 'Chat.yaml').members['@a'];
    expect(A.count).toBe(2);
    expect(A.messages).toBe(1);
  });

  it('via counts land on the member and its contact rollup', async () => {
    const { files, io } = memIo();
    await rec(io, msg({ isSender: true, msgTs: T0 + 1 }));
    await rec(io, msg({ isSender: true, msgTs: T0 + 1000 }));
    expect(get(files, 'Chat.yaml').members['@a'].via).toEqual({ beeper: 1, app: 1 });
    expect(get(files, 'Ana.yaml').via).toEqual({ beeper: 1, app: 1 });
  });

  it('an old file without the new fields loads and keeps its data', async () => {
    const old = YAML.stringify({ chat_id: '!c', name: 'Chat', members: { '@a': { name: 'Ana', count: 7, last_seen: 'T' } }, threads: [{ id: 'T1' }] });
    const { files, io } = memIo({ [`${DIR}/Chat.yaml`]: old, [`${DIR}/Ana.yaml`]: YAML.stringify({ sender_id: '@a', count: 7, last_seen: 'T', name: 'Ana' }) });
    await rec(io, msg());
    const chat = get(files, 'Chat.yaml');
    expect(chat.members['@a']).toMatchObject({ name: 'Ana', count: 8, messages: 1, bursts: 1 });
    expect(chat.threads).toEqual([{ id: 'T1' }]);
    expect(get(files, 'Ana.yaml')).toMatchObject({ count: 8, messages: 1 });
  });

  it('without an event the entry keeps exactly its old shape', async () => {
    const { files, io } = memIo();
    await recordMemberStat('whatsapp', '!c', '@a', 'T', { io, statsDirOf: () => DIR, senderName: 'Ana', chatName: 'Chat' });
    expect(get(files, 'Chat.yaml').members['@a']).toEqual({ name: 'Ana', count: 1, last_seen: 'T' });
  });

  it('never fatal: unreadable/garbage files and failing writes resolve, never throw', async () => {
    const io = {
      readFile: async () => '::: not yaml [',
      writeFile: async () => { throw new Error('disk full'); },
      mkdir: async () => {}, readdir: async () => [], existsSync: () => false, rename: async () => {},
    };
    await expect(rec(io, msg())).resolves.toBe(false);
    await expect(rec(io, msg({ body: null, msgTs: 'garbage', mention: null }))).resolves.toBe(false);
  });
});

describe('memberStyle — many short vs one long', () => {
  it('labels by documented thresholds, only with enough messages', () => {
    expect(memberStyle({ messages: 3, bursts: 1, avg_len: 10 })).toBe(undefined);
    expect(memberStyle({ messages: 20, bursts: 8, avg_len: 25 })).toBe('bursty');
    expect(memberStyle({ messages: 20, bursts: 18, avg_len: 300 })).toBe('long');
    expect(memberStyle({ messages: 20, bursts: 15, avg_len: 80 })).toBe('mixed');
  });
});

describe('name flap — an unresolved sender (raw id) is not a rename', () => {
  const RAW = '@whatsapp_lid-10000000000015:beeper.local';
  it('mergeNameHistory: a raw id never replaces a real name nor enters former_names', () => {
    expect(mergeNameHistory({ name: 'Rodz' }, RAW, 't1', { id: RAW })).toEqual({ name: 'Rodz' });
    expect(mergeNameHistory({ name: 'Rodz' }, '@other:beeper.com', 't1')).toEqual({ name: 'Rodz' });   // any bare raw id
    expect(mergeNameHistory({ name: RAW }, 'Rodz', 't2', { id: RAW })).toEqual({ name: 'Rodz' });      // raw → real: no history entry
    expect(mergeNameHistory({ name: 'Rodz' }, 'Rodrigo', 't3', { id: RAW })).toEqual({ name: 'Rodrigo', former_names: [{ name: 'Rodz', until: 't3' }] });
  });
  it('alternating Rodz / raw id leaves one file named Rodz with no former_names', async () => {
    const { files, io } = memIo();
    for (let i = 0; i < 6; i++) {
      await recordMemberStat('whatsapp', '!c', RAW, `T${i}`, { io, statsDirOf: () => DIR, senderName: i % 2 ? RAW : 'Rodz', chatName: 'Chat' });
    }
    const contact = get(files, 'Rodz.yaml');
    expect(contact.name).toBe('Rodz');
    expect(contact.count).toBe(6);
    expect('former_names' in contact).toBe(false);
    expect(get(files, 'Chat.yaml').members[RAW].name).toBe('Rodz');
    expect([...files.keys()].filter((k) => k.includes('whatsapp_lid'))).toEqual([]);   // never renamed to the raw id
  });
});
