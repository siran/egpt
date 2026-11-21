// ONE ACCUM FOR A CHAT AND ITS SI+ SIDE GROUP (operator 2026-11-20).
//
//   "reply_in_side_group... E's accum should grow from original group and the side group; it's a
//    same thread but replying in other group; same folder, files, etc. split is another thread in
//    the same folder, another group; separate accum"
//
// The accum (mode accum: "what was said since your last turn") read ONE transcript per surface (the
// 2026-10-03 rule for /join side-rooms): the SI+ group its own transcript-SI+<name>.md, the original
// transcript.md. But the side group is the SAME conversation replying in another group — a turn woken
// in the original posts its reply in the SI+ group, and a turn woken in the SI+ group logs its reply in
// that group's file — so neither file held the being's last turn (no boundary: the whole tail again and
// again) and neither saw what was said in the other group. Now a turn woken in either reads BOTH files'
// lines since the being's last turn, in time order, each line keeping its own group's name.
//
// Told apart in state: the side group is an ALIAS marked `automatic: true` (aliasOf → the chat). A
// /join room is an alias without it; a /split is its own entry (parent_chat). Those two keep their own.
import { describe, it, expect } from 'vitest';
import { basename, dirname } from 'node:path';
import { Room } from '../src/room-core.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createAccumReader } from '../src/spine/accum.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { accumChatsOf, forkContact } from '../src/conversations-state.mjs';
import { formatDispatchLine } from '../src/dispatch-line.mjs';
import { contextSinceLastTurn, joinTranscripts, replyLine } from '../src/transcript-log.mjs';

const at = (day, h, m) => Date.UTC(2026, 10, day, h, m);
const line = (who, chat, ts, body, id = null) => formatDispatchLine({ senderName: who, chatName: chat, node: 'wa', body, ts, msgId: id });
const blocksOf = (text) => String(text).split(/\n{2,}/).filter(Boolean);
const NOW = at(20, 10, 30);

describe('joinTranscripts: the lines of several transcripts, in time order', () => {
  it('REPRODUCE: two files interleave by their HH:MM, each line keeping the group it was said in', () => {
    const a = [line('Lola', 'grupo', at(20, 10, 1), 'a1', 1), line('Lola', 'grupo', at(20, 10, 5), 'a2', 2), line('Lola', 'grupo', at(20, 10, 9), 'a3', 3)].join('\n\n');
    const b = [line('Pepe', 'SI+grupo', at(20, 10, 3), 'b1', 7), line('Pepe', 'SI+grupo', at(20, 10, 7), 'b2', 8)].join('\n\n');
    const got = blocksOf(joinTranscripts([{ text: a }, { text: b }], { now: NOW }));
    expect(got.map((l) => l.replace(/^.*?: /, ''))).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    expect(got[0]).toContain('@[grupo].wa');
    expect(got[1]).toContain('@[SI+grupo].wa');
    expect(blocksOf(joinTranscripts([{ text: b }, { text: a }], { now: NOW }))).toEqual(got);   // the order of the sources is no one's
  });

  it('an entry of several paragraphs, a stage direction and the front matter come through whole', () => {
    const [a1, a2] = [line('Lola', 'grupo', at(20, 10, 1), 'a1', 1), line('Lola', 'grupo', at(20, 10, 5), 'primer párrafo', 2)];
    const more = 'segundo párrafo, sin cabecera', stage = '[ Lola@[grupo].wa (10:06): reacted 👍 to #7 ]';
    const b1 = line('Pepe', 'SI+grupo', at(20, 10, 3), 'b1', 7);
    const a = `---\nname: grupo\nsurface: whatsapp\n---\n\n${[a1, a2, more, stage].join('\n\n')}`;
    expect(blocksOf(joinTranscripts([{ text: a }, { text: b1 }], { now: NOW }))).toEqual([a1, b1, a2, more, stage]);
  });

  it('REPRODUCE: the boundary is the being\'s last reply in EITHER file; what follows it, from both, is the gap', () => {
    const a = [line('Lola', 'grupo', at(20, 10, 1), 'a1'), line('Lola', 'grupo', at(20, 10, 6), 'a2'), line('Lola', 'grupo', at(20, 10, 12), 'a3')].join('\n\n');
    const b = [line('Pepe', 'SI+grupo', at(20, 10, 2), 'b1'), replyLine({ being: 'egpt', body: 'respuesta', chatName: 'SI+grupo', node: 'wa', now: new Date(at(20, 10, 4)) }), line('Pepe', 'SI+grupo', at(20, 10, 8), 'b2')].join('\n\n');
    const joined = joinTranscripts([{ text: a }, { text: b }], { being: ['egpt'], now: NOW });
    expect(contextSinceLastTurn(joined, { being: ['egpt'] }).blocks.map((l) => l.replace(/^.*?: /, ''))).toEqual(['a2', 'b2', 'a3']);
  });

  it('a line of the other file in the same minute as the being\'s reply is after it: told twice at worst, never lost', () => {
    const a = replyLine({ being: 'egpt', body: 'respuesta', chatName: 'grupo', node: 'wa', now: new Date(at(20, 10, 5)) });
    const b = [line('Pepe', 'SI+grupo', at(20, 10, 5), 'b1'), line('Pepe', 'SI+grupo', at(20, 10, 5), 'b2')].join('\n\n');
    for (const sources of [[{ text: a }, { text: b }], [{ text: b }, { text: a }]]) {
      const joined = joinTranscripts(sources, { being: ['egpt'], now: NOW });
      expect(contextSinceLastTurn(joined, { being: ['egpt'] }).blocks.map((l) => l.replace(/^.*?: /, ''))).toEqual(['b1', 'b2']);
    }
  });

  it('midnight between the lines: the day each line is on is worked back from the clock, and said where it changes', () => {
    const a = [line('Lola', 'grupo', at(19, 23, 50), 'antes', 1), line('Lola', 'grupo', at(20, 0, 10), 'después', 2)].join('\n\n');
    const b = line('Pepe', 'SI+grupo', at(20, 0, 5), 'medianoche', 7);
    expect(blocksOf(joinTranscripts([{ text: a }, { text: b }], { now: at(20, 0, 20) })).map((l) => l.replace(/^.*?: /, ''))).toEqual(['antes', '[ 2026-11-20 ]', 'medianoche', 'después']);
  });

  it('a day marker in a file says the day outright: a stale file is not taken for today', () => {
    const stale = `[ 2026-11-18 ]\n\n${line('Lola', 'grupo', at(18, 9, 0), 'martes-a', 1)}\n\n${line('Lola', 'grupo', at(18, 22, 0), 'martes-b', 2)}`;
    const other = `[ 2026-11-18 ]\n\n${line('Pepe', 'SI+grupo', at(18, 10, 0), 'martes-c', 7)}`;
    expect(blocksOf(joinTranscripts([{ text: stale }, { text: other }], { now: NOW })).filter((l) => !l.startsWith('[')).map((l) => l.replace(/^.*?: /, ''))).toEqual(['martes-a', 'martes-c', 'martes-b']);
  });

  it('a file\'s last write dates its last line: a quiet group\'s old line is not taken for today\'s', () => {
    const quiet = line('Pepe', 'SI+grupo', at(17, 8, 0), 'hace tres días', 7);
    const busy = line('Lola', 'grupo', at(20, 7, 0), 'hoy', 1);
    const order = (sources) => blocksOf(joinTranscripts(sources, { now: NOW })).filter((l) => !l.startsWith('[')).map((l) => l.replace(/^.*?: /, ''));
    expect(order([{ text: busy }, { text: quiet, at: at(17, 8, 30) }])).toEqual(['hace tres días', 'hoy']);
    expect(order([{ text: busy }, { text: quiet }])).toEqual(['hoy', 'hace tres días']);   // no mtime: the clock's day, the only guess
  });

  it('a line stamped a minute before the one above it (a late delivery) is not a midnight', () => {
    const a = [line('Lola', 'grupo', at(20, 10, 6), 'uno', 1), line('Lola', 'grupo', at(20, 10, 5), 'dos', 2)].join('\n\n');
    expect(blocksOf(joinTranscripts([{ text: a }, { text: line('Pepe', 'SI+grupo', at(20, 10, 7), 'tres', 7) }], { now: NOW })).map((l) => l.replace(/^.*?: /, ''))).toEqual(['uno', 'dos', 'tres']);
  });

  it('one source, or none readable: its own lines, or nothing', () => {
    const a = [line('Lola', 'grupo', at(20, 10, 1), 'a1'), line('Lola', 'grupo', at(20, 10, 2), 'a2')].join('\n\n');
    expect(blocksOf(joinTranscripts([{ text: a }], { now: NOW })).map((l) => l.replace(/^.*?: /, ''))).toEqual(['a1', 'a2']);
    expect(joinTranscripts([{ text: null }, { text: '' }], { now: NOW })).toBe('');
    expect(blocksOf(joinTranscripts([{ text: null }, { text: a }], { now: NOW }))).toHaveLength(2);
  });
});

// ── told apart in state ──────────────────────────────────────────────────────────────────────────
const PRIMARY = 'chat-1', SIDE = 'chat-2', SIDE2 = 'chat-3', JOIN = 'chat-4', SPLIT = 'chat-5', ALONE = 'chat-6', SPLIT_SIDE = 'chat-7';
const stateWith = ({ splitSide = true } = {}) => {
  const st = {
    contacts: {
      whatsapp: {
        [PRIMARY]: { slug: 'grupo', pushedName: 'grupo', agents: { e: { threadId: 't1' } } },
        [SIDE]: { aliasOf: PRIMARY, automatic: true, transcript: 'SI+grupo' },
        [SIDE2]: { aliasOf: PRIMARY, automatic: true, transcript: 'SI+grupo-nu' },
        [JOIN]: { aliasOf: PRIMARY, transcript: 'join-room' },
        [ALONE]: { slug: 'solo', pushedName: 'solo' },
      },
    },
  };
  const forked = forkContact(st, 'whatsapp', SPLIT, PRIMARY, { pushedName: 'SI+grupo-viaje', transcript: 'si-grupo-viaje' });
  if (splitSide) forked.contacts.whatsapp[SPLIT_SIDE] = { aliasOf: SPLIT, automatic: true, transcript: 'SI+viaje' };
  return forked;
};

describe('accumChatsOf: which chats\' transcripts make one accum', () => {
  const of = (id, state = stateWith()) => accumChatsOf(state, 'whatsapp', id);

  it('REPRODUCE: the chat and its side group(s) — whichever of them the turn woke in comes first', () => {
    expect(of(PRIMARY)).toEqual([PRIMARY, SIDE, SIDE2]);
    expect(of(SIDE)).toEqual([SIDE, PRIMARY, SIDE2]);
    expect(of(SIDE2)).toEqual([SIDE2, PRIMARY, SIDE]);
  });

  it('a /join room (an alias that is not automatic) and a /split (another thread) keep their own accum', () => {
    expect(of(JOIN)).toEqual([JOIN]);
    expect(of(SPLIT, stateWith({ splitSide: false }))).toEqual([SPLIT]);
  });

  it('a /split with a side group of its own is one thread with that group, and not with its parent', () => {
    expect(of(SPLIT_SIDE)).toEqual([SPLIT_SIDE, SPLIT]);
    expect(of(SPLIT)).toEqual([SPLIT, SPLIT_SIDE]);
    expect(of(PRIMARY)).not.toContain(SPLIT);
  });

  it('a chat with no side group, an unknown one, and a missing one: its own', () => {
    expect(of(ALONE)).toEqual([ALONE]);
    expect(of('nobody')).toEqual(['nobody']);
    expect(accumChatsOf({}, 'whatsapp', PRIMARY)).toEqual([PRIMARY]);
  });
});

// ── the reader: the files of those chats ─────────────────────────────────────────────────────────
function world({ state = stateWith(), statWorks = true } = {}) {
  const files = new Map();
  const mtimes = new Map();
  const clock = { t: NOW };
  let st = state;
  const contacts = createContacts({ loadState: async () => st, writeState: async (s) => { st = s; }, io: { rename: async () => {}, appendFile: async () => {} } });
  const io = {
    appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); mtimes.set(p, clock.t); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
    // the stats writer (recordMemberStat) too: else it reaches the real fs under EGPT_HOME
    readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, String(d)); },
    readdir: async (d) => [...files.keys()].filter((f) => dirname(f) === d).map((f) => basename(f)),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
  const reader = createAccumReader({
    contacts, surfaceOf: (n) => n, readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    stat: statWorks ? async (p) => { if (!mtimes.has(p)) throw new Error('ENOENT'); return { mtimeMs: mtimes.get(p) }; } : null,
    now: () => clock.t,
  });
  const pathOf = (key) => Room.forChat('whatsapp', 'grupo').transcriptPathFor(key);
  const read = (chatId, chatName, extra = {}) => reader(chatId, { chatName, network: 'whatsapp', ...extra });
  return { files, mtimes, clock, contacts, reader, read, io, pathOf, state: () => st };
}
const put = (w, key, ...lines) => { const p = w.pathOf(key); w.files.set(p, lines.join('\n\n') + '\n\n'); w.mtimes.set(p, NOW); };
const bodies = (text) => blocksOf(text).map((l) => l.replace(/^.*?: /, ''));

describe('createAccumReader: the text one accum reads for a chat', () => {
  it('REPRODUCE: a turn in the chat reads its own file and the side group\'s, joined', async () => {
    const w = world();
    put(w, null, line('Lola', 'grupo', at(20, 10, 1), 'uno', 1), line('Lola', 'grupo', at(20, 10, 5), 'tres', 2));
    put(w, 'SI+grupo', line('Pepe', 'SI+grupo', at(20, 10, 3), 'dos', 7));
    expect(bodies(await w.read(PRIMARY, 'grupo'))).toEqual(['uno', 'dos', 'tres']);
  });

  it('REPRODUCE: a turn in the side group reads the same two files, and every other side group of the chat', async () => {
    const w = world();
    put(w, null, line('Lola', 'grupo', at(20, 10, 1), 'uno', 1));
    put(w, 'SI+grupo', line('Pepe', 'SI+grupo', at(20, 10, 3), 'dos', 7));
    put(w, 'SI+grupo-nu', line('Nuria', 'SI+grupo-nu', at(20, 10, 4), 'tres', 9));
    expect(bodies(await w.read(SIDE, 'SI+grupo'))).toEqual(['uno', 'dos', 'tres']);
  });

  it('a side group that has not been written yet is nothing, not a failure', async () => {
    const w = world();
    put(w, null, line('Lola', 'grupo', at(20, 10, 1), 'uno', 1));
    expect(bodies(await w.read(PRIMARY, 'grupo'))).toEqual(['uno']);
  });

  it('REPRODUCE (the 2026-10-03 rule, kept): a /join room, a /split and a chat with no side group have no joined accum', async () => {
    const w = world({ state: stateWith({ splitSide: false }) });
    put(w, null, line('Lola', 'grupo', at(20, 10, 1), 'uno', 1));
    put(w, 'SI+grupo', line('Pepe', 'SI+grupo', at(20, 10, 3), 'dos', 7));
    for (const id of [JOIN, SPLIT, ALONE]) expect(await w.read(id, 'x')).toBe(null);
  });

  it('the group a turn woke in names no other group: the chat keeps its folder and its name', async () => {
    const w = world();
    put(w, null, line('Lola', 'grupo', at(20, 10, 1), 'uno', 1));
    await w.read(SIDE, 'SI+grupo');
    await w.read(PRIMARY, 'grupo');
    expect(w.state().contacts.whatsapp[PRIMARY]).toMatchObject({ slug: 'grupo', pushedName: 'grupo' });
    expect(w.state().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: PRIMARY, automatic: true, transcript: 'SI+grupo' });
  });

  it('the files\' last writes date their last lines (no stat seam: the clock\'s day)', async () => {
    for (const statWorks of [true, false]) {
      const w = world({ statWorks });
      put(w, null, line('Lola', 'grupo', at(20, 7, 0), 'hoy', 1));
      put(w, 'SI+grupo', line('Pepe', 'SI+grupo', at(17, 8, 0), 'hace tres días', 7));
      w.mtimes.set(w.pathOf('SI+grupo'), at(17, 8, 30));
      expect(bodies(await w.read(PRIMARY, 'grupo')).filter((b) => !b.startsWith('['))).toEqual(statWorks ? ['hace tres días', 'hoy'] : ['hoy', 'hace tres días']);
    }
  });
});

// ── the spine: a turn is prompted with both groups' gap ──────────────────────────────────────────
// The real transcript writer, contacts and reader over one in-memory folder; the spine's other seams fakes.
function spineWorld(state) {
  const w = world({ state });
  const transcript = createTranscript({ contacts: w.contacts, io: w.io, now: () => new Date(w.clock.t) });
  const bridge = { sent: [], onMessage(fn) { this.cb = fn; }, send(chat, text) { this.sent.push({ chat, text }); }, emit(msg) { return this.cb(msg); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, chatId: ev.chatId, line: ev.line }); return { text: 'ok', sessionId: 's1', being }; } };
  const spine = createSpine({
    bridge, brain, transcript, heartbeats: { runDue() {} },
    identity: { build: (m) => ({ ...m, line: formatDispatchLine({ senderName: m.senderName, chatName: m.chatName, node: 'wa', body: m.body, ts: m.ts, msgId: m.msgId }) }) },
    router: { resolve: () => 'e' },
    gating: { async decide(_b, ev) { return { mode: 'accum', receives: true, mayReply: /@e\b/.test(ev.body), sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    sender: { open(chatId) { return { update() {}, fail() {}, async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send(chatId, t); } }; } },
    readTranscript: async (chatId, { chatName } = {}) => { const t = await w.contacts.transcriptTarget('whatsapp', chatId, { chatName }); return t ? (w.files.get(t.path) ?? null) : null; },
    readAccum: w.reader,
    clock: { now: () => w.clock.t },
  });
  spine.start();
  const say = (chatId, chatName, who, body, minute) => {
    w.clock.t = at(20, 12, minute);
    return bridge.emit({ surface: 'whatsapp', node: 'wa', chatId, chatName, senderId: who, senderName: who, msgId: `m${minute}`, ts: w.clock.t, kind: 'text', body, raw: {} });
  };
  return { ...w, bridge, brain, say };
}
const GROUP = 'grupo', SIDE_GROUP = 'SI+grupo';
const contextOf = (prompt) => (prompt.includes('ACCUMULATED CONTEXT') ? prompt.split('do not answer it.\n')[1].split('\n\n').map((b) => b.replace(/ #m\d+/, '')) : []);

describe('mode accum: one accum from the chat and its side group', () => {
  it('REPRODUCE: each turn, in whichever group it wakes, is prompted with both groups\' lines since the being\'s last turn', async () => {
    const s = spineWorld();
    await s.say(PRIMARY, GROUP, 'Lola', 'uno', 1);
    await s.say(SIDE, SIDE_GROUP, 'Pepe', 'dos', 2);
    await s.say(PRIMARY, GROUP, 'Lola', 'tres', 3);
    await s.say(SIDE, SIDE_GROUP, 'Pepe', '@e resume', 4);                   // wakes in the side group: its reply is logged there
    await s.say(PRIMARY, GROUP, 'Lola', 'cuatro', 5);
    await s.say(SIDE, SIDE_GROUP, 'Pepe', 'cinco', 6);
    await s.say(PRIMARY, GROUP, 'Lola', '@e otra', 7);                       // wakes in the chat: its boundary is in the side group's file
    await s.say(SIDE, SIDE_GROUP, 'Pepe', '@e y ahora?', 8);                 // wakes in the side group: its boundary is in the chat's file
    expect(s.brain.calls.map((c) => c.chatId)).toEqual([SIDE, PRIMARY, SIDE]);
    expect(contextOf(s.brain.calls[0].line)).toEqual(['Lola@[grupo].wa (12:01): uno', 'Pepe@[SI+grupo].wa (12:02): dos', 'Lola@[grupo].wa (12:03): tres']);
    expect(contextOf(s.brain.calls[1].line)).toEqual(['Lola@[grupo].wa (12:05): cuatro', 'Pepe@[SI+grupo].wa (12:06): cinco']);
    expect(contextOf(s.brain.calls[2].line)).toEqual([]);                    // nothing since its turn in the chat
    expect(s.brain.calls[2].line).toBe('Pepe@[SI+grupo].wa (12:08) #m8: @e y ahora?');
  });

  it('REPRODUCE (the 2026-10-03 rule, kept): a /join room and a /split read only their own transcript', async () => {
    const s = spineWorld(stateWith({ splitSide: false }));
    await s.say(PRIMARY, GROUP, 'Lola', 'uno', 1);
    await s.say(SIDE, SIDE_GROUP, 'Pepe', 'dos', 2);
    for (const [id, name, key, minute] of [[JOIN, 'join-room', 'join-room', 10], [SPLIT, 'SI+grupo-viaje', 'si-grupo-viaje', 20]]) {
      await s.say(id, name, 'Rita', 'ahí va', minute);
      await s.say(id, name, 'Rita', '@e y ahora?', minute + 1);
      const call = s.brain.calls.at(-1);
      expect(call.chatId).toBe(id);
      expect(contextOf(call.line)).toEqual([`Rita@[${name}].wa (12:${minute}): ahí va`]);
      expect(s.files.get(s.pathOf(key))).toContain('ahí va');
    }
  });
});
