// A VOICE NOTE IS TWO LINES (operator 2026-10-16): "transcript is addition only; so, 1. received
// audio note from X id N, the voice note is being transcribed... lines of chatter later,
// transcription of audio note N: bla bla".
//
// Was: ONE line, written only once whisper finished and stamped with THAT time — a note that
// arrived 16:12 read `(16:15) #31503: (voice transcription, 11s) …`, and while it was being
// transcribed the record held no trace of it. Now:
//   Diego Pérez@[Diego Pérez].wa (16:12) #31503: (voice note, 11s — being transcribed…)
//   …chatter…
//   Diego Pérez@[Diego Pérez].wa (16:15): [re #31503] (voice transcription, 11s) Mira marico…
// The arrival is a RECORD (prompts nobody); the transcription is what is dispatched.
import { describe, it, expect } from 'vitest';
import { createIdentity } from '../src/spine/identity.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { bodyForMessageId, contextSinceLastTurn } from '../src/transcript-log.mjs';
import { transcriptionForNoteId } from '../src/bridges/beeper.mjs';
import { messageFacts } from '../src/conversations-state.mjs';
import { voiceArrivalBody, voiceFailedBody, voiceTranscriptBody } from '../src/incoming-media.mjs';

const T = (hh, mm) => Date.UTC(2026, 9, 16, hh, mm);
const CHAT = 'Diego Pérez';
const FROM = {
  chatId: '!diego:beeper.local', chatName: CHAT, network: 'whatsapp',
  userId: 'u-diego', senderName: 'Diego Pérez', isSender: false, authorized: false,
  atEStart: false, atEAnywhere: false, replyToBot: false, isReaction: false, msgKey: '31503',
};
const ARRIVAL = { ...FROM, isTranscriptFromVoice: false, voiceLine: 'arrival' };
const OUTCOME = { ...FROM, isTranscriptFromVoice: true, voiceLine: 'outcome' };
const HEARD = voiceTranscriptBody('Mira marico…', { durationSec: 11 });

const ARRIVAL_LINE = 'Diego Pérez@[Diego Pérez].wa (16:12) #31503: (voice note, 11s — being transcribed…)';
const OUTCOME_LINE = 'Diego Pérez@[Diego Pérez].wa (16:15): [re #31503] (voice transcription, 11s) Mira marico…';

function clockedIdentity() {
  let now = T(16, 12);
  return { identity: createIdentity({ now: () => now }), at: (ms) => { now = ms; } };
}

describe('the two bodies', () => {
  it('arrival: duration when known, omitted otherwise; failure names its reason on one line', () => {
    expect(voiceArrivalBody({ durationSec: 11.4 })).toBe('(voice note, 11s — being transcribed…)');
    expect(voiceArrivalBody({})).toBe('(voice note — being transcribed…)');
    expect(voiceFailedBody('worker timed out\n(after 30 min)')).toBe('(voice note not transcribed: worker timed out (after 30 min))');
  });
});

describe('identity — the arrival keeps the id, the transcription answers it', () => {
  it('REPRODUCE: arrival line under its own #id at arrival time; the transcription line at its own time, `[re #id]`, no id of its own', () => {
    const { identity, at } = clockedIdentity();
    const a = identity.build({ body: voiceArrivalBody({ durationSec: 11 }), from: ARRIVAL });
    at(T(16, 15));
    const o = identity.build({ body: HEARD, from: OUTCOME });
    expect(a.line).toBe(ARRIVAL_LINE);
    expect(o.line).toBe(OUTCOME_LINE);
    // both events still NAME the note (a reply quotes it, a reaction lands on it)
    expect(a.msgId).toBe('31503');
    expect(o.msgId).toBe('31503');
    expect(a.voiceLine).toBe('arrival');
    expect(o.voiceLine).toBe('outcome');
    expect(o.isVoice).toBe(true);
    expect(o.replyToId).toBe(null);   // the note quoted nothing — the `[re #]` is the line's, not a quote
  });

  it('a note that QUOTED a message: the arrival carries the quote, the transcription points at the note', () => {
    const { identity, at } = clockedIdentity();
    const a = identity.build({ body: voiceArrivalBody({ durationSec: 11 }), from: { ...ARRIVAL, replyToId: '31400' } });
    at(T(16, 15));
    const o = identity.build({ body: HEARD, from: { ...OUTCOME, replyToId: '31400' } });
    expect(a.line).toBe('Diego Pérez@[Diego Pérez].wa (16:12) #31503: [re #31400] (voice note, 11s — being transcribed…)');
    expect(o.line).toBe(OUTCOME_LINE);
    expect(o.replyToId).toBe('31400');   // the prompt still resolves what the note answered
  });
});

const doc = (...lines) => ['---', 'name: Diego Pérez', '---', '', ...lines.flatMap((l) => [l, ''])].join('\n');
const CHATTER = 'Bea@[Diego Pérez].wa (16:13) #31504: jaja';

describe('bodyForMessageId — pending vs done', () => {
  it('REPRODUCE: while pending it says "being transcribed" (was: no entry → null, the caller fell through silently)', () => {
    const t = doc(ARRIVAL_LINE, CHATTER);
    expect(bodyForMessageId(t, '31503')).toBe('(voice note, 11s — being transcribed…)');
    expect(transcriptionForNoteId(t, '31503')).toBe(null);
  });

  it('once the transcription is on the record, #id resolves to IT', () => {
    const t = doc(ARRIVAL_LINE, CHATTER, OUTCOME_LINE);
    expect(bodyForMessageId(t, '31503')).toBe('(voice transcription, 11s) Mira marico…');
    expect(transcriptionForNoteId(t, '31503')).toBe('Mira marico…');
    expect(bodyForMessageId(t, '31504')).toBe('jaja');   // the chatter between is untouched
  });

  it('a multi-line transcription comes back whole, up to the next entry', () => {
    const t = doc(ARRIVAL_LINE, 'Diego Pérez@[Diego Pérez].wa (16:15): [re #31503] (voice transcription, 11s) uno\ndos\ntres', CHATTER);
    expect(transcriptionForNoteId(t, '31503')).toBe('uno\ndos\ntres');
  });

  it('a failed transcription resolves to its failure line — never a dangling "being transcribed"', () => {
    const t = doc(ARRIVAL_LINE, `Diego Pérez@[Diego Pérez].wa (16:15): [re #31503] ${voiceFailedBody('no transcript')}`);
    expect(bodyForMessageId(t, '31503')).toBe('(voice note not transcribed: no transcript)');
    expect(transcriptionForNoteId(t, '31503')).toBe(null);
  });

  it('a person REPLYING to the note is not its transcription', () => {
    const t = doc(ARRIVAL_LINE, 'Bea@[Diego Pérez].wa (16:14) #31505: [re #31503] (voice transcription) no te oigo');
    expect(bodyForMessageId(t, '31503')).toBe('(voice note, 11s — being transcribed…)');
  });

  it('LOCK: the one-line shape already on disk still reads exactly as before', () => {
    const t = doc('Diego Pérez@[Diego Pérez].wa (16:15) #31503: (voice transcription, 11s) Mira marico…');
    expect(transcriptionForNoteId(t, '31503')).toBe('Mira marico…');
  });
});

describe('accum context — the transcription is the SPEAKER\'s entry', () => {
  it('both lines are Diego\'s entries; the chatter between them stays between them', () => {
    const t = doc('egpt@[Diego Pérez].wa (16:00): dime', ARRIVAL_LINE, CHATTER, 'Diego Pérez@[Diego Pérez].wa (16:15): [re #31503] (voice transcription, 11s) uno\ndos');
    const { blocks } = contextSinceLastTurn(t, { being: 'egpt' });
    expect(blocks).toEqual([ARRIVAL_LINE, CHATTER, 'Diego Pérez@[Diego Pérez].wa (16:15): [re #31503] (voice transcription, 11s) uno\ndos']);
  });
});

describe('stats — one voice note is ONE message', () => {
  it('the arrival counts nothing; the transcription counts the voice note', () => {
    const { identity, at } = clockedIdentity();
    const a = identity.build({ body: voiceArrivalBody({ durationSec: 11 }), from: ARRIVAL });
    at(T(16, 15));
    const o = identity.build({ body: HEARD, from: OUTCOME });
    expect(messageFacts(a)).toBe(null);
    expect(messageFacts(o)).toMatchObject({ id: '31503', len: 0, media: { voice: 1 } });
  });
});

// --- the spine, over the REAL identity + transcript service (in-memory fs) ---
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

function buildSpine({ mode = 'on' } = {}) {
  const files = new Map();
  let cb = null;
  const bridge = { sent: [], onMessage(fn) { cb = fn; }, send(chat, text) { this.sent.push({ chat, text }); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push(ev); return { text: 'ok', being, sessionId: 's1' }; } };
  const decided = [];
  const { identity, at } = clockedIdentity();
  const spine = createSpine({
    bridge, brain, identity,
    router: { resolve: () => 'e' },
    gating: { async decide(_b, ev) { decided.push(ev); return { mode, receives: mode !== 'off', mayReply: mode !== 'off' }; }, surfaces: () => true },
    sender: { open() { return { activate() {}, update() {}, fail() {}, async finish() {} }; } },
    transcript: createTranscript({ contacts: { resolve: async () => 'diego' }, io: memIo(files) }),
    heartbeats: { runDue() {} }, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  spine.start();
  return { files, brain, decided, at, emit: (body, from) => cb({ body, from }) };
}

describe('spine — the arrival is a RECORD, the transcription is the prompt', () => {
  it('REPRODUCE: arrival written at once and prompts nobody; chatter lands under it; the transcription is appended, dispatched, and nothing earlier is rewritten', async () => {
    const s = buildSpine();
    await s.emit(voiceArrivalBody({ durationSec: 11 }), ARRIVAL);
    const afterArrival = transcriptText(s.files);
    expect(afterArrival).toContain(ARRIVAL_LINE);
    expect(s.brain.calls).toHaveLength(0);                         // a record — prompts nobody
    expect(s.decided.every((ev) => ev.backlog)).toBe(true);         // its gate read was the read-only one (nothing created)

    s.at(T(16, 13));
    await s.emit('jaja', { ...FROM, userId: 'u-bea', senderName: 'Bea', msgKey: '31504' });
    const afterChatter = transcriptText(s.files);
    expect(afterChatter.startsWith(afterArrival)).toBe(true);
    s.brain.calls.length = 0;

    s.at(T(16, 15));
    await s.emit(HEARD, OUTCOME);
    const text = transcriptText(s.files);
    expect(text.startsWith(afterChatter)).toBe(true);                // append-only: byte prefix intact
    expect(text.indexOf(ARRIVAL_LINE)).toBeLessThan(text.indexOf('Bea@[Diego Pérez].wa (16:13) #31504: jaja'));
    expect(text.indexOf('Bea@[Diego Pérez].wa (16:13) #31504: jaja')).toBeLessThan(text.indexOf(OUTCOME_LINE));
    expect(s.brain.calls.map((ev) => ev.line)).toEqual([OUTCOME_LINE]);   // the transcription is what prompts
    expect(s.brain.calls[0].msgId).toBe('31503');                          // …and its reply still quotes the note
  });

  it('an \'off\' chat records neither line (never a dangling arrival)', async () => {
    const s = buildSpine({ mode: 'off' });
    await s.emit(voiceArrivalBody({ durationSec: 11 }), ARRIVAL);
    await s.emit(HEARD, OUTCOME);
    expect(transcriptText(s.files)).toBe('');
    expect(s.brain.calls).toHaveLength(0);
  });
});
