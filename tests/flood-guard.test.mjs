import { describe, it, expect } from 'vitest';
import { createFloodGuard, guardedSend } from '../src/flood-guard.mjs';

describe('flood-guard — bridge send fail-safe', () => {
  it('allows normal traffic, trips past the limit, pauses the chat', () => {
    let t = 0; const now = () => t;
    let tripped = 0;
    const g = createFloodGuard({ limit: 10, windowMs: 3000, cooldownMs: 60000, now, onTrip: () => tripped++ });
    for (let i = 0; i < 10; i++) { t += 100; expect(g.allow('A')).toBe(true); }   // 10 in window = fine
    t += 100; expect(g.allow('A')).toBe(false);                                    // 11th trips
    expect(tripped).toBe(1);
    expect(g.isPaused('A')).toBe(true);
    t += 100; expect(g.allow('A')).toBe(false);                                    // stays blocked
    expect(g.allow('B')).toBe(true);                                              // other chats unaffected
  });

  it('resumes after the cooldown window', () => {
    let t = 0; const now = () => t;
    const g = createFloodGuard({ limit: 3, windowMs: 1000, cooldownMs: 5000, now });
    for (let i = 0; i < 4; i++) g.allow('A');     // trips on the 4th
    expect(g.isPaused('A')).toBe(true);
    t += 5001;
    expect(g.allow('A')).toBe(true);
    expect(g.isPaused('A')).toBe(false);
  });

  it('spaced-out sends never trip (the window slides)', () => {
    let t = 0; const now = () => t;
    const g = createFloodGuard({ limit: 5, windowMs: 1000, now });
    for (let i = 0; i < 50; i++) { t += 300; expect(g.allow('A')).toBe(true); }   // ~3.3/s < 5/s
  });

  // ── the WIRING (what was missing 2026-06-19) ──
  it('guardedSend passes normal sends through to the real send', async () => {
    const sent = [];
    const gs = guardedSend({ send: async (txt, o) => { sent.push([txt, o.chatId]); return 'ok'; }, floodGuard: createFloodGuard() });
    expect(await gs('hi', { chatId: 'A' })).toBe('ok');
    expect(sent).toEqual([['hi', 'A']]);
  });

  it('guardedSend CUTS OFF a flood (the guard is genuinely in the send path)', async () => {
    let t = 0; const now = () => t;
    const g = createFloodGuard({ limit: 5, windowMs: 3000, now });
    const sent = [];
    const gs = guardedSend({ send: async (txt) => { sent.push(txt); }, floodGuard: g, log: () => {} });
    for (let i = 0; i < 20; i++) { t += 50; await gs(`m${i}`, { chatId: 'A' }); }
    expect(sent.length).toBeLessThanOrEqual(5);   // 20 attempts, flood cut off
  });

  // ── META: an unguarded send path MUST NOT be constructible ──
  it('META: guardedSend refuses to exist without a flood guard', () => {
    expect(() => guardedSend({ send: async () => {} })).toThrow(/floodGuard is required/);
    expect(() => guardedSend({ send: async () => {}, floodGuard: {} })).toThrow(/floodGuard is required/);
    expect(() => guardedSend({ floodGuard: createFloodGuard() })).toThrow(/send function is required/);
  });
});
