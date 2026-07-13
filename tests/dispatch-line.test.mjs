// CONTRACT C7.6 — the identity line every brain sees for an inbound message:
//   Sender@[chatname/groupname].{node} (HH:MM): body
// {node} = the ENTRY POINT (wa/kg/chrome), resolved from the surface/client
// identity, NEVER hardcoded. This test is what keeps the shape from drifting
// back to a baked-in '.wa' or to bracket-less / node-less variants.
import { describe, it, expect } from 'vitest';
import { formatDispatchLine, splitSurfaceTag, reactionAction, editAction } from '../src/dispatch-line.mjs';

// 2026-06-11 17:21 UTC — fixed so the HH:MM (UTC) assertion is deterministic.
const TS = Date.UTC(2026, 5, 11, 17, 21, 0);

describe('formatDispatchLine — canonical shape', () => {
  // MESSAGES-FIRST-CLASS-PLAN Phase 1: an optional msg id makes the line
  // addressable (#<id>) for /react · /reply · reaction references.
  it('renders #<id> when msgId is given, and is unchanged when absent', () => {
    expect(formatDispatchLine({ senderName: 'Ron', chatName: 'HFM', node: 'wa', body: 'hola', ts: TS, msgId: '142006' }))
      .toBe('Ron@[HFM].wa (17:21) #142006: hola');
    expect(formatDispatchLine({ senderName: 'Ron', chatName: 'HFM', node: 'wa', body: 'hola', ts: TS }))
      .toBe('Ron@[HFM].wa (17:21): hola');
    expect(formatDispatchLine({ senderName: 'Ron', chatName: 'HFM', node: 'wa', body: 'x', ts: TS, msgId: '' }))
      .toBe('Ron@[HFM].wa (17:21): x');   // empty id → omitted
  });

  // Reply reference (operator 2026-07-04): a quoted reply renders `↩#<id>` after the
  // msg id so the model sees which message is being answered (and can target it back
  // via a /reply emit action). Omitted when absent (back-compat).
  it('renders ↩#<id> for a reply, after the msg id; omitted when absent', () => {
    expect(formatDispatchLine({ senderName: 'Bea', chatName: 'HFM', node: 'wa', body: 'gracias', ts: TS, msgId: '157267', replyToId: '157204' }))
      .toBe('Bea@[HFM].wa (17:21) #157267 ↩#157204: gracias');
    expect(formatDispatchLine({ senderName: 'Bea', chatName: 'HFM', node: 'wa', body: 'gracias', ts: TS, msgId: '157267' }))
      .toBe('Bea@[HFM].wa (17:21) #157267: gracias');
    // a stage-direction never carries the ↩ tag (it references its own target)
    expect(formatDispatchLine({ senderName: 'Bea', chatName: 'HFM', node: 'wa', ts: TS, replyToId: '9', stageDirection: true, body: 'x' }))
      .toBe('[ Bea@[HFM].wa (17:21): x ]');
  });

  it('is exactly Sender@[chatname].{node} (HH:MM): body', () => {
    expect(formatDispatchLine({
      senderName: 'An', chatName: 'HFM High Frequency', node: 'wa', body: 'hola', ts: TS,
    })).toBe('An@[HFM High Frequency].wa (17:21): hola');
  });

  it('the node is NOT hardcoded — it follows the entry point', () => {
    const base = { senderName: 'An', chatName: 'notes', body: 'hi', ts: TS };
    expect(formatDispatchLine({ ...base, node: 'wa' })).toBe('An@[notes].wa (17:21): hi');
    expect(formatDispatchLine({ ...base, node: 'kg' })).toBe('An@[notes].kg (17:21): hi');     // home shell
    expect(formatDispatchLine({ ...base, node: 'chrome' })).toBe('An@[notes].chrome (17:21): hi'); // extension
  });

  it('a voice note body passes through verbatim (caller prefixes the transcription tag)', () => {
    expect(formatDispatchLine({
      senderName: 'An', chatName: 'HFM High Frequency', node: 'wa',
      body: '(voice transcription, 26s) bla bla', ts: TS,
    })).toBe('An@[HFM High Frequency].wa (17:21): (voice transcription, 26s) bla bla');
  });

  it('HH:MM is UTC and zero-padded', () => {
    expect(formatDispatchLine({ senderName: 'A', chatName: 'c', node: 'wa', body: 'x',
      ts: Date.UTC(2026, 0, 1, 3, 5, 0) })).toBe('A@[c].wa (03:05): x');
  });

  it('fail-safe defaults: missing sender -> someone, missing node -> wa', () => {
    expect(formatDispatchLine({ chatName: 'c', body: 'x', ts: TS })).toBe('someone@[c].wa (17:21): x');
  });
});

describe('formatDispatchLine — stage-direction (reactions etc.)', () => {
  // MESSAGES-FIRST-CLASS-PLAN Phase 2: a meta-event is wrapped in outer brackets
  // (theater-play model) so it reads as a stage-direction, not an utterance.
  it('wraps the body in [ … ] and carries no #<id> tag (the id is in the action)', () => {
    expect(formatDispatchLine({
      senderName: 'An', chatName: 'HFM', node: 'wa', ts: TS, msgId: '142379',
      stageDirection: true, body: reactionAction({ emoji: '👍', targetId: '142378', snippet: 'ron is bold person' }),
    })).toBe('[ An@[HFM].wa (17:21): reacted 👍 to #142378 "ron is bold person" ]');
  });
});

describe('reactionAction — reaction stage-direction body', () => {
  it('renders "reacted <emoji> to #<id> \"<snippet>\""', () => {
    expect(reactionAction({ emoji: '👍', targetId: '142378', snippet: 'hola mundo' }))
      .toBe('reacted 👍 to #142378 "hola mundo"');
  });
  it('omits the quote when there is no snippet, collapses whitespace, trims length', () => {
    expect(reactionAction({ emoji: '❤️', targetId: '7' })).toBe('reacted ❤️ to #7');
    expect(reactionAction({ emoji: '😂', targetId: '7', snippet: '  a\n b   c ' })).toBe('reacted 😂 to #7 "a b c"');
    expect(reactionAction({ emoji: '👍', targetId: '7', snippet: 'x'.repeat(80) })).toContain('"' + 'x'.repeat(60) + '"');
  });
  it('falls back to ❓ when the emoji is missing', () => {
    expect(reactionAction({ targetId: '7', snippet: 'hi' })).toBe('reacted ❓ to #7 "hi"');
  });
});

describe('editAction — edit stage-direction body', () => {
  it('renders the old/new change as a two-line -/+ diff', () => {
    expect(editAction({ targetId: '142438', oldText: 'imbécil', newText: 'pobrecito' }))
      .toBe('edited #142438\n    - imbécil\n    + pobrecito');
  });
  it('collapses whitespace but does NOT truncate long text', () => {
    expect(editAction({ targetId: '7', oldText: '  a\n b ', newText: 'c   d' }))
      .toBe('edited #7\n    - a b\n    + c d');
    expect(editAction({ targetId: '7', oldText: 'x'.repeat(80), newText: 'y' }))
      .toContain('- ' + 'x'.repeat(80));
  });
  // Reproduce-first: a completion/append/late-typo fix changes text PAST char
  // 50. The old `.slice(0, 50)` collapsed old/new to the SAME prefix, so the
  // edit read as "X" → "X" — invisible. The new output must show BOTH full
  // strings, and they must differ in the rendered result.
  it('a change beyond char 50 stays visible (the slice(0,50) bug this replaces)', () => {
    const prefix = 'a'.repeat(60); // common prefix, well past the old 50-char slice
    const oldText = `${prefix} old tail`;
    const newText = `${prefix} new tail`;
    // what the old .slice(0, 50) behavior would have produced: identical prefixes
    const oldSliced = oldText.slice(0, 50);
    const newSliced = newText.slice(0, 50);
    expect(oldSliced).toBe(newSliced); // confirms the bug: truncation collapses them

    const rendered = editAction({ targetId: '9', oldText, newText });
    expect(rendered).toBe(`edited #9\n    - ${oldText}\n    + ${newText}`);
    expect(rendered).toContain('old tail');
    expect(rendered).toContain('new tail');
  });
});

describe('formatDispatchLine — derives {node,name} from a legacy surface tag', () => {
  // Back-compat: callers that still pass only `surface` (dispatch.mjs,
  // slash/rules.mjs) must still produce the canonical shape.
  it('group tag "<slug>.wa" -> [slug].wa', () => {
    expect(formatDispatchLine({ senderName: 'An', surface: 'compren_bitcoin.wa', body: 'x', ts: TS }))
      .toBe('An@[compren_bitcoin].wa (17:21): x');
  });
  it('status tag "status.wa" -> [status].wa', () => {
    expect(formatDispatchLine({ senderName: 'An', surface: 'status.wa', body: 'x', ts: TS }))
      .toBe('An@[status].wa (17:21): x');
  });
  it('DM/fallback tag "wa.<jid>" (node FIRST) -> [<jid>].wa', () => {
    expect(formatDispatchLine({ senderName: 'An', surface: 'wa.16468217865', body: 'x', ts: TS }))
      .toBe('An@[16468217865].wa (17:21): x');
  });
  it('explicit chatName/node OVERRIDE whatever the surface implies', () => {
    expect(formatDispatchLine({ senderName: 'An', surface: 'wa.16468217865', chatName: 'Mauricio', node: 'wa', body: 'x', ts: TS }))
      .toBe('An@[Mauricio].wa (17:21): x');
  });
});

describe('splitSurfaceTag', () => {
  it('node-last, node-first, bare, empty', () => {
    expect(splitSurfaceTag('compren_bitcoin.wa')).toEqual({ name: 'compren_bitcoin', node: 'wa' });
    expect(splitSurfaceTag('status.wa')).toEqual({ name: 'status', node: 'wa' });
    expect(splitSurfaceTag('wa.16468217865')).toEqual({ name: '16468217865', node: 'wa' });
    expect(splitSurfaceTag('kg')).toEqual({ name: '', node: 'kg' });
    expect(splitSurfaceTag('')).toEqual({ name: '', node: '' });
  });
});
