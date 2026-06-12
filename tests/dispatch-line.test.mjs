// CONTRACT C7.6 — the identity line every brain sees for an inbound message:
//   Sender@[chatname/groupname].{node} (HH:MM): body
// {node} = the ENTRY POINT (wa/kg/chrome), resolved from the surface/client
// identity, NEVER hardcoded. This test is what keeps the shape from drifting
// back to a baked-in '.wa' or to bracket-less / node-less variants.
import { describe, it, expect } from 'vitest';
import { formatDispatchLine, splitSurfaceTag } from '../src/dispatch-line.mjs';

// 2026-06-11 17:21 UTC — fixed so the HH:MM (UTC) assertion is deterministic.
const TS = Date.UTC(2026, 5, 11, 17, 21, 0);

describe('formatDispatchLine — canonical shape', () => {
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
