// Locks C1.2 / I3 (limb-agnostic logging): a received message — or a reply,
// surfaced or withheld — MUST land in the chat's transcript. The bot→Wren
// forceTarget route regressed this for Telegram (2026-06-12); these tests make
// "logged nothing for a received message" a hard failure, not a silent no-op.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptAppend, replyLine, lastSurfacedBeing } from '../src/transcript-log.mjs';
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

describe('replyLine', () => {
  it('tags a withheld reply, leaves a surfaced one clean', () => {
    expect(replyLine({ being: 'wren', body: 'hi', surfaced: true })).toMatch(/^\[@wren \(\d\d:\d\d\)\]: hi$/);
    expect(replyLine({ being: 'wren', body: 'hi', surfaced: false })).toContain('(not surfaced) hi');
  });

  // The reply line's clock is the SAME transcript clock as the inbound line's
  // (dispatch-line.mjs) and must read in the same configured zone — config
  // `default_time_zone`, resolved by the heartbeat loader's resolveTimeZone. Absent /
  // invalid → UTC, exactly as before (operator 2026-07-26).
  const NOW = new Date(Date.UTC(2026, 6, 25, 19, 7, 0));
  it('renders the configured zone, not UTC', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, timeZone: 'America/New_York' })).toBe('[@egpt.kg (15:07)]: hi');
  });
  it('no zone → UTC, byte-identical to before', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW })).toBe('[@egpt.kg (19:07)]: hi');
  });
  it('an invalid zone never throws — it falls back to UTC', () => {
    expect(replyLine({ being: 'egpt.kg', body: 'hi', now: NOW, timeZone: 'Nope/Nope' })).toBe('[@egpt.kg (19:07)]: hi');
  });
});

// ── lastSurfacedBeing — who `r` addresses, read back out of the record ────────
// (operator 2026-07-27: "r is static, it searches the transcript".) The reader keys on the
// shape replyLine WRITES, which is why it lives in this module beside it.
describe('lastSurfacedBeing', () => {
  const REC = (...lines) => ['---', 'name: fam', 'surface: wa', '---', '', ...lines, ''].join('\n');

  it('the LAST agent line wins, and the node qualifier is stripped (`egpt.kg` → `egpt`)', () => {
    expect(lastSurfacedBeing(REC(
      '[@wren.kg (23:30)]: primero', '',
      'An@[fam].wa (23:31) #m1: y tú?', '',
      '[@egpt.kg (23:32)]: después',
    ))).toBe('egpt');
  });

  it('a bare being label (no node qualifier) reads the same', () => {
    expect(lastSurfacedBeing(REC('[@wren (23:30)]: hola'))).toBe('wren');
  });

  it('HUMAN LINES IN BETWEEN ARE IRRELEVANT — the walk asks only for agent lines', () => {
    expect(lastSurfacedBeing(REC(
      '[@egpt.kg (23:32)]: Ayudo porque quiero', '',
      'Andrés@[fam].wa (23:35) #m1: hsjshsj', '',
      'An@[fam].wa (00:02) #m2: y esto?',
    ))).toBe('egpt');
  });

  // The tag right after the `]:` is the filter: that turn ran, but nobody in the chat saw it.
  it('a WITHHELD reply is skipped for the last SURFACED one', () => {
    expect(lastSurfacedBeing(REC(
      '[@wren.kg (23:30)]: se dijo', '',
      '[@egpt.kg (23:32)]: (not surfaced) nadie vio esto',
    ))).toBe('wren');
  });

  it('every reply withheld, or none at all → null (there `r …` addresses nobody)', () => {
    expect(lastSurfacedBeing(REC('[@egpt.kg (23:32)]: (not surfaced) nada'))).toBeNull();
    expect(lastSurfacedBeing(REC('An@[fam].wa (23:31) #m1: solo humanos'))).toBeNull();
    expect(lastSurfacedBeing('')).toBeNull();
    expect(lastSurfacedBeing(null)).toBeNull();
  });

  // The front matter is dropped with the shared stripFrontMatter, and an INBOUND dispatch line
  // can never be mistaken for a reply line: the `]:` terminator after the time is what separates
  // them (an inbound line carries ` #<id>:` there instead).
  it('an inbound line that starts with `[` is not an agent line', () => {
    expect(lastSurfacedBeing(REC(
      '[@wren.kg (23:30)]: hola', '',
      '[ An@[fam].wa (23:31) #m1: reaccionó 👍 a #m0 ]',
    ))).toBe('wren');
  });

  // A multi-line reply stays ONE block (both writers end `\n\n`), so its continuation lines are
  // never read as entries of their own.
  it('a multi-line reply is one block — its body lines are not candidates', () => {
    expect(lastSurfacedBeing(REC(
      '[@egpt.kg (23:32)]: primera línea\n[@fake (11:11)]: esto es texto, no una entrada',
    ))).toBe('egpt');
  });

  // What replyLine actually writes, round-tripped rather than hand-typed.
  it('round-trips replyLine itself, surfaced and withheld', () => {
    expect(lastSurfacedBeing(`${replyLine({ being: 'egpt.kg', body: 'hola' })}\n\n`)).toBe('egpt');
    expect(lastSurfacedBeing(`${replyLine({ being: 'egpt.kg', body: 'hola', surfaced: false })}\n\n`)).toBeNull();
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
      '[@egpt.kg (00:41)]: Pescado Rabioso arrancó en 1971', '',
      PEER('do', "The question's already been answered"),
    ), { node: 'kg' })).toBeNull();
  });

  it('REPRODUCE-FIRST (mirror): the peer answered first, WE answered last → our being', () => {
    expect(lastSurfacedBeing(REC(
      PEER('do', 'esa ya la contesté yo'), '',
      '[@egpt.kg (00:42)]: y yo agrego esto',
    ), { node: 'kg' })).toBe('egpt');
  });

  // OUR OWN signature is not a peer's. Our reply carries `<kg>` on the wire, so if it ever
  // re-enters as an inbound line (the bridge's own-send gate is id-based and can miss an
  // UNCONFIRMED send) the walk must see OUR frame and keep going to our own reply line.
  it('this node recognises its OWN rendered signature and still answers', () => {
    expect(lastSurfacedBeing(REC(
      '[@egpt.kg (00:41)]: lo dije yo', '',
      PEER('kg', 'lo dije yo'),
    ), { node: 'kg' })).toBe('egpt');
  });

  // Case matters no more here than it does on a being-id.
  it('the node comparison is case-insensitive', () => {
    expect(lastSurfacedBeing(REC('[@egpt.KG (00:41)]: mío', '', PEER('KG', 'mío')), { node: 'kg' })).toBe('egpt');
  });

  // No node given (an un-wired caller): ANY signed line is treated as another node's. That is
  // the SAFE direction — a missed `r` beats two nodes answering one message.
  it('no node given → any signed line is another node', () => {
    expect(lastSurfacedBeing(REC('[@egpt.kg (00:41)]: lo dije yo', '', PEER('kg', 'lo dije yo')))).toBeNull();
  });

  // An UNSIGNED inbound line is a human's and stays irrelevant, whatever it says.
  it('a human line is never a bot message, even one that mentions a node', () => {
    expect(lastSurfacedBeing(REC(
      '[@egpt.kg (00:41)]: mío', '',
      'An@[fam].wa (00:42) #m9: y el nodo do qué dijo?',
    ), { node: 'kg' })).toBe('egpt');
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
    appendFileSync(fpath, transcriptAppend({ existing: existsSync(fpath), body: replyLine({ being: 'wren', body: 'Back and live.', surfaced: true }) }));
    const t = readFileSync(fpath, 'utf8');
    expect(t).toContain('wren, you back?');     // the received message is logged
    expect(t).toContain('[@wren');               // and the reply
    expect(t).toMatch(/^---\n/);                 // with front matter
  });
});
