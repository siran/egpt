// Locks C1.2 / I3 (limb-agnostic logging): a received message — or a reply,
// surfaced or withheld — MUST land in the chat's transcript. The bot→Wren
// forceTarget route regressed this for Telegram (2026-06-12); these tests make
// "logged nothing for a received message" a hard failure, not a silent no-op.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptAppend, replyLine, contextSinceLastTurn, bodyForMessageId } from '../src/transcript-log.mjs';

describe('transcriptAppend', () => {
  it('a new transcript gets the front matter + the line', () => {
    const out = transcriptAppend({ existing: false, body: 'hola wren', name: 'DOLLY-REVE', surface: 'tg', slug: 'dolly-reve', chatId: '-5136707031', persona: 'wren' });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('surface: tg');
    expect(out).toContain('persona: wren');
    expect(out).toContain('hola wren');
  });

  // TWO STATIC KEYS, NOT ONE (operator 2026-07-26: "the key of a conversation, group, thread
  // is always the static information. in beeper we have the chat-id, for agents the
  // thread-id"). This header is written at INGESTION — before any thread exists — so the only
  // id it can honestly carry is the CHAT id, and it belongs in `chat_id`. The defect this
  // locks out: the chat id was written into `thread_id`, so the live shell/lobby transcript
  // opened with `thread_id: main` (the shell CHAT id) and the roll had no thread to key on.
  it('names the CHAT id in chat_id and leaves thread_id unset (it is not known yet)', () => {
    const out = transcriptAppend({ existing: false, body: 'hola', name: 'console', surface: 'shell', slug: 'lobby', chatId: 'main', persona: 'egpt' });
    expect(out).toContain('chat_id: main');
    expect(out).not.toContain('thread_id:');
  });

  it('an existing transcript gets just the line (no repeated header)', () => {
    expect(transcriptAppend({ existing: true, body: 'segundo turno', surface: 'tg', slug: 's' })).toBe('segundo turno\n\n');
  });

  // THE GUARD: a received message can never be logged as nothing.
  it('THROWS on an empty body — a received message must not be silently dropped', () => {
    expect(() => transcriptAppend({ existing: true, body: '' })).toThrow(/silently dropped/);
    expect(() => transcriptAppend({ existing: true, body: '   ' })).toThrow(/silently dropped/);
  });
});

// ── ONE LINE SHAPE, ONE KIND OF NAME (operator 2026-08-28) ──────────────────
// The record used to carry TWO shapes — the inbound `Sender@[chat].node (HH:MM) #id: body`
// and a reply-only `[@being (HH:MM)]: body` — and the operator, reading a live transcript,
// ruled: "the correct format is 'e' outside the [], and better egpt instead of e". A being's
// utterance now reads like every other utterance, through the SAME formatter (formatDispatchLine),
// so the two halves cannot drift apart again. Same day, the rest of the distinction went with it:
// "no sigil, no distinction, an agent is just another participant in a room" — no `@` on the
// speaker, and no `.<node>` qualifier, because the agent NAME is the identifier.
describe('replyLine — the unified line shape', () => {
  const NOW = new Date(Date.UTC(2026, 6, 25, 19, 7, 0));
  const CHAT = { chatName: 'SPOILER ALERT: chat de EyAy', node: 'wa' };

  // The operator's own target line, byte for byte.
  it('REPRODUCE-FIRST: speaker OUTSIDE the brackets, BARE, chat inside, surface tag, time, message id', () => {
    expect(replyLine({ being: 'egpt', body: 'No, no te creería sin evidencia', now: NOW, msgId: '202360', ...CHAT }))
      .toBe('egpt@[SPOILER ALERT: chat de EyAy].wa (19:07) #202360: No, no te creería sin evidencia');
  });

  // REPRODUCE-FIRST: the sigil is gone entirely — a being's speaker slot reads exactly like a
  // person's, which is the whole ruling.
  it('no `@` prefix and no `.<node>` qualifier — the speaker is the name and nothing else', () => {
    const line = replyLine({ being: 'egpt', body: 'hi', now: NOW, ...CHAT });
    expect(line.startsWith('egpt@[')).toBe(true);
    expect(line).not.toContain('@egpt@[');
    expect(line).not.toContain('.kg@[');
    expect(line).toBe('egpt@[SPOILER ALERT: chat de EyAy].wa (19:07): hi');
  });

  // `#<id>` is what makes a line addressable for /react and /reply (MESSAGES-FIRST-CLASS).
  // Omitted when there is none — which is every caller today, since the spine records a reply
  // BEFORE delivering it and no id exists yet.
  it('carries #<id> when there is one and omits it when there is not', () => {
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, msgId: '202360', ...CHAT })).toContain('(19:07) #202360: hi');
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, ...CHAT })).toContain('(19:07): hi');
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, ...CHAT })).not.toContain('#');
  });

  it('tags a withheld reply, leaves a surfaced one clean', () => {
    expect(replyLine({ being: 'wren', body: 'hi', surfaced: true, now: NOW, ...CHAT })).toBe('wren@[SPOILER ALERT: chat de EyAy].wa (19:07): hi');
    expect(replyLine({ being: 'wren', body: 'hi', surfaced: false, now: NOW, ...CHAT })).toContain(': (not surfaced) hi');
  });

  // The RAW BYTE TRAIN block header (operator 2026-08-27): empty body, tag in the same slot,
  // trailing space kept — the model's own bytes are appended straight onto it.
  it('opens a (streaming) block with an empty body and a trailing space', () => {
    expect(replyLine({ being: 'egpt', body: '', streaming: true, now: NOW, ...CHAT }))
      .toBe('egpt@[SPOILER ALERT: chat de EyAy].wa (19:07): (streaming) ');
  });

  // The reply line's clock is the SAME transcript clock as the inbound line's — literally the
  // same `hhmm` now, since both go through formatDispatchLine — and must read in the same
  // configured zone (config `default_time_zone`). Absent / invalid → UTC (operator 2026-07-26).
  it('renders the configured zone, not UTC', () => {
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, timeZone: 'America/New_York', ...CHAT })).toContain('(15:07): hi');
  });
  it('no zone → UTC', () => {
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, ...CHAT })).toContain('(19:07): hi');
  });
  it('an invalid zone never throws — it falls back to UTC', () => {
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, timeZone: 'Nope/Nope', ...CHAT })).toContain('(19:07): hi');
  });
});

// ── THE MONTHS ALREADY ON DISK (2026-08-28) ──────────────────────────────────
// Nothing written before the shape changes is ever rewritten — transcript.md is append-only by
// contract — so the operator's live files are old blocks above and new blocks below, in ONE
// file, forever. Every reader therefore understands EVERY shape, permanently; this is not a
// migration window. A shape change that outran its parsers would silently break accum context
// and message lookup on months of history.
describe('OLDER-shape reply lines already on disk stay readable', () => {
  const OLD = (being, body, t = '23:32') => `[@${being} (${t})]: ${body}`;             // pre-2026-08-28 reply template
  const SIGIL = (being, body, t = '23:32') => `@${being}@[fam].wa (${t}): ${body}`;    // the one-shape line, before the sigil went
  const REC = (...lines) => ['---', 'name: fam', 'surface: wa', '---', '', ...lines, ''].join('\n');

  it('contextSinceLastTurn: an old reply line is still the accum boundary', () => {
    const { blocks } = contextSinceLastTurn(REC(
      'An@[fam].wa (22:00) #42: antes del turno', '',
      OLD('egpt.kg', 'mi último turno', '22:05'), '',
      'Bea@[fam].wa (22:10) #43: lo que me perdí',
    ), { being: 'egpt' });
    expect(blocks).toEqual(['Bea@[fam].wa (22:10) #43: lo que me perdí']);
  });

  // REPRODUCE-FIRST: the realistic straddling file — the head is the OLD `[@egpt.kg (07:36)]:`
  // shape, the tail is the NEW bare-name one. The boundary must be found in whichever shape it
  // is written, or accum re-feeds the being everything it has already seen.
  it('contextSinceLastTurn: a file whose tail is the NEW shape and whose head is the OLD one', () => {
    const doc = REC(
      'An@[fam].wa (07:00) #40: hace rato', '',
      OLD('egpt.kg', 'turno viejo', '07:05'), '',
      'An@[fam].wa (07:30) #41: y ahora', '',
      'egpt@[fam].wa (07:36): mi último turno', '',
      'Bea@[fam].wa (07:40) #43: lo que me perdí',
    );
    expect(contextSinceLastTurn(doc, { being: 'egpt' }).blocks)
      .toEqual(['Bea@[fam].wa (07:40) #43: lo que me perdí']);
  });

  // The being whose NAME and map KEY differ (DOLLY: keyed `egpt`, `name: don`) writes `don` now
  // and wrote `@egpt.do` before. The caller hands BOTH labels; either one is the boundary.
  it('contextSinceLastTurn: the boundary matches on EITHER the name or the being-key', () => {
    const olds = REC(
      'An@[fam].wa (22:00) #42: antes', '',
      SIGIL('egpt.do', 'turno viejo, etiquetado con la key', '22:05'), '',
      'Bea@[fam].wa (22:10) #43: después',
    );
    expect(contextSinceLastTurn(olds, { being: ['don', 'egpt'] }).blocks)
      .toEqual(['Bea@[fam].wa (22:10) #43: después']);
    const news = REC(
      'An@[fam].wa (22:00) #42: antes', '',
      'don@[fam].wa (22:05): mi turno, etiquetado con el nombre', '',
      'Bea@[fam].wa (22:10) #43: después',
    );
    expect(contextSinceLastTurn(news, { being: ['don', 'egpt'] }).blocks)
      .toEqual(['Bea@[fam].wa (22:10) #43: después']);
  });

  it('bodyForMessageId: an old reply head still terminates the entry above it', () => {
    const doc = REC(
      'An@[fam].wa (22:00) #42: hola\ncontinúa aquí', '',
      OLD('egpt.kg', 'la respuesta', '22:05'),
    );
    expect(bodyForMessageId(doc, '42')).toBe('hola\ncontinúa aquí');
  });

  // _ENTRY_HEAD already carried `@?`, so the bare speaker needs nothing from it — locked, not
  // rewritten: a NEW reply head must still terminate the entry above it, and be findable itself.
  it('bodyForMessageId: a BARE-name reply head terminates the entry above it, and is itself an entry', () => {
    const doc = REC(
      'An@[fam].wa (22:00) #42: hola\ncontinúa aquí', '',
      'egpt@[fam].wa (22:05) #43: la respuesta',
    );
    expect(bodyForMessageId(doc, '42')).toBe('hola\ncontinúa aquí');
    expect(bodyForMessageId(doc, '43')).toBe('la respuesta');
  });
});

// End-to-end on a temp transcript: a received Telegram message MUST appear in
// the file. If the logging path stops writing (re-regression of C1.2), the
// assertion that the message is in the transcript fails.
describe('a received message lands in transcript.md', () => {
  it('inbound + reply both end up in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tlog-'));
    const fpath = join(dir, 'transcript.md');
    const inbound = '[2026-06-13 20:19 UTC, in Telegram chat -5136707031, An said:]\nwren, you back?';
    appendFileSync(fpath, transcriptAppend({ existing: existsSync(fpath), body: inbound, name: 'DOLLY-REVE', surface: 'tg', slug: 'dolly-reve', chatId: '-5136707031', persona: 'wren' }));
    appendFileSync(fpath, transcriptAppend({ existing: existsSync(fpath), body: replyLine({ being: 'wren', body: 'Back and live.', surfaced: true, chatName: 'DOLLY-REVE', node: 'tg' }) }));
    const t = readFileSync(fpath, 'utf8');
    expect(t).toContain('wren, you back?');     // the received message is logged
    expect(t).toContain('wren@[DOLLY-REVE].tg'); // and the reply, in the one line shape
    expect(t).toMatch(/^---\n/);                 // with front matter
  });
});
