// Locks C1.2 / I3 (limb-agnostic logging): a received message — or a reply,
// surfaced or withheld — MUST land in the chat's transcript. The bot→Wren
// forceTarget route regressed this for Telegram (2026-06-12); these tests make
// "logged nothing for a received message" a hard failure, not a silent no-op.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptAppend, replyLine, lastSurfacedBeing, contextSinceLastTurn, bodyForMessageId } from '../src/transcript-log.mjs';
// The REAL codec + renderer a co-account peer's reply travels through (persona-wrap appends the
// invisible frame outbound, identity.build renders it to `<node>` inbound) — so the shape the
// walk keys on is derived from its writers, never hand-typed.
import { encodeNodeSignature, renderNodeSignature } from '../src/node-signature.mjs';

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

// ── ONE LINE SHAPE FOR THE WHOLE FILE (operator 2026-08-28) ──────────────────
// The record used to carry TWO shapes — the inbound `Sender@[chat].node (HH:MM) #id: body`
// and a reply-only `[@being (HH:MM)]: body` — and the operator, reading a live transcript,
// ruled: "the correct format is 'e' outside the [], and better egpt instead of e". A being's
// utterance now reads like every other utterance, through the SAME formatter (formatDispatchLine),
// so the two halves cannot drift apart again.
describe('replyLine — the unified line shape', () => {
  const NOW = new Date(Date.UTC(2026, 6, 25, 19, 7, 0));
  const CHAT = { chatName: 'SPOILER ALERT: chat de EyAy', node: 'wa' };

  // The operator's own target line, byte for byte (with the node provenance he was not ruling
  // on — see the provenance test below).
  it('REPRODUCE-FIRST: speaker OUTSIDE the brackets, chat inside, surface tag, time, message id', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'No, no te creería sin evidencia', now: NOW, msgId: '202360', ...CHAT }))
      .toBe('@egpt.kg@[SPOILER ALERT: chat de EyAy].wa (19:07) #202360: No, no te creería sin evidencia');
  });

  // The label is the being's `agents:` MAP KEY, never one of its handles. `e` is a handle;
  // `egpt` is the being. Nothing here invents that — the caller passes the id — but the
  // transcript service's FALLBACK used to be the handle, and this is the shape that showed it.
  it('renders the being-id it is handed, not a handle', () => {
    expect(replyLine({ being: 'egpt', body: 'hi', now: NOW, ...CHAT })).toContain('@egpt@[');
  });

  // TWO NODES SHARE ONE BEEPER ACCOUNT (operator 2026-07-10), so the record must still say
  // WHICH one produced a line. The qualifier rides the speaker, where it always did.
  it('node provenance survives: <being>.<node_name> is the speaker', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, ...CHAT }))
      .toBe('@egpt.kg@[SPOILER ALERT: chat de EyAy].wa (19:07): hi');
    expect(replyLine({ being: 'wren.do', body: 'hi', now: NOW, ...CHAT })).toContain('@wren.do@[');
  });

  // `#<id>` is what makes a line addressable for /react and /reply (MESSAGES-FIRST-CLASS).
  // Omitted when there is none — which is every caller today, since the spine records a reply
  // BEFORE delivering it and no id exists yet.
  it('carries #<id> when there is one and omits it when there is not', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, msgId: '202360', ...CHAT })).toContain('(19:07) #202360: hi');
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, ...CHAT })).toContain('(19:07): hi');
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, ...CHAT })).not.toContain('#');
  });

  it('tags a withheld reply, leaves a surfaced one clean', () => {
    expect(replyLine({ being: 'wren', body: 'hi', surfaced: true, now: NOW, ...CHAT })).toBe('@wren@[SPOILER ALERT: chat de EyAy].wa (19:07): hi');
    expect(replyLine({ being: 'wren', body: 'hi', surfaced: false, now: NOW, ...CHAT })).toContain(': (not surfaced) hi');
  });

  // The RAW BYTE TRAIN block header (operator 2026-08-27): empty body, tag in the same slot,
  // trailing space kept — the model's own bytes are appended straight onto it.
  it('opens a (streaming) block with an empty body and a trailing space', () => {
    expect(replyLine({ being: 'egpt.kg', body: '', streaming: true, now: NOW, ...CHAT }))
      .toBe('@egpt.kg@[SPOILER ALERT: chat de EyAy].wa (19:07): (streaming) ');
  });

  // The reply line's clock is the SAME transcript clock as the inbound line's — literally the
  // same `hhmm` now, since both go through formatDispatchLine — and must read in the same
  // configured zone (config `default_time_zone`). Absent / invalid → UTC (operator 2026-07-26).
  it('renders the configured zone, not UTC', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, timeZone: 'America/New_York', ...CHAT })).toContain('(15:07): hi');
  });
  it('no zone → UTC', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, ...CHAT })).toContain('(19:07): hi');
  });
  it('an invalid zone never throws — it falls back to UTC', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, timeZone: 'Nope/Nope', ...CHAT })).toContain('(19:07): hi');
  });
});

// ── lastSurfacedBeing — who `r` addresses, read back out of the record ────────
// (operator 2026-07-27: "r is static, it searches the transcript".) The reader keys on the
// shape replyLine WRITES, which is why it lives in this module beside it.
describe('lastSurfacedBeing', () => {
  const REC = (...lines) => ['---', 'name: fam', 'surface: wa', '---', '', ...lines, ''].join('\n');
  // A being's line in the CURRENT shape (2026-08-28): the same shape a human's line has, told
  // apart by the `@` sigil on the speaker. `t` is the time, `tail` an optional ` #<id>` tag.
  const AGENT = (being, body, { t = '23:32', tail = '' } = {}) => `@${being}@[fam].wa (${t})${tail}: ${body}`;

  it('the LAST agent line wins, and the node qualifier is stripped (`egpt.kg` → `egpt`)', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('wren.kg', 'primero', { t: '23:30' }), '',
      'An@[fam].wa (23:31) #m1: y tú?', '',
      AGENT('egpt.kg', 'después'),
    ))).toBe('egpt');
  });

  it('a bare being label (no node qualifier) reads the same', () => {
    expect(lastSurfacedBeing(REC(AGENT('wren', 'hola', { t: '23:30' })))).toBe('wren');
  });

  it('a reply carrying its own #<id> is still an agent line', () => {
    expect(lastSurfacedBeing(REC(AGENT('egpt.kg', 'con id', { tail: ' #202360' })))).toBe('egpt');
  });

  // THE REASON THE `@` SIGIL EXISTS. A being's line and a human's line are now the SAME shape,
  // so without it this walk would land on whoever spoke last — usually a person — and `r` would
  // stop resolving the moment anyone said anything after E. (operator 2026-07-26: "'r' should
  // reply to last bot message"; human lines in between are irrelevant.)
  it('HUMAN LINES IN BETWEEN ARE IRRELEVANT — the walk asks only for agent lines', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('egpt.kg', 'Ayudo porque quiero'), '',
      'Andrés@[fam].wa (23:35) #m1: hsjshsj', '',
      'An@[fam].wa (00:02) #m2: y esto?',
    ))).toBe('egpt');
  });

  // The tag opening the body is the filter: that turn ran, but nobody in the chat saw it.
  it('a WITHHELD reply is skipped for the last SURFACED one', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('wren.kg', 'se dijo', { t: '23:30' }), '',
      AGENT('egpt.kg', '(not surfaced) nadie vio esto'),
    ))).toBe('wren');
  });

  // The RAW BYTE TRAIN of a turn is not a message either — the settled line below it carries
  // the authority. Without this skip a WITHHELD turn would claim the floor through its own train.
  it('a (streaming) block is skipped too', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('wren.kg', 'se dijo', { t: '23:30' }), '',
      AGENT('egpt.kg', '(streaming) pensando en voz alta'),
    ))).toBe('wren');
  });

  it('every reply withheld, or none at all → null (there `r …` addresses nobody)', () => {
    expect(lastSurfacedBeing(REC(AGENT('egpt.kg', '(not surfaced) nada')))).toBeNull();
    expect(lastSurfacedBeing(REC('An@[fam].wa (23:31) #m1: solo humanos'))).toBeNull();
    expect(lastSurfacedBeing('')).toBeNull();
    expect(lastSurfacedBeing(null)).toBeNull();
  });

  // The front matter is dropped with the shared stripFrontMatter, and a stage-direction wrap
  // ("[ Sender@… ]") is not an agent line: it has no `@` sigil on the speaker.
  it('an inbound stage-direction is not an agent line', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('wren.kg', 'hola', { t: '23:30' }), '',
      '[ An@[fam].wa (23:31) #m1: reaccionó 👍 a #m0 ]',
    ))).toBe('wren');
  });

  // A multi-line reply stays ONE block (both writers end `\n\n`), so its continuation lines are
  // never read as entries of their own.
  it('a multi-line reply is one block — its body lines are not candidates', () => {
    expect(lastSurfacedBeing(REC(
      `${AGENT('egpt.kg', 'primera línea')}\n${AGENT('fake', 'esto es texto, no una entrada', { t: '11:11' })}`,
    ))).toBe('egpt');
  });

  // What replyLine actually writes, round-tripped rather than hand-typed.
  it('round-trips replyLine itself, surfaced and withheld', () => {
    expect(lastSurfacedBeing(`${replyLine({ being: 'egpt.kg', body: 'hola', chatName: 'fam', node: 'wa' })}\n\n`)).toBe('egpt');
    expect(lastSurfacedBeing(`${replyLine({ being: 'egpt.kg', body: 'hola', surfaced: false, chatName: 'fam', node: 'wa' })}\n\n`)).toBeNull();
    expect(lastSurfacedBeing(`${replyLine({ being: 'egpt.kg', body: '', streaming: true, chatName: 'fam', node: 'wa' })}\n\n`)).toBeNull();
  });

  // ── CO-ACCOUNT NODES (operator 2026-07-27, LIVE: both nodes answered ONE `r`) ──────────────
  // A peer's reply is not an agent line HERE — on a shared Beeper account it arrives as an
  // ordinary INBOUND line (isSender, displayed as the account owner) whose body carries the
  // peer's structural signature, which identity.build renders to a legible `<node>` before
  // anything reads it. The line below is that shape, built through the REAL codec + renderer.
  const PEER = (node, body) => `An@[fam].wa (00:41) #m9: 🐶 ${node}\n`
    + renderNodeSignature(`${body}${encodeNodeSignature(node)}`);

  it('REPRODUCE-FIRST: the PEER node answered last → null, this node does not claim the `r`', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('egpt.kg', 'Pescado Rabioso arrancó en 1971', { t: '00:41' }), '',
      PEER('do', "The question's already been answered"),
    ), { node: 'kg' })).toBeNull();
  });

  it('REPRODUCE-FIRST (mirror): the peer answered first, WE answered last → our being', () => {
    expect(lastSurfacedBeing(REC(
      PEER('do', 'esa ya la contesté yo'), '',
      AGENT('egpt.kg', 'y yo agrego esto', { t: '00:42' }),
    ), { node: 'kg' })).toBe('egpt');
  });

  // OUR OWN signature is not a peer's. Our reply carries `<kg>` on the wire, so if it ever
  // re-enters as an inbound line (the bridge's own-send gate is id-based and can miss an
  // UNCONFIRMED send) the walk must see OUR frame and keep going to our own reply line.
  it('this node recognises its OWN rendered signature and still answers', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('egpt.kg', 'lo dije yo', { t: '00:41' }), '',
      PEER('kg', 'lo dije yo'),
    ), { node: 'kg' })).toBe('egpt');
  });

  // Case matters no more here than it does on a being-id.
  it('the node comparison is case-insensitive', () => {
    expect(lastSurfacedBeing(REC(AGENT('egpt.KG', 'mío', { t: '00:41' }), '', PEER('KG', 'mío')), { node: 'kg' })).toBe('egpt');
  });

  // No node given (an un-wired caller): ANY signed line is treated as another node's. That is
  // the SAFE direction — a missed `r` beats two nodes answering one message.
  it('no node given → any signed line is another node', () => {
    expect(lastSurfacedBeing(REC(AGENT('egpt.kg', 'lo dije yo', { t: '00:41' }), '', PEER('kg', 'lo dije yo')))).toBeNull();
  });

  // An UNSIGNED inbound line is a human's and stays irrelevant, whatever it says.
  it('a human line is never a bot message, even one that mentions a node', () => {
    expect(lastSurfacedBeing(REC(
      AGENT('egpt.kg', 'mío', { t: '00:41' }), '',
      'An@[fam].wa (00:42) #m9: y el nodo do qué dijo?',
    ), { node: 'kg' })).toBe('egpt');
  });
});

// ── THE MONTHS ALREADY ON DISK (2026-08-28) ──────────────────────────────────
// Nothing written before the shape change is ever rewritten — transcript.md is append-only by
// contract — so the operator's live files are old blocks above and new blocks below, in ONE
// file, forever. Every reader therefore understands BOTH shapes, permanently; this is not a
// migration window. A shape change that outran its parsers would silently break quick-reply,
// accum context and message lookup on months of history.
describe('OLD-shape reply lines already on disk stay readable', () => {
  const OLD = (being, body, t = '23:32') => `[@${being} (${t})]: ${body}`;
  const REC = (...lines) => ['---', 'name: fam', 'surface: wa', '---', '', ...lines, ''].join('\n');

  it('lastSurfacedBeing: the old `[@being (HH:MM)]:` head is still an agent line', () => {
    expect(lastSurfacedBeing(REC(OLD('egpt.kg', 'viejo')))).toBe('egpt');
    expect(lastSurfacedBeing(REC(OLD('wren', 'sin nodo')))).toBe('wren');
  });

  it('lastSurfacedBeing: old (not surfaced) / (streaming) tags are still skipped', () => {
    expect(lastSurfacedBeing(REC(OLD('wren.kg', 'se dijo', '23:30'), '', OLD('egpt.kg', '(not surfaced) nadie')))).toBe('wren');
    expect(lastSurfacedBeing(REC(OLD('wren.kg', 'se dijo', '23:30'), '', OLD('egpt.kg', '(streaming) tren')))).toBe('wren');
  });

  // The realistic file: history in the old shape, everything after the change in the new one.
  it('a MIXED file reads end to end, newest block winning either way', () => {
    expect(lastSurfacedBeing(REC(
      OLD('wren.kg', 'antes', '23:30'), '',
      '@egpt.kg@[fam].wa (23:32): después',
    ))).toBe('egpt');
    expect(lastSurfacedBeing(REC(
      '@egpt.kg@[fam].wa (23:30): antes', '',
      OLD('wren.kg', 'después', '23:40'),
    ))).toBe('wren');
  });

  it('contextSinceLastTurn: an old reply line is still the accum boundary', () => {
    const { blocks } = contextSinceLastTurn(REC(
      'An@[fam].wa (22:00) #42: antes del turno', '',
      OLD('egpt.kg', 'mi último turno', '22:05'), '',
      'Bea@[fam].wa (22:10) #43: lo que me perdí',
    ), { being: 'egpt' });
    expect(blocks).toEqual(['Bea@[fam].wa (22:10) #43: lo que me perdí']);
  });

  it('bodyForMessageId: an old reply head still terminates the entry above it', () => {
    const doc = REC(
      'An@[fam].wa (22:00) #42: hola\ncontinúa aquí', '',
      OLD('egpt.kg', 'la respuesta', '22:05'),
    );
    expect(bodyForMessageId(doc, '42')).toBe('hola\ncontinúa aquí');
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
    expect(t).toContain('@wren@[DOLLY-REVE].tg');// and the reply, in the one line shape
    expect(t).toMatch(/^---\n/);                 // with front matter
  });
});
