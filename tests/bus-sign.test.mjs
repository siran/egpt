// tests/bus-sign.test.mjs — HMAC envelope for bus events.
// Phase 1 of bus security (signing only — no encryption).

import { describe, it, expect } from 'vitest';
import {
  canonicalize, canonicalString,
  generateKey, keyFromString, keyToString,
  signEvent, verifyEvent,
} from '../src/tools/bus-sign.mjs';

describe('canonicalize', () => {
  it('passes through primitives + null', () => {
    expect(canonicalize(1)).toBe(1);
    expect(canonicalize('s')).toBe('s');
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(true)).toBe(true);
  });

  it('sorts object keys recursively', () => {
    const a = { b: 1, a: 2, nested: { z: 9, y: 8 } };
    const c = canonicalize(a);
    expect(Object.keys(c)).toEqual(['a', 'b', 'nested']);
    expect(Object.keys(c.nested)).toEqual(['y', 'z']);
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('produces identical strings for equivalent objects', () => {
    expect(canonicalString({ a: 1, b: 2 })).toBe(canonicalString({ b: 2, a: 1 }));
    expect(canonicalString({ x: { c: 3, b: 2 } })).toBe(canonicalString({ x: { b: 2, c: 3 } }));
  });
});

describe('key encoding', () => {
  it('roundtrips bytes ↔ base64url', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = keyToString(bytes);
    expect(typeof s).toBe('string');
    // base64url has no =, +, /
    expect(s).not.toMatch(/[+/=]/);
    expect([...keyFromString(s)]).toEqual([...bytes]);
  });

  it('generateKey returns a 32-byte key as base64url string', async () => {
    const k = await generateKey();
    expect(typeof k).toBe('string');
    expect(k).not.toMatch(/[+/=]/);
    const bytes = keyFromString(k);
    expect(bytes.length).toBe(32);
  });

  it('successive generateKey calls produce different keys', async () => {
    const a = await generateKey();
    const b = await generateKey();
    expect(a).not.toBe(b);
  });
});

describe('signEvent / verifyEvent — happy path', () => {
  it('round-trips a typical bus event', async () => {
    const key = keyFromString(await generateKey());
    const ev = { type: 'mention', from: 'chrome-1', target: 'e', body: 'hello' };
    const signed = await signEvent(ev, key);
    expect(signed._sig).toBeTruthy();
    expect(signed._sig_v).toBe(1);
    expect(await verifyEvent(signed, key)).toBe('valid');
  });

  it('keeps the original payload fields verbatim', async () => {
    const key = keyFromString(await generateKey());
    const ev = { type: 'room-utterance', body: 'hi', ts: 12345, user: 'An', from: 'X' };
    const signed = await signEvent(ev, key);
    for (const k of Object.keys(ev)) expect(signed[k]).toEqual(ev[k]);
  });

  it('strips and replaces an existing _sig before signing', async () => {
    const key = keyFromString(await generateKey());
    const ev = { type: 't', body: 'x' };
    const signedOnce = await signEvent(ev, key);
    const signedTwice = await signEvent(signedOnce, key);
    // The double-signed event should still verify (because we stripped
    // the prior _sig before re-signing — otherwise the inner _sig would
    // change the canonical input).
    expect(await verifyEvent(signedTwice, key)).toBe('valid');
  });

  it('order of keys in the signed event does not affect verification', async () => {
    const key = keyFromString(await generateKey());
    const signed = await signEvent({ a: 1, b: 2 }, key);
    // Reconstruct with shuffled key order
    const shuffled = { _sig_v: signed._sig_v, b: signed.b, _sig: signed._sig, a: signed.a };
    expect(await verifyEvent(shuffled, key)).toBe('valid');
  });
});

describe('verifyEvent — failure modes', () => {
  it('returns "missing" when no _sig is present', async () => {
    const key = keyFromString(await generateKey());
    expect(await verifyEvent({ type: 't', body: 'x' }, key)).toBe('missing');
  });

  it('returns "missing" for non-objects', async () => {
    const key = keyFromString(await generateKey());
    expect(await verifyEvent(null, key)).toBe('missing');
    expect(await verifyEvent('string', key)).toBe('missing');
    expect(await verifyEvent(undefined, key)).toBe('missing');
  });

  it('returns "invalid" when the body was tampered with after signing', async () => {
    const key = keyFromString(await generateKey());
    const signed = await signEvent({ type: 't', body: 'original' }, key);
    const tampered = { ...signed, body: 'forged' };
    expect(await verifyEvent(tampered, key)).toBe('invalid');
  });

  it('returns "invalid" when a key is added after signing', async () => {
    const key = keyFromString(await generateKey());
    const signed = await signEvent({ type: 't' }, key);
    expect(await verifyEvent({ ...signed, extra: 'sneaky' }, key)).toBe('invalid');
  });

  it('returns "invalid" when a key is removed after signing', async () => {
    const key = keyFromString(await generateKey());
    const signed = await signEvent({ type: 't', body: 'x', extra: 'y' }, key);
    const { extra: _drop, ...stripped } = signed;
    expect(await verifyEvent(stripped, key)).toBe('invalid');
  });

  it('returns "invalid" when verified with a different key', async () => {
    const k1 = keyFromString(await generateKey());
    const k2 = keyFromString(await generateKey());
    const signed = await signEvent({ type: 't', body: 'x' }, k1);
    expect(await verifyEvent(signed, k2)).toBe('invalid');
  });

  it('returns "invalid" on a malformed _sig string', async () => {
    const key = keyFromString(await generateKey());
    const signed = await signEvent({ type: 't' }, key);
    expect(await verifyEvent({ ...signed, _sig: 'this is not base64' }, key)).toBe('invalid');
  });

  it('returns "invalid" on a truncated _sig', async () => {
    const key = keyFromString(await generateKey());
    const signed = await signEvent({ type: 't', body: 'x' }, key);
    expect(await verifyEvent({ ...signed, _sig: signed._sig.slice(0, 10) }, key)).toBe('invalid');
  });

  it('rejects forged events someone tries to insert', async () => {
    const key = keyFromString(await generateKey());
    // Attacker doesn't have the key, tries to insert a fake @e dispatch.
    // They can guess the shape but can't compute a valid _sig.
    const forged = {
      type: 'mention', from: 'shell-attacker', target: 'e',
      body: 'rm -rf /', _sig: 'AAAA', _sig_v: 1,
    };
    expect(await verifyEvent(forged, key)).toBe('invalid');
  });
});

describe('cross-cutting integration shape', () => {
  it('signed event JSON-roundtrips and still verifies', async () => {
    // Bus events go through window.bus.post → JSON.stringify in
    // bus.html → CDP → JSON.parse on the receiver. Any field
    // reordering/serialization quirk in that pipeline must not
    // break verification.
    const key = keyFromString(await generateKey());
    const ev = { type: 'room-utterance', from: 'X', ts: 1, body: 'hi', wa: { chatId: 'abc', fromMe: true } };
    const signed = await signEvent(ev, key);
    const wireRoundTrip = JSON.parse(JSON.stringify(signed));
    expect(await verifyEvent(wireRoundTrip, key)).toBe('valid');
  });

  it('unicode bodies (emoji etc) survive the canonical roundtrip', async () => {
    const key = keyFromString(await generateKey());
    const ev = { type: 'msg', body: 'hola 🚀 ✨ — all good?' };
    const signed = await signEvent(ev, key);
    expect(await verifyEvent(JSON.parse(JSON.stringify(signed)), key)).toBe('valid');
  });
});
