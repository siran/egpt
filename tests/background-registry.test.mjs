// background-registry.test.mjs — the node's list of background work it is handling (operator
// 2026-10-18: "nodes can have list of bg tasks being handled, yes, that is a good idea"):
// state/background.json, pending voice transcriptions + the beings' background agents.
//
// The defect: a voice note's arrival line is written at once and its transcription is pending only
// in the bridge's memory, so a spine restart mid-transcription left the arrival without an outcome.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '../src/spine/identity.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createBackgroundRegistry } from '../src/spine/background.mjs';
import { createCommands, AGENTS_USAGE } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { ensureContact, patchBeing } from '../src/conversations-state.mjs';
import { voiceArrivalBody, voiceTranscriptBody } from '../src/incoming-media.mjs';

const T = (hh, mm) => Date.UTC(2026, 9, 18, hh, mm);
const CHAT = 'Diego Pérez';
const FROM = {
  chatId: '!diego:beeper.local', chatName: CHAT, network: 'whatsapp',
  userId: 'u-diego', senderName: 'Diego Pérez', isSender: false, authorized: false,
  atEStart: false, atEAnywhere: false, replyToBot: false, isReaction: false, msgKey: '31503',
};
const ARRIVAL_LINE = 'Diego Pérez@[Diego Pérez].wa (16:12) #31503: (voice note, 11s — being transcribed…)';
const CHATTER_LINE = 'Bea@[Diego Pérez].wa (16:13) #31504: jaja';

const readdirOver = (files) => async (dir) => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const prefix = norm(dir).replace(/\/$/, '') + '/';
  const out = new Set();
  for (const k of files.keys()) { const nk = norm(k); if (nk.startsWith(prefix)) { const rest = nk.slice(prefix.length); if (!rest.includes('/')) out.add(rest); } }
  return [...out];
};
const memIo = (files) => ({
  appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
  mkdir: async () => {},
  existsSync: (p) => files.has(p),
  readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
  writeFile: async (p, d) => { files.set(p, d); },
  readdir: readdirOver(files),
});
const transcriptText = (files) => [...files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';

// One spine over the REAL identity, gate and transcript writer (in-memory fs); `files` survives a "restart".
function buildSpine({ files, background, at = T(16, 12), mode = 'on' }) {
  let now = at;
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push(ev); return { text: 'ok', being, sessionId: 's1' }; } };
  const state = patchBeing(ensureContact({ contacts: {} }, 'whatsapp', FROM.chatId, { pushedName: CHAT }).state, 'whatsapp', FROM.chatId, 'e', { mode });
  const spine = createSpine({
    bridge, brain, identity: createIdentity({ now: () => now }),
    router: { resolve: () => 'e' },
    gating: createGating({ getConfig: () => ({}), loadState: async () => state, defaultKey: 'e' }),
    sender: { open() { return { activate() {}, update() {}, fail() {}, async finish() {} }; } },
    transcript: createTranscript({ contacts: { resolve: async () => 'diego' }, io: memIo(files) }),
    heartbeats: { runDue() {} }, clock: { now: () => 1000 }, turnTimeoutMs: 0,
    background,
  });
  spine.start();
  return { spine, brain, at: (ms) => { now = ms; }, emit: (body, from) => cb({ body, from }) };
}

const home = () => mkdtempSync(join(tmpdir(), 'egpt-bg-'));
const fileOf = (dir) => join(dir, 'state', 'background.json');
const readReg = (dir) => JSON.parse(readFileSync(fileOf(dir), 'utf8'));
const registry = (dir, over = {}) => {
  const lines = [];
  const reg = createBackgroundRegistry({ path: fileOf(dir), node: 'kg', onLog: (m) => lines.push(m), ...over });
  return { reg, lines };
};
// The pipeline's contract (transcription-pipeline.mjs transcribe): (path, cfg, log, meta) → text.
const fakeTranscriber = (text, durationSec = 11) => {
  const calls = [];
  return { calls, transcribe: async (path, cfg, log, meta) => { calls.push({ path, cfg }); if (meta) meta.durationSec = durationSec; return text; } };
};

// The onMedia meta the bridge would hand with the outcome (beeper.mjs mediaMeta), minus the caption.
const MEDIA = (audio) => ({ chatID: FROM.chatId, chatName: CHAT, chatType: 'private', network: 'whatsapp', msgId: '31503', senderName: 'Diego Pérez', isSender: false, ts: T(16, 12), kind: 'audio', mime: 'audio/ogg', fileName: null, localPath: audio, isVoiceNote: true });
// Live before the restart: the note arrives (bridge names its audio file), chatter lands under it.
async function arriveThenDie(dir, audio, { from = {}, mode = 'on' } = {}) {
  const files = new Map();
  const { reg } = registry(dir);
  await reg.load();
  const live = buildSpine({ files, background: reg, mode });
  await live.emit(voiceArrivalBody({ durationSec: 11 }), { ...FROM, isTranscriptFromVoice: false, voiceLine: 'arrival', voicePath: audio, voiceMedia: MEDIA(audio), ...from });
  live.at(T(16, 13));
  await live.emit('jaja', { ...FROM, userId: 'u-bea', senderName: 'Bea', msgKey: '31504' });
  await reg.flush();
  return { files, before: transcriptText(files) };
}
// boot's lists for the persona: handles e/egpt, and `e` among its voice_handles (a spoken name wakes only through those).
const WAKE = { wakeWords: ['e', 'egpt'], voiceWakeWords: ['e'], addressWithoutAt: true };
async function restart(dir, files, { transcribe, at = T(16, 20), mode = 'on', saveAudio = null, unlisten = null } = {}) {
  const { reg, lines } = registry(dir);
  await reg.load();
  const next = buildSpine({ files, background: reg, at, mode });
  const order = [];
  await reg.resume({
    transcribe, audioCfg: { model: 'large-v3' }, wake: WAKE,
    deliver: (body, from) => { order.push('outcome'); return next.spine.handleInbound({ body, from }); },
    saveAudio: saveAudio && (async (m, f) => { order.push('media'); return saveAudio(m, f); }),
    unlisten: unlisten && (async (f) => { order.push('unlisten'); return unlisten(f); }),
  });
  await reg.flush();
  return { reg, lines, next, order };
}

describe('a voice note pending across a spine restart', () => {
  it('REPRODUCE: the arrival is registered with its file; after a restart it is transcribed again and its outcome line appended — nothing earlier rewritten', async () => {
    const dir = home();
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const { files, before } = await arriveThenDie(dir, audio);
    expect(before).toContain(ARRIVAL_LINE);
    expect(before).toContain(CHATTER_LINE);
    expect(readReg(dir).transcriptions).toEqual([expect.objectContaining({
      surface: 'whatsapp', chatId: FROM.chatId, chatName: CHAT, msgId: '31503', sender: 'Diego Pérez', file: audio, node: 'kg', arrivedAt: new Date(T(16, 12)).toISOString(),
    })]);

    const tx = fakeTranscriber('Mira marico…');
    const { next } = await restart(dir, files, { transcribe: tx.transcribe });
    const after = transcriptText(files);
    expect(after.startsWith(before)).toBe(true);                       // append-only: byte prefix intact
    expect(after.slice(before.length)).toContain('Diego Pérez@[Diego Pérez].wa (16:20): [re #31503] (voice transcription, 11s) Mira marico…');
    expect(tx.calls).toEqual([{ path: audio, cfg: { model: 'large-v3' } }]);   // THE transcription service, the same file
    expect(readReg(dir).transcriptions).toEqual([]);
  });

  it('REPRODUCE: the resumed transcription is dispatched like a fresh one — it was in flight, not old', async () => {
    const dir = home();
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const { files } = await arriveThenDie(dir, audio);
    const { next } = await restart(dir, files, { transcribe: fakeTranscriber('Mira marico…').transcribe });
    expect(next.brain.calls.map((ev) => [ev.line, ev.backlog])).toEqual([['Diego Pérez@[Diego Pérez].wa (16:20): [re #31503] (voice transcription, 11s) Mira marico…', false]]);
  });

  it('a mention-gated (accum) chat: "e, …" prompts the being once; a note that names nobody is only recorded', async () => {
    for (const [said, prompted] of [['e, qué hora es?', 1], ['qué hora es?', 0]]) {
      const dir = home();
      const audio = join(dir, 'note.ogg');
      writeFileSync(audio, 'OggS');
      const { files, before } = await arriveThenDie(dir, audio, { mode: 'accum' });
      const { next } = await restart(dir, files, { transcribe: fakeTranscriber(said).transcribe, mode: 'accum' });
      expect(transcriptText(files).slice(before.length), said).toContain(`[re #31503] (voice transcription, 11s) ${said}`);
      expect(next.brain.calls.length, said).toBe(prompted);
    }
  });

  it('a note whose ARRIVAL was already backlog (older than the last spine) stays backlog: recorded, not dispatched', async () => {
    const dir = home();
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const { files, before } = await arriveThenDie(dir, audio, { from: { backlog: true } });
    const { next } = await restart(dir, files, { transcribe: fakeTranscriber('e, hola').transcribe });
    expect(transcriptText(files).slice(before.length)).toContain('[re #31503] (voice transcription, 11s) e, hola');
    expect(next.brain.calls).toHaveLength(0);
  });

  // contract 8.3
  it("the audio is saved into media/ as a live outcome does: the bridge's meta, the transcription as caption, before the outcome line", async () => {
    const dir = home();
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const { files } = await arriveThenDie(dir, audio);
    const saved = [];
    const { order } = await restart(dir, files, { transcribe: fakeTranscriber('Mira marico…').transcribe, saveAudio: (m, f) => saved.push([m, f.msgKey]) });
    expect(saved).toEqual([[{ ...MEDIA(audio), caption: 'Mira marico…' }, '31503']]);
    expect(order.slice(0, 2)).toEqual(['media', 'outcome']);
  });

  it('no transcript: the audio is still saved, caption-less; the file gone: nothing to save', async () => {
    const dir = home();
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const { files } = await arriveThenDie(dir, audio);
    const saved = [];
    await restart(dir, files, { transcribe: fakeTranscriber(null).transcribe, saveAudio: (m) => saved.push(m) });
    expect(saved).toEqual([{ ...MEDIA(audio), caption: null }]);
    const gone = home();
    const g = await arriveThenDie(gone, join(gone, 'gone.ogg'));
    const none = [];
    await restart(gone, g.files, { transcribe: fakeTranscriber('x').transcribe, saveAudio: (m) => none.push(m) });
    expect(none).toEqual([]);
  });

  it("the stale 🎧 comes off once the resumed decode ends — transcribed, failed or file gone — after the outcome line, never for another node's note, never where none could be up", async () => {
    const withAudio = (dir) => { const a = join(dir, 'n.ogg'); writeFileSync(a, 'OggS'); return a; };
    for (const [why, audioOf, text, node, listening, expected] of [
      ['transcribed', withAudio, 'hola', null, true, 1],
      ['no transcript', withAudio, null, null, true, 1],
      ['file gone', (dir) => join(dir, 'gone.ogg'), 'x', null, true, 1],
      ['another node', withAudio, 'x', 'do', true, 0],
      ['listening_reaction off at arrival', withAudio, 'hola', null, false, 0],
    ]) {
      const dir = home();
      const { files } = await arriveThenDie(dir, audioOf(dir), { from: listening ? { voiceListening: true } : {} });
      expect(readReg(dir).transcriptions[0], why).toMatchObject({ listening, from: expect.not.objectContaining({ voiceListening: true }) });
      if (node) { const r = readReg(dir); r.transcriptions[0].node = node; writeFileSync(fileOf(dir), JSON.stringify(r)); }
      const off = [];
      const { order } = await restart(dir, files, { transcribe: fakeTranscriber(text).transcribe, unlisten: (f) => off.push([f.chatId, f.msgKey]) });
      expect(off, why).toEqual(Array(expected).fill([FROM.chatId, '31503']));
      if (expected) expect(order.indexOf('unlisten'), why).toBeGreaterThan(order.indexOf('outcome'));
    }
  });

  it('a 🎧 removal that throws or hangs never holds the outcome line or the registry', async () => {
    for (const unlisten of [async () => { throw new Error('no such reaction'); }, () => new Promise(() => {})]) {
      const dir = home();
      const audio = join(dir, 'n.ogg');
      writeFileSync(audio, 'OggS');
      const { files, before } = await arriveThenDie(dir, audio, { from: { voiceListening: true } });
      const { reg, lines } = registry(dir);
      await reg.load();
      const next = buildSpine({ files, background: reg, at: T(16, 20) });
      await reg.resume({ transcribe: fakeTranscriber('hola').transcribe, wake: WAKE, deliver: (body, from) => next.spine.handleInbound({ body, from }), unlisten });
      await vi.waitFor(() => expect(transcriptText(files).slice(before.length)).toContain('[re #31503] (voice transcription, 11s) hola'));
      await vi.waitFor(() => expect(readReg(dir).transcriptions).toEqual([]));
      if (lines.some((l) => /no such reaction/.test(l))) expect(lines.some((l) => /🎧.*no such reaction/.test(l))).toBe(true);
    }
  });

  it('the file is gone: the failure line is appended, nothing earlier rewritten, nothing transcribed', async () => {
    const dir = home();
    const { files, before } = await arriveThenDie(dir, join(dir, 'gone.ogg'));
    const tx = fakeTranscriber('never');
    await restart(dir, files, { transcribe: tx.transcribe });
    const after = transcriptText(files);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain('Diego Pérez@[Diego Pérez].wa (16:20): [re #31503] (voice note not transcribed: restart)');
    expect(tx.calls).toEqual([]);
    expect(readReg(dir).transcriptions).toEqual([]);
  });

  it('another node\'s decode is not resumed here: the failure line', async () => {
    const dir = home();
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const { files, before } = await arriveThenDie(dir, audio);
    const reg = readReg(dir);
    reg.transcriptions[0].node = 'do';
    writeFileSync(fileOf(dir), JSON.stringify(reg));
    const tx = fakeTranscriber('never');
    await restart(dir, files, { transcribe: tx.transcribe });
    expect(transcriptText(files).slice(before.length)).toContain('[re #31503] (voice note not transcribed: restart)');
    expect(tx.calls).toEqual([]);
  });

  it('a live outcome clears the entry — nothing left to resume', async () => {
    const dir = home();
    const files = new Map();
    const { reg } = registry(dir);
    await reg.load();
    const live = buildSpine({ files, background: reg });
    await live.emit(voiceArrivalBody({ durationSec: 11 }), { ...FROM, isTranscriptFromVoice: false, voiceLine: 'arrival', voicePath: join(dir, 'x.ogg') });
    await reg.flush();
    expect(readReg(dir).transcriptions).toHaveLength(1);
    await live.emit(voiceTranscriptBody('hola', { durationSec: 11 }), { ...FROM, isTranscriptFromVoice: true, voiceLine: 'outcome', voicePath: join(dir, 'x.ogg') });
    await reg.flush();
    expect(readReg(dir).transcriptions).toEqual([]);
  });
});

describe('background agents — mirrored from the warm pool', () => {
  const task = (over = {}) => ({ being: 'wren', surface: 'whatsapp', chatId: '!rodz', taskId: 'b1', description: 'Crawl the docs', since: T(15, 0), ...over });

  it('reflects live tasks and clears finished ones; the tick does nothing until the restart is reconciled', async () => {
    const dir = home();
    let live = [task()];
    const { reg } = registry(dir, { liveAgents: () => live });
    await reg.load();
    reg.sync();                                    // before reconcile: no write yet
    await reg.flush();
    expect(existsSync(fileOf(dir))).toBe(false);
    reg.reconcile();
    await reg.flush();
    expect(readReg(dir).agents).toEqual([{ being: 'wren', surface: 'whatsapp', chatId: '!rodz', taskId: 'b1', description: 'Crawl the docs', since: new Date(T(15, 0)).toISOString() }]);
    live = [task(), task({ taskId: 'b2', description: 'Audit', since: T(15, 30) })];
    reg.sync();
    await reg.flush();
    expect(readReg(dir).agents.map((a) => a.taskId)).toEqual(['b1', 'b2']);
    live = [task({ taskId: 'b2', description: 'Audit', since: T(15, 30) })];
    reg.sync();
    await reg.flush();
    expect(readReg(dir).agents.map((a) => a.taskId)).toEqual(['b2']);
    live = [];
    reg.sync();
    await reg.flush();
    expect(readReg(dir).agents).toEqual([]);
  });

  it('after a restart the list is what cli-host adopted; what did not come back is said once, never re-woken', async () => {
    const dir = home();
    const first = registry(dir, { liveAgents: () => [task(), task({ taskId: 'b2', description: 'Audit' })] });
    await first.reg.load();
    first.reg.reconcile();
    await first.reg.flush();
    const second = registry(dir, { liveAgents: () => [task()] });
    await second.reg.load();
    expect(readReg(dir).agents.map((a) => a.taskId)).toEqual(['b1', 'b2']);   // untouched until adoption is done
    second.reg.reconcile();
    await second.reg.flush();
    expect(readReg(dir).agents.map((a) => a.taskId)).toEqual(['b1']);
    expect(second.lines.filter((l) => /b2/.test(l))).toEqual(['wren/!rodz: background task b2 (Audit) did not survive the restart']);
  });
});

describe('the file', () => {
  it('is written atomically: a temp file renamed over it, never written in place', async () => {
    const ops = [];
    const io = {
      mkdir: async () => {},
      writeFile: async (p, d) => { ops.push(['write', p, d]); },
      rename: async (a, b) => { ops.push(['rename', a, b]); },
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      existsSync: () => true,
    };
    const reg = createBackgroundRegistry({ path: 'C:/h/state/background.json', node: 'kg', liveAgents: () => [], io });
    await reg.load();
    reg.reconcile();
    await reg.flush();
    expect(ops.length).toBe(2);
    const [[w, tmp, body], [r, from, to]] = ops;
    expect([w, r]).toEqual(['write', 'rename']);
    expect(tmp).not.toBe('C:/h/state/background.json');
    expect([from, to]).toEqual([tmp, 'C:/h/state/background.json']);
    expect(JSON.parse(body)).toEqual({ transcriptions: [], agents: [] });
  });

  it('a corrupt file is ignored with a log line, and the next write replaces it', async () => {
    const dir = home();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(fileOf(dir), '{"transcriptions": [ {"chatId": ');
    const tx = fakeTranscriber('never');
    const { reg, lines } = registry(dir, { liveAgents: () => [] });
    await reg.load();
    expect(lines.some((l) => /background\.json.*unreadable.*ignored/.test(l))).toBe(true);
    const delivered = [];
    await reg.resume({ transcribe: tx.transcribe, deliver: (b, f) => delivered.push({ b, f }) });
    expect(delivered).toEqual([]);
    reg.reconcile();
    await reg.flush();
    expect(readReg(dir)).toEqual({ transcriptions: [], agents: [] });
    expect(readdirSync(join(dir, 'state'))).toEqual(['background.json']);   // no temp file left behind
  });

  it('a missing file is ignored with a log line', async () => {
    const dir = home();
    const { reg, lines } = registry(dir);
    await reg.load();
    expect(lines.some((l) => /no .*background\.json/.test(l))).toBe(true);
    expect(reg.status()).toBe('');
  });
});

describe('bare /agents shows what this node is handling', () => {
  const op = { chatId: '!self', surface: 'whatsapp', body: '/agents', authorized: true };
  const harness = (background) => {
    const sent = [];
    const cmds = createCommands({ getConfig: () => ({}), send: async (chatId, text) => sent.push(text), exit: () => {}, loadState: async () => ({ contacts: {} }), writeState: async () => {}, logTranscript: async () => true, defaultKey: 'e', background });
    return { cmds, sent };
  };

  it('the list first, then the usage — short', async () => {
    const dir = home();
    const { reg } = registry(dir, { liveAgents: () => [{ being: 'wren', surface: 'whatsapp', chatId: '!rodz', taskId: 'b1', description: 'Crawl the docs', since: Date.now() - 41 * 60_000 }] });
    await reg.load();
    reg.noteVoice({ voiceLine: 'arrival', surface: 'whatsapp', chatId: '!diego', chatName: CHAT, msgId: '31503', senderName: 'Diego Pérez', ts: Date.now() - 3 * 60_000, raw: { ...FROM, voicePath: 'C:/a.ogg' } });
    reg.reconcile();
    const { cmds, sent } = harness(reg);
    await cmds.run(op);
    expect(sent).toEqual([[
      'kg is handling:',
      '· voice note #31503 from Diego Pérez in Diego Pérez — transcribing, 3m00s',
      '· wren in !rodz — Crawl the docs, 41m00s',
      '',
      AGENTS_USAGE,
    ].join('\n')]);
  });

  it('nothing in flight: the usage, byte-identical', async () => {
    const dir = home();
    const { reg } = registry(dir, { liveAgents: () => [] });
    await reg.load();
    reg.reconcile();
    const { cmds, sent } = harness(reg);
    await cmds.run(op);
    expect(sent).toEqual([AGENTS_USAGE]);
  });
});
