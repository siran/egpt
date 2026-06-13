// Locks C1.2 / I3 (limb-agnostic logging): a received message — or a reply,
// surfaced or withheld — MUST land in the chat's transcript. The bot→Wren
// forceTarget route regressed this for Telegram (2026-06-12); these tests make
// "logged nothing for a received message" a hard failure, not a silent no-op.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptAppend, replyLine } from '../src/transcript-log.mjs';

describe('transcriptAppend', () => {
  it('a new transcript gets the front matter + the line', () => {
    const out = transcriptAppend({ existing: false, body: 'hola wren', name: 'DOLLY-REVE', surface: 'tg', slug: 'dolly-reve', threadId: '-5136707031', persona: 'wren' });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('surface: tg');
    expect(out).toContain('persona: wren');
    expect(out).toContain('hola wren');
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
});

// End-to-end on a temp transcript: a received Telegram message MUST appear in
// the file. If the logging path stops writing (re-regression of C1.2), the
// assertion that the message is in the transcript fails.
describe('a received message lands in transcript.md', () => {
  it('inbound + reply both end up in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tlog-'));
    const fpath = join(dir, 'transcript.md');
    const inbound = '[2026-06-13 20:19 UTC, in Telegram chat -5136707031, An said:]\nwren, you back?';
    appendFileSync(fpath, transcriptAppend({ existing: existsSync(fpath), body: inbound, name: 'DOLLY-REVE', surface: 'tg', slug: 'dolly-reve', threadId: '-5136707031', persona: 'wren' }));
    appendFileSync(fpath, transcriptAppend({ existing: existsSync(fpath), body: replyLine({ being: 'wren', body: 'Back and live.', surfaced: true }) }));
    const t = readFileSync(fpath, 'utf8');
    expect(t).toContain('wren, you back?');     // the received message is logged
    expect(t).toContain('[@wren');               // and the reply
    expect(t).toMatch(/^---\n/);                 // with front matter
  });
});
