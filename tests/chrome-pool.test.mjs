// tests/chrome-pool.test.mjs — the PURE launch-admission decision + the browser-group lookup for the
// per-profile Chrome pool (plans/2610091931 chunk 2, rev 2026-10-11). No Chrome, no OS, no fs, no clock: every
// measurement is a plain number fed in, so the same inputs always give the same answer — the
// operator's "deterministic estimate as if to launch a new one".
import { describe, it, expect } from 'vitest';
import { join, basename } from 'node:path';
import { estimateChromeBytes, admitLaunch, chromeConversationOf, MB } from '../src/spine/chrome-pool.mjs';
import { parse } from '../src/conversations-state.mjs';

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

// config/browsers.yaml's `groups:` map, as rooms-file.readBrowserGroups returns it.
const GROUPS = { brain: ['eGPT Admin', 'eGPT Rodz Lulu An'] };

// A registry entry exactly as the live conversations.yaml stores it: conversation_path only. The chat
// name lives in the slug (and, on some entries only, in the jid key's comment).
const at = (slug) => ({ conversation_path: `.egpt/conversations/whatsapp/${slug}` });

describe('chromeConversationOf() — entry + browsers.yaml groups → { key, name, group }', () => {
  it('a chat listed under brain → brain (both operator-named chats)', () => {
    expect(chromeConversationOf(at('eGPT Admin-2609121344'), GROUPS)).toEqual({ key: 'eGPT Admin-2609121344', name: 'eGPT Admin', group: 'brain' });
    expect(chromeConversationOf(at('eGPT Rodz Lulu An-2609201419'), GROUPS).group).toBe('brain');
  });

  it('an unlisted chat → shared', () => {
    expect(chromeConversationOf(at('Reinie Alvino-2607150057'), GROUPS)).toEqual({ key: 'Reinie Alvino-2607150057', name: 'Reinie Alvino', group: 'shared' });
  });

  it('no browsers.yaml (empty map) → every chat is shared, eGPT Admin included', () => {
    expect(chromeConversationOf(at('eGPT Admin-2609121344'), {}).group).toBe('shared');
  });

  it('a chat in TWO groups → no group (no browser), with the reason; never a silent pick', () => {
    const d = chromeConversationOf(at('eGPT Admin-2609121344'), { brain: ['eGPT Admin'], work: ['eGPT Admin'] });
    expect(d.group).toBe(null);
    expect(d.why).toMatch(/brain, work/);
  });

  it('a group name that is not a safe single path segment → no group', () => {
    for (const bad of ['../brain', 'a/b', 'a\\b', '..', 'CON', ' brain', 'x:y']) {
      const d = chromeConversationOf(at('Diego-2605201243'), { [bad]: ['Diego'] });
      expect(d.group, bad).toBe(null);
      expect(d.why, bad).toMatch(/not a safe/);
    }
  });

  it('a nameless chat matches no listed member (an empty "" entry included) → shared', () => {
    expect(chromeConversationOf({}, { brain: [''] }).group).toBe('shared');
  });

  it('key falls back to entry.slug; a backslash conversation_path still yields the dir name', () => {
    expect(chromeConversationOf({ slug: 'diego-2605201243' }, {}).key).toBe('diego-2605201243');
    const entry = { conversation_path: 'C:\\Users\\an\\.egpt\\conversations\\whatsapp\\Grp-2601010000' };
    expect(chromeConversationOf(entry, {}).key).toBe('Grp-2601010000');
  });

  it('empty entry → shared (no throw)', () => {
    expect(chromeConversationOf()).toEqual({ key: '', name: '', group: 'shared' });
  });
});

// The LIVE registry: reve's conversations.yaml carries no pushedName key. parse() re-hydrates one
// from the jid key's `# <name>` comment, but 224 of 318 live whatsapp entries have no comment — the
// slug (`<sanitizeSlug(name)>-<yymmddhhmm>`, conversations-state ensureContact) is the one carrier
// every entry has.
describe('chromeConversationOf() — the live registry shape', () => {
  const LIVE = [
    'contacts:',
    '  whatsapp:',
    '    89xiqJ8w1iDuKtD4a5BY: # eGPT Rodz Lulu An',
    '      conversation_path: .egpt/conversations/whatsapp/eGPT Rodz Lulu An-2609201419',
    '    trYqoMoH7jETBozvcOQh: # eGPT Admin',
    '      conversation_path: .egpt/conversations/whatsapp/eGPT Admin-2609121344',
    '    YKI87ChI5P2N437k7VBc: # eGPT Rodz Lulu An-egpt split',
    '      conversation_path: .egpt/conversations/whatsapp/eGPT Rodz Lulu An-egpt split-2610050252',
    '    noCommentAdminJid000:',
    '      conversation_path: .egpt/conversations/whatsapp/eGPT Admin-2609121345',
    '',
  ].join('\n');
  const wa = parse(LIVE).contacts.whatsapp;
  const groupOf = (jid) => chromeConversationOf(wa[jid], GROUPS).group;

  it('the commented live entries resolve to brain through the real registry reader', () => {
    expect(groupOf('89xiqJ8w1iDuKtD4a5BY')).toBe('brain');
    expect(groupOf('trYqoMoH7jETBozvcOQh')).toBe('brain');
  });

  it('a live entry with NO name comment still resolves by its slug', () => {
    expect(wa.noCommentAdminJid000.pushedName).toBe('');
    expect(groupOf('noCommentAdminJid000')).toBe('brain');
  });

  it('a raw entry with no pushedName field (conversation_path only) resolves by its slug', () => {
    expect(chromeConversationOf(at('eGPT Rodz Lulu An-2609201419'), GROUPS).group).toBe('brain');
  });

  it('the split chat does NOT match "eGPT Rodz Lulu An"', () => {
    expect(groupOf('YKI87ChI5P2N437k7VBc')).toBe('shared');
  });

  it("dolly's slug for the same chat (another creation stamp) → the same group", () => {
    expect(chromeConversationOf(at('eGPT Rodz Lulu An-2609201420'), GROUPS).group).toBe('brain');
  });

  it('a listed name with characters sanitizeSlug changes still matches its slug', () => {
    expect(chromeConversationOf(at('Mamá Papá chat-2601010000'), { family: ['Mamá/Papá: chat'] }).group).toBe('family');
  });

  it('the slug is the one carrier: a pushedName that disagrees with it is not consulted', () => {
    expect(chromeConversationOf({ ...at('Reinie Alvino-2607150057'), pushedName: 'eGPT Admin' }, GROUPS).group).toBe('shared');
  });
});

// A /split is its own conversation (own conversation_path) whose parent_chat names the chat it forked.
describe('chromeConversationOf() — an unlisted split inherits its parent\'s group (operator 2026-10-21)', () => {
  const PARENT = at('eGPT Rodz Lulu An-2609201419');
  const SPLIT = { ...at('SI+eGPT Rodz Lulu An-lulu-amazon-2610220339'), parent_chat: '89xiqJ8w1iDuKtD4a5BY' };
  const DEEPER = { ...at('SI+lulu-amazon-cart-2610220400'), parent_chat: 'split' };
  const parentOf = (e) => ({ '89xiqJ8w1iDuKtD4a5BY': PARENT, split: SPLIT })[e.parent_chat] ?? null;

  it('unlisted split → the parent\'s group, under its own key and name; a split of a split too', () => {
    expect(chromeConversationOf(SPLIT, GROUPS, parentOf)).toEqual({ key: 'SI+eGPT Rodz Lulu An-lulu-amazon-2610220339', name: 'SI+eGPT Rodz Lulu An-lulu-amazon', group: 'brain' });
    expect(chromeConversationOf(DEEPER, GROUPS, parentOf).group).toBe('brain');
  });

  it('the split listed explicitly → its own group; listed twice → the refusal, parent not consulted', () => {
    expect(chromeConversationOf(SPLIT, { ...GROUPS, amazon: ['SI+eGPT Rodz Lulu An-lulu-amazon'] }, parentOf).group).toBe('amazon');
    const d = chromeConversationOf(SPLIT, { ...GROUPS, a: ['SI+eGPT Rodz Lulu An-lulu-amazon'], b: ['SI+eGPT Rodz Lulu An-lulu-amazon'] }, parentOf);
    expect(d.group).toBe(null);
    expect(d.why).toMatch(/a, b/);
  });

  it('parent unlisted → shared; no parent (dropped by /end) → shared', () => {
    expect(chromeConversationOf(SPLIT, GROUPS, () => at('Reinie Alvino-2607150057')).group).toBe('shared');
    expect(chromeConversationOf(SPLIT, GROUPS, () => null).group).toBe('shared');
    expect(chromeConversationOf(SPLIT, GROUPS).group).toBe('shared');
  });

  it('a parent cycle is bounded → shared', () => {
    expect(chromeConversationOf(SPLIT, GROUPS, () => SPLIT).group).toBe('shared');
  });
});
