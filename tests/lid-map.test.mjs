// The learned LID↔PN resolver: learns only authoritative pairings, normalizes
// either direction, and powers cross-form authorization.
import { describe, it, expect } from 'vitest';
import { createLidMap } from '../src/lid-map.mjs';

describe('createLidMap.learn / learnPair', () => {
  it('learns a lid↔pn pairing and resolves both directions', () => {
    const m = createLidMap();
    expect(m.learn('34836563681438:45@lid', '16468217865:45@s.whatsapp.net')).toBe(true);
    expect(m.pnForLid('34836563681438@lid')).toBe('16468217865');
    expect(m.lidForPn('16468217865@s.whatsapp.net')).toBe('34836563681438');
    expect(m.size).toBe(1);
  });
  it('is device- and suffix-independent (canonicalizes both sides)', () => {
    const m = createLidMap();
    m.learn('34836563681438:45@lid', '16468217865@s.whatsapp.net');
    expect(m.pnForLid('34836563681438_2')).toBe('16468217865');   // group sender-key form
    expect(m.pnForLid('34836563681438:99@lid')).toBe('16468217865'); // any device
  });
  it('learnPair detects which side is the @lid regardless of order', () => {
    const m1 = createLidMap();
    expect(m1.learnPair('111@lid', '222@s.whatsapp.net')).toBe(true);
    expect(m1.pnForLid('111@lid')).toBe('222');
    const m2 = createLidMap();
    expect(m2.learnPair('222@s.whatsapp.net', '111@lid')).toBe(true);  // reversed
    expect(m2.pnForLid('111@lid')).toBe('222');
  });
  it('learnPair rejects same-kind pairs (no lid to anchor)', () => {
    const m = createLidMap();
    expect(m.learnPair('111@s.whatsapp.net', '222@s.whatsapp.net')).toBe(false);
    expect(m.learnPair('111@lid', '222@lid')).toBe(false);
  });
  it('rejects garbage and the degenerate lid===pn case', () => {
    const m = createLidMap();
    expect(m.learn(null, '1@s.whatsapp.net')).toBe(false);
    expect(m.learn('1@lid', '1@s.whatsapp.net')).toBe(false);   // same digits → not a real pairing
    expect(m.size).toBe(0);
  });
  it('idempotent: re-learning the same pairing does not re-dirty', () => {
    const m = createLidMap();
    expect(m.learn('111@lid', '222@s.whatsapp.net')).toBe(true);
    m.clearDirty();
    expect(m.learn('111@lid', '222@s.whatsapp.net')).toBe(false);
    expect(m.dirty).toBe(false);
  });
});

describe('counterpart (authorization helper)', () => {
  it('returns the pn for a lid and the lid for a pn', () => {
    const m = createLidMap();
    m.learn('34836563681438@lid', '16468217865@s.whatsapp.net');
    expect(m.counterpart('34836563681438@lid')).toBe('16468217865');
    expect(m.counterpart('16468217865@s.whatsapp.net')).toBe('34836563681438');
  });
  it('returns null for an unknown id', () => {
    expect(createLidMap().counterpart('999@lid')).toBe(null);
  });
});

describe('pnJidForLid (self-DM delivery normalization)', () => {
  it('builds a sendable phone jid for a known lid', () => {
    const m = createLidMap();
    m.learn('34836563681438@lid', '16468217865@s.whatsapp.net');
    expect(m.pnJidForLid('34836563681438@lid')).toBe('16468217865@s.whatsapp.net');
    expect(m.pnJidForLid('999@lid')).toBe(null);
  });
});

describe('toJSON round-trips for persistence', () => {
  it('rebuilds an equivalent map from its own JSON', () => {
    const a = createLidMap();
    a.learn('111@lid', '222@s.whatsapp.net');
    const b = createLidMap(a.toJSON());
    expect(b.pnForLid('111@lid')).toBe('222');
    expect(b.lidForPn('222@s.whatsapp.net')).toBe('111');
  });
});
