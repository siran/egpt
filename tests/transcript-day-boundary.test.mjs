// tests/transcript-day-boundary.test.mjs — THE TRANSCRIPT SAYS WHAT DAY IT IS
// (operator 2026-09-01, from his own live SPOILER transcript):
//
//   Ron Tomkins@[SPOILER ALERT: chat de EyAy].wa (22:40) #204652: Ja
//   Mauricio Castro@[SPOILER ALERT: chat de EyAy].wa (00:18) #204667: A la rondamón !
//   José Velarde@[SPOILER ALERT: chat de EyAy].wa (06:20): reacted 👍 to #204628
//
// Times only. Midnight passed between lines 35733 and 35737 and NOTHING marked it, so no
// reader — human or model — can tell which day any line belongs to. A dispatch line carries
// HH:MM by operator mandate (2026-06-12), and dating thousands of lines would repeat one fact
// forever, so the DAY is stated once, where it CHANGES, as its own block:
//
//   [ 2026-09-01 ]
//
// In the transcript's CONFIGURED zone (`transcriptTimeZone` → default_time_zone), never UTC and
// never the machine's — the operator reads at −0400, so a UTC boundary lands four hours late,
// at the wrong line, which is worse than not marking it at all.
//
// The rest of this file is the LOCK on every parser that reads these lines back. A format
// change here has silently broken readers twice, so each one is exercised against a transcript
// that carries a boundary: transcript-log's _ENTRY_HEAD / _ID_AFTER_TS / _REPLY_REF /
// beingReplyRe / bodyForMessageId / contextSinceLastTurn, and beeper's transcriptionForNoteId.
import { describe, it, expect } from 'vitest';
import { dayBoundary, isDayBoundary, formatDispatchLine } from '../src/dispatch-line.mjs';
import { bodyForMessageId, contextSinceLastTurn } from '../src/transcript-log.mjs';
import { transcriptionForNoteId } from '../src/bridges/beeper.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createIdentity } from '../src/spine/identity.mjs';

const settle = () => new Promise((r) => setTimeout(r, 25));
const fakeContacts = { resolve: async () => 'fam-1234567890' };
const mkIo = (files) => ({
  appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
  mkdir: async () => {},
  existsSync: (p) => files.has(p),
  readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
  writeFile: async (p, d) => { files.set(p, d); },
  readdir: async () => [],
});
const fileEndingIn = (files, suffix) => [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1] ?? '';

// The operator reads at −0400. In September New York is −0400, so these two instants are the
// SAME UTC day and DIFFERENT days where he is sitting — which is the whole point.
const ZONE = 'America/New_York';
const AT_2240 = Date.UTC(2026, 8, 1, 2, 40);    // 2026-08-31 22:40 in ZONE, 2026-09-01 in UTC
const AT_0018 = Date.UTC(2026, 8, 1, 4, 18);    // 2026-09-01 00:18 in ZONE, 2026-09-01 in UTC

describe('dayBoundary — the marker, in the configured zone', () => {
  it('renders the day of the CONFIGURED zone, not UTC', () => {
    expect(dayBoundary(AT_2240, ZONE)).toBe('[ 2026-08-31 ]');
    expect(dayBoundary(AT_0018, ZONE)).toBe('[ 2026-09-01 ]');
    expect(dayBoundary(AT_2240, null)).toBe('[ 2026-09-01 ]');       // no zone → UTC, as hhmm does
  });

  it('an unusable zone falls back to UTC and never throws — a clock is not worth a lost line', () => {
    expect(dayBoundary(AT_2240, 'Mars/Olympus_Mons')).toBe('[ 2026-09-01 ]');
    expect(() => dayBoundary(undefined, ZONE)).not.toThrow();
  });

  it('the marker is recognisable, and NOTHING else is', () => {
    expect(isDayBoundary('[ 2026-09-01 ]')).toBe(true);
    expect(isDayBoundary('  [ 2026-09-01 ]  ')).toBe(true);
    expect(isDayBoundary('An@[SPOILER].wa (00:18) #204667: A la rondamón !')).toBe(false);
    expect(isDayBoundary('[ An@[SPOILER].wa (06:20): reacted 👍 to #204628 ]')).toBe(false);
    expect(isDayBoundary('[ re #204774 ] a body that opens with a bracket')).toBe(false);
    expect(isDayBoundary('    - a retraction record')).toBe(false);
    expect(isDayBoundary('')).toBe(false);
    expect(isDayBoundary(null)).toBe(false);
  });
});

describe('transcript.log — the day is marked where it changes', () => {
  const identity = createIdentity({ now: () => AT_2240, timeZone: ZONE });
  const from = (ts, msgKey) => ({ chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u1', senderName: 'Ron', msgKey, ts });
  const mk = () => {
    const files = new Map();
    return { files, t: createTranscript({ contacts: fakeContacts, io: mkIo(files), timeZone: ZONE, now: () => new Date(AT_0018) }) };
  };

  it('midnight passing between two entries puts a boundary between them', async () => {
    const { files, t } = mk();
    await t.log(identity.build({ body: 'Ja', from: from(AT_2240, '204652') }));
    await t.log(identity.build({ body: 'A la rondamón !', from: from(AT_0018, '204667') }));
    await settle();
    const blocks = fileEndingIn(files, 'transcript.md').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    expect(blocks.slice(-3)).toEqual([
      'Ron@[fam].wa (22:40) #204652: Ja',
      '[ 2026-09-01 ]',
      'Ron@[fam].wa (00:18) #204667: A la rondamón !',
    ]);
  });

  it('THE ZONE DECIDES, in both directions — not UTC, not the machine', async () => {
    // Same UTC day, different day where the operator sits → the boundary IS written (above).
    // Different UTC days, same day where he sits → it is NOT.
    const { files, t } = mk();
    const sameZoneDay = [Date.UTC(2026, 8, 1, 5, 0), Date.UTC(2026, 8, 2, 3, 0)];   // both 2026-09-01 in ZONE
    await t.log(identity.build({ body: 'uno', from: from(sameZoneDay[0], '1') }));
    await t.log(identity.build({ body: 'dos', from: from(sameZoneDay[1], '2') }));
    await settle();
    expect(fileEndingIn(files, 'transcript.md')).not.toContain('[ 2026-09-0');
  });

  it('a transcript that stays within one day is byte-identical to what it always was', async () => {
    const { files, t } = mk();
    for (const [ts, id] of [[AT_0018, '1'], [AT_0018 + 60000, '2'], [AT_0018 + 120000, '3']]) {
      await t.log(identity.build({ body: `m${id}`, from: from(ts, id) }));
    }
    await settle();
    expect(fileEndingIn(files, 'transcript.md')).not.toMatch(/^\[ \d{4}-/m);
  });

  it('the FIRST entry a process writes never carries a boundary — front matter stays at byte 0', async () => {
    const { files, t } = mk();
    await t.log(identity.build({ body: 'primero', from: from(AT_0018, '1') }));
    await settle();
    expect(fileEndingIn(files, 'transcript.md').startsWith('---\n')).toBe(true);
  });

  it("a being's reply and a limb cross midnight too — every write site marks the day", async () => {
    const { files, t } = mk();                                    // service clock = 00:18 next day
    const ev = identity.build({ body: 'Ja', from: from(AT_2240, '204652') });
    await t.log(ev);                                              // 22:40, previous day
    await t.log(ev, { text: 'sí', being: 'e' });                  // 00:18, new day → boundary
    await t.logAction(ev, { type: 'react', emoji: '👍', targetId: '204652' }, { being: 'e' });
    await settle();
    const text = fileEndingIn(files, 'transcript.md');
    expect(text.match(/^\[ 2026-09-01 \]$/gm)).toHaveLength(1);   // marked ONCE, at the change
    expect(text.indexOf('[ 2026-09-01 ]')).toBeLessThan(text.indexOf('(00:18): sí'));
    expect(text).toContain('[ e@[fam].wa (00:18): reacted 👍 to #204652 ]');
  });

  it('a stream train that opens on a new day says so, above its first byte', async () => {
    const { files, t } = mk();
    const ev = identity.build({ body: 'Ja', from: from(AT_2240, '204652') });
    await t.log(ev);
    await t.logStream(ev, '', 'pensando');
    await settle();
    const text = fileEndingIn(files, 'transcript.md');
    expect(text.indexOf('[ 2026-09-01 ]')).toBeLessThan(text.indexOf('(streaming)'));
    expect(text).not.toContain('(streaming) pensando\n[ 2026-09-01 ]');   // never INSIDE the train
  });
});

// ── THE READERS, LOCKED ─────────────────────────────────────────────────────────────────
// A boundary must not be mistakable for an entry head, and must not be swallowed into one.
describe('every parser that reads a transcript line back', () => {
  const line = (name, ts, id, body) => formatDispatchLine({ senderName: name, chatName: 'SPOILER', node: 'wa', ts, msgId: id, body, timeZone: ZONE });
  const doc = [
    '---', 'name: SPOILER', 'surface: whatsapp', '---', '',
    line('Ron', AT_2240, '204652', 'Ja'),
    '',
    '[ 2026-09-01 ]',
    '',
    line('Mauricio', AT_0018, '204667', 'A la rondamón !'),
    '',
    line('An', AT_0018, '204668', '(voice transcription, 7s) a ver si sale'),
    'segunda línea de la nota',
    '',
    'e@[SPOILER].wa (00:20): ya la escuché',
    '',
    line('José', AT_0018, '204669', '[re #204667] jaja'),
    '',
  ].join('\n');

  it('_ENTRY_HEAD / bodyForMessageId: a boundary ENDS a body, it is never part of one', () => {
    // Without this the walk (which collects every headerless line as body) would append
    // "\n\n[ 2026-09-01 ]" to the last entry of the previous day, and every caller asking for
    // "the recorded body" would get the marker with it.
    expect(bodyForMessageId(doc, '204652')).toBe('Ja');
    expect(bodyForMessageId(doc, '204667')).toBe('A la rondamón !');
  });

  it('_ID_AFTER_TS / _REPLY_REF: ids and reply references read exactly as before', () => {
    expect(bodyForMessageId(doc, '204669')).toBe('jaja');            // `[re #…] ` stripped, as always
    expect(bodyForMessageId(doc, '204670')).toBe(null);              // no such entry → nothing invented
  });

  it('a multi-line body still reads whole across a boundary further down the file', () => {
    expect(bodyForMessageId(doc, '204668')).toBe('(voice transcription, 7s) a ver si sale\nsegunda línea de la nota');
  });

  it('beeper.transcriptionForNoteId: the voice mark is still first in the body', () => {
    expect(transcriptionForNoteId(doc, '204668')).toBe('a ver si sale\nsegunda línea de la nota');
    expect(transcriptionForNoteId(doc, '204652')).toBe(null);        // not a voice note
  });

  it('contextSinceLastTurn: the boundary rides the gap it labels, and is never a speaker', () => {
    // beingReplyRe must not match `[ 2026-09-01 ]` — if it did, the gap would be truncated at
    // the boundary and the being would be fed nothing. And the marker must SURVIVE into the
    // window: a model told what was said since its last turn should be told the day changed.
    const { blocks } = contextSinceLastTurn(doc, { being: ['e', 'egpt'] });
    expect(blocks).toEqual([line('José', AT_0018, '204669', '[re #204667] jaja')]);

    const noReply = contextSinceLastTurn(doc, { being: ['don'] }).blocks;
    expect(noReply).toContain('[ 2026-09-01 ]');
    expect(noReply[0]).toBe(line('Ron', AT_2240, '204652', 'Ja'));
    expect(noReply[1]).toBe('[ 2026-09-01 ]');
  });

  it('a boundary block is never attributed to a speaker by the transcript reader', () => {
    // The shape carries no `@[`, so nothing that hunts for `<sender>@[<chat>].<node>` can
    // claim it — including commands.mjs's _SENDER_RE roster scan, which uses the same anchor.
    const { blocks } = contextSinceLastTurn('[ 2026-09-01 ]\n\nRon@[c].wa (00:18) #1: hola\n', { being: ['e'] });
    expect(blocks).toEqual(['[ 2026-09-01 ]', 'Ron@[c].wa (00:18) #1: hola']);
    expect(bodyForMessageId('[ 2026-09-01 ]\n\nRon@[c].wa (00:18) #1: hola\n', '1')).toBe('hola');
  });
});
