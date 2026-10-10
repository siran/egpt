// tests/chrome-pool.test.mjs — the PURE launch-admission decision + the two config readers for the
// per-profile Chrome pool (plans/2610091931 chunk 2). No Chrome, no OS, no fs, no clock: every
// measurement is a plain number fed in, so the same inputs always give the same answer — the
// operator's "deterministic estimate as if to launch a new one".
import { describe, it, expect } from 'vitest';
import { join, basename } from 'node:path';
import { estimateChromeBytes, admitLaunch, parseDedicatedFlag, chromeConversationOf, MB } from '../src/spine/chrome-pool.mjs';

describe('admitLaunch() — the pure memory-admission table', () => {
  // A fixed frame: a 500 MB estimate, a 1024 MB margin. available is what varies.
  const estimateBytes = 500 * MB;
  const marginBytes = 1024 * MB;
  const at = (availableMb, extra = {}) => admitLaunch({ availableBytes: availableMb * MB, estimateBytes, marginBytes, ...extra });

  it('LAUNCHES when available - estimate is well above the margin', () => {
    const d = at(4096);   // 4096 - 500 = 3596 free >= 1024
    expect(d).toMatchObject({ ok: true, action: 'launch' });
  });

  it('LAUNCHES at the EXACT boundary (available - estimate === margin admits — the test is >=)', () => {
    const d = at(1524);   // 1524 - 500 = 1024 === margin
    expect(d).toMatchObject({ ok: true, action: 'launch' });
  });

  it('does NOT launch one byte below the boundary', () => {
    const d = admitLaunch({ availableBytes: 1524 * MB - 1, estimateBytes, marginBytes, canEvict: false });
    expect(d.ok).toBe(false);
    expect(d.action).toBe('decline');
  });

  it('below the margin WITH something idle to evict → action evict (caller frees room and retries)', () => {
    const d = at(1000, { canEvict: true });   // 1000 - 500 = 500 < 1024
    expect(d).toMatchObject({ ok: false, action: 'evict' });
  });

  it('below the margin with NOTHING to evict → action decline', () => {
    const d = at(1000, { canEvict: false });
    expect(d).toMatchObject({ ok: false, action: 'decline' });
  });

  it('every decision carries a human reason', () => {
    expect(at(4096).reason).toMatch(/fits/i);
    expect(at(1000, { canEvict: true }).reason).toMatch(/evict/i);
    expect(at(1000, { canEvict: false }).reason).toMatch(/margin/i);
  });
});

describe('estimateChromeBytes() — deterministic per-Chrome cost', () => {
  const floorBytes = 500 * MB;

  it('is the MAX of the measured running RSS when any Chrome is running', () => {
    expect(estimateChromeBytes({ runningRssBytes: [300 * MB, 700 * MB, 450 * MB], floorBytes }))
      .toBe(700 * MB);
  });

  it('falls back to the configured floor when NO Chrome is running (nothing to measure)', () => {
    expect(estimateChromeBytes({ runningRssBytes: [], floorBytes })).toBe(floorBytes);
  });

  it('drops non-positive / non-finite samples (an unreadable RSS is unknown, not 0 bytes)', () => {
    expect(estimateChromeBytes({ runningRssBytes: [null, NaN, 0, -5, 620 * MB], floorBytes }))
      .toBe(620 * MB);
    // all samples unusable → floor
    expect(estimateChromeBytes({ runningRssBytes: [null, 0, NaN], floorBytes })).toBe(floorBytes);
  });

  it('is deterministic: the same samples always give the same number', () => {
    const samples = [310 * MB, 512 * MB];
    const a = estimateChromeBytes({ runningRssBytes: samples, floorBytes });
    const b = estimateChromeBytes({ runningRssBytes: samples, floorBytes });
    expect(a).toBe(b);
    expect(a).toBe(512 * MB);
  });
});

describe('parseDedicatedFlag() — the per-conversation opt-in (mirrors parseWarmBlock)', () => {
  it('true ONLY for chrome.dedicated === true', () => {
    expect(parseDedicatedFlag({ chrome: { dedicated: true } })).toBe(true);
  });
  it('false for absent / false / non-boolean / garbage docs (shared is the default)', () => {
    expect(parseDedicatedFlag({})).toBe(false);
    expect(parseDedicatedFlag({ chrome: {} })).toBe(false);
    expect(parseDedicatedFlag({ chrome: { dedicated: false } })).toBe(false);
    expect(parseDedicatedFlag({ chrome: { dedicated: 'true' } })).toBe(false);   // not the boolean
    expect(parseDedicatedFlag({ chrome: 'nope' })).toBe(false);
    expect(parseDedicatedFlag(null)).toBe(false);
    expect(parseDedicatedFlag(undefined)).toBe(false);
  });
});

describe('chromeConversationOf() — entry + resolved doc → launch descriptor', () => {
  it('slug = basename(conversation_path), name = pushedName, dedicated from the doc', () => {
    const entry = { conversation_path: '.egpt/conversations/whatsapp/Reinie Alvino-2607150057', pushedName: 'Reinie Alvino', slug: 'reinie-x' };
    const d = chromeConversationOf(entry, { chrome: { dedicated: true } });
    expect(d).toEqual({ slug: 'Reinie Alvino-2607150057', name: 'Reinie Alvino', dedicated: true });
  });

  it('falls back to entry.slug when there is no conversation_path', () => {
    const d = chromeConversationOf({ slug: 'diego-2605201243', pushedName: 'Diego' }, {});
    expect(d).toEqual({ slug: 'diego-2605201243', name: 'Diego', dedicated: false });
  });

  it('handles a backslash conversation_path (basename still yields the dir name)', () => {
    const entry = { conversation_path: 'C:\\Users\\an\\.egpt\\conversations\\whatsapp\\Grp-2601010000', pushedName: 'Grp' };
    expect(chromeConversationOf(entry, {}).slug).toBe('Grp-2601010000');
  });

  it('empty entry → empty slug/name, shared (no throw)', () => {
    expect(chromeConversationOf()).toEqual({ slug: '', name: '', dedicated: false });
  });
});
