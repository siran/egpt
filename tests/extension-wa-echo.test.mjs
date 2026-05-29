// tests/extension-wa-echo.test.mjs — echo suppression rules for the CHROME
// EXTENSION's WA-CDP (extension/src/bridges/wa-echo.js). Not related to
// the shell's baileys-side echo handling.
//
// When the extension sends to WhatsApp via chrome.debugger Input.*, the
// resulting page DOM mutation comes back through our own MutationObserver
// as fromMe=true — looking exactly like user-typed input. Without a guard
// we'd loop. Pin the rules.

import { describe, it, expect } from 'vitest';
import { createEchoTracker } from '../extension/src/bridges/wa-echo.js';

describe('wa-echo — basic record/consume', () => {
  it('a recorded send is consumed on first match within TTL', () => {
    const t = createEchoTracker();
    t.record('hello');
    expect(t.consume('hello')).toBe(true);
  });

  it('subsequent same-text consume returns false (record was consumed)', () => {
    const t = createEchoTracker();
    t.record('hello');
    expect(t.consume('hello')).toBe(true);
    expect(t.consume('hello')).toBe(false);
  });

  it('unrecorded text is never suppressed', () => {
    const t = createEchoTracker();
    t.record('hello');
    expect(t.consume('goodbye')).toBe(false);
  });

  it('empty tracker returns false for any consume', () => {
    const t = createEchoTracker();
    expect(t.consume('hi')).toBe(false);
  });
});

describe('wa-echo — TTL expiry', () => {
  it('a record older than TTL is gc\'d and no longer suppresses', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ ttlMs: 15_000, now: () => now });
    t.record('hello');
    now += 16_000;       // past TTL
    expect(t.consume('hello')).toBe(false);
  });

  it('a record within TTL still suppresses', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ ttlMs: 15_000, now: () => now });
    t.record('hello');
    now += 14_000;       // still inside window
    expect(t.consume('hello')).toBe(true);
  });

  it('TTL boundary is strict: equal-or-greater age = expired', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ ttlMs: 15_000, now: () => now });
    t.record('hello');
    now += 15_000;       // exactly at TTL
    expect(t.consume('hello')).toBe(false);
  });
});

describe('wa-echo — multiple records, FIFO consumption', () => {
  it('two records of same text — two consumes match', () => {
    const t = createEchoTracker();
    t.record('hi');
    t.record('hi');
    expect(t.consume('hi')).toBe(true);
    expect(t.consume('hi')).toBe(true);
    expect(t.consume('hi')).toBe(false);
  });

  it('consume returns the OLDEST matching record (FIFO)', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ now: () => now });
    t.record('hi');
    now += 100;
    t.record('hi');
    expect(t.size()).toBe(2);
    t.consume('hi');
    expect(t.size()).toBe(1);
  });

  it('different texts in different records don\'t cross-suppress', () => {
    const t = createEchoTracker();
    t.record('alpha');
    t.record('beta');
    expect(t.consume('beta')).toBe(true);
    expect(t.consume('alpha')).toBe(true);
    expect(t.consume('alpha')).toBe(false);
  });
});

describe('wa-echo — gc behavior', () => {
  it('size() reflects gc — old records drop off the count', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ ttlMs: 15_000, now: () => now });
    t.record('a');
    t.record('b');
    expect(t.size()).toBe(2);
    now += 20_000;
    expect(t.size()).toBe(0);
  });

  it('mixed-age records: new survives, old gc\'d', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ ttlMs: 15_000, now: () => now });
    t.record('old');
    now += 14_000;
    t.record('new');
    now += 2_000;          // 'old' is now 16s, 'new' is 2s
    expect(t.consume('old')).toBe(false);    // expired
    expect(t.consume('new')).toBe(true);     // still in window
  });
});

describe('wa-echo — real-world scenario', () => {
  it('user types in extension → debugger-send → echo bounces back → suppressed', () => {
    let now = 1_000_000;
    const t = createEchoTracker({ now: () => now });

    // Extension dispatches via debugger:
    t.record('hola');

    // ~50ms later WA Web's MutationObserver picks up the new fromMe row:
    now += 50;
    expect(t.consume('hola')).toBe(true);   // suppressed
  });

  it('user types same text twice on phone → not falsely suppressed', () => {
    const t = createEchoTracker();
    // No record from extension — the user is typing on phone.
    expect(t.consume('hola')).toBe(false);  // first phone send: not echo
    expect(t.consume('hola')).toBe(false);  // second phone send: still not
  });
});
