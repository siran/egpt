// tests/conversations-state.test.mjs — pure-logic tests for the
// per-contact YAML registry. No fs IO touched: parse/serialize +
// upsert + migration all run in-memory.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyState,
  sanitizeSlug,
  findContactByJid,
  findContactsByName,
  ensureContact,
  conversationPathOf,
  recentContacts,
  slugDir,
  isPlaceholderSlug,
  patchContact,
  recordThread,
  isMuted,
  migrateJsonToYaml,
  migrateConversationVocabulary,
  getBeing,
  readState,
  writeState,
  parse,
  serialize,
  nowIsoString,
  isoFromMs,
  KNOWN_SURFACES,
  DEFAULT_PERSONALITY_TOOLS,
  readPersonality,
  readPersonalityMeta,
  residentsOf,
} from '../conversations-state.mjs';

const WA = 'whatsapp';
const TG = 'telegram';

describe('emptyState / sanitizeSlug basics', () => {
  it('emptyState() has no contacts', () => {
    expect(emptyState()).toEqual({ contacts: {} });
  });
  it('sanitizeSlug keeps path-friendly chars, substitutes only Windows-illegal ones', () => {
    // accents + spaces + parens + @ + & + ! are all legal on Windows → kept
    expect(sanitizeSlug('Tío Jesús Palma')).toBe('Tío Jesús Palma');
    expect(sanitizeSlug('+1 (646) 821-7865')).toBe('+1 (646) 821-7865');
    expect(sanitizeSlug('26087681749235@lid')).toBe('26087681749235@lid');
    expect(sanitizeSlug('  hello world!  ')).toBe('hello world!');   // trimmed, '!' kept
    // Windows-illegal chars (: / \ < > " | ? *) collapse to a single space
    expect(sanitizeSlug('premise-driven: bitcoin & evolution')).toBe('premise-driven bitcoin & evolution');
    expect(sanitizeSlug('a/b\\c:d')).toBe('a b c d');
    expect(sanitizeSlug('')).toBe('');
  });
  it('sanitizeSlug enforces the Windows trailing-dot/space + reserved-name rules', () => {
    expect(sanitizeSlug('weird name.')).toBe('weird name');   // no trailing dot
    expect(sanitizeSlug('CON')).toBe('CON_');                  // reserved device name
    expect(sanitizeSlug('nul')).toBe('nul_');
    expect(sanitizeSlug('...')).toBe('');                      // dots-only → empty
  });
  it('sanitizeSlug is idempotent on an already-clean slug', () => {
    for (const s of ['morgan-2606101622', 'Tío Jesús Palma', '+1 (646) 821-7865', 'a b c d']) {
      expect(sanitizeSlug(s)).toBe(s);
    }
  });
  it('KNOWN_SURFACES is the canonical bucket list', () => {
    expect(KNOWN_SURFACES).toContain('whatsapp');
    expect(KNOWN_SURFACES).toContain('telegram');
    expect(KNOWN_SURFACES).toContain('shell');
  });
});

describe('ensureContact — surface-aware, new contact, multi-JID merge', () => {
  it('creates a fresh contact under the named surface', () => {
    const s0 = emptyState();
    const jid = '26087681749235@lid';
    const { state, jid: primary, slug, entry, isNew, surface } = ensureContact(s0, WA, jid, {
      pushedName: 'Diego Pérez (Koma)',
      slugHint: 'diego',
    });
    expect(isNew).toBe(true);
    expect(surface).toBe(WA);
    expect(primary).toBe(jid);
    // slug follows the TITLE (pushedName), path-safe — accents/spaces/parens kept
    expect(slug).toMatch(/^Diego Pérez \(Koma\)-\d{10}$/);
    expect(entry.slug).toBe(slug);
    // The per-conversation `personality` key is RETIRED (operator 2026-07-02) — a fresh
    // contact is NOT seeded with one; the identity feed is a property of the agent type.
    expect('personality' in entry).toBe(false);
    expect(entry.firstSeenAt).toBeTruthy();
    expect(entry.pushedName).toBe('Diego Pérez (Koma)');
    expect(entry.jids).toBeUndefined();
    expect(state.contacts[WA][jid]).toEqual(entry);
  });

  it('a second JID with matching slugHint becomes an alias within the same surface', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)', slugHint: 'diego' });
    s = r1.state;
    // same person's 2nd JID carries the same title → same candidate slug → alias
    const r2 = ensureContact(s, WA, '584122182178@s.whatsapp.net', { pushedName: 'Diego Pérez (Koma)', slugHint: 'diego' });
    expect(r2.slug).toBe(r1.slug);
    expect(r2.jid).toBe(r1.jid);
    expect(r2.isNew).toBe(false);
    expect(r2.state.contacts[WA]['584122182178@s.whatsapp.net']).toEqual({ aliasOf: r1.jid });
  });

  it('same JID under different surfaces is independent', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '88164392', { slugHint: 'an-wa' });
    s = r1.state;
    const r2 = ensureContact(s, TG, '88164392', { slugHint: 'an-tg' });
    expect(r1.slug).not.toBe(r2.slug);
    expect(r2.state.contacts[WA]['88164392'].slug).toMatch(/^an-wa-\d{10}$/);
    expect(r2.state.contacts[TG]['88164392'].slug).toMatch(/^an-tg-\d{10}$/);
  });

  it('re-encountering a known JID with a new name re-slugs to the current name (not frozen)', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '26087681749235@lid', { pushedName: '', slugHint: 'diego' });
    s = r1.state;
    const suffix = r1.slug.match(/-(\d{10})$/)[1];
    const r2 = ensureContact(s, WA, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)' });
    expect(r2.jid).toBe(r1.jid);
    expect(r2.isNew).toBe(false);
    expect(r2.changed).toBe(true);
    expect(r2.entry.pushedName).toBe('Diego Pérez (Koma)');
    // slug tracks the current name (keeps the firstSeen suffix), thread reset
    expect(r2.renamedFrom).toBe(r1.slug);
    expect(r2.slug).toBe(`Diego Pérez (Koma)-${suffix}`);
    expect(r2.state.contacts[WA]['26087681749235@lid'].threadId).toBe(null);
  });

  it('falls back to a contact-<timestamp> slug when no slugHint or pushedName', () => {
    const s = emptyState();
    const jid = '584122182178@s.whatsapp.net';
    const r = ensureContact(s, WA, jid, {});
    expect(r.slug).toMatch(/^contact-\d{10}$/);
    expect(r.state.contacts[WA][jid].slug).toBe(r.slug);
  });

  it('aliasOf resolves through findContactByJid', () => {
    let s = emptyState();
    const r1 = ensureContact(s, WA, '26087681749235@lid', { slugHint: 'diego' });
    s = ensureContact(r1.state, WA, '584122182178@s.whatsapp.net', { slugHint: 'diego' }).state;
    expect(findContactByJid(s, WA, '26087681749235@lid')).toBe(r1.slug);
    expect(findContactByJid(s, WA, '584122182178@s.whatsapp.net')).toBe(r1.slug);
  });

  it('ensureContact rejects an unknown surface', () => {
    expect(() => ensureContact(emptyState(), 'martian-radio', '1@lid', {}))
      .toThrow(/unknown surface/);
  });

  it('IGNORES ctx.personality on new contact creation (key retired; signature stays compatible)', () => {
    // Legacy spine callers still PASS ctx.personality — it must be silently ignored, never
    // throw, and never seed a `personality` on the new entry (operator 2026-07-02).
    const r = ensureContact(emptyState(), WA, '34836563681438@lid', {
      pushedName: 'self', slugHint: 'self', personality: 'system',
    });
    expect('personality' in r.entry).toBe(false);
  });

  it('a known title produces a named slug, not a placeholder', () => {
    const r = ensureContact(emptyState(), WA, '!room:beeper.local', { pushedName: 'morgan', slugHint: 'morgan' });
    expect(r.slug).toMatch(/^morgan-\d{10}$/);
    expect(isPlaceholderSlug(r.slug)).toBe(false);
  });
});

describe('conversation_path (stored) + threadCwd backfill', () => {
  it('conversationPathOf returns the posix path relative to ~/.egpt', () => {
    expect(conversationPathOf(WA, 'diego-2606101647')).toBe('conversations/whatsapp/diego-2606101647');
    expect(conversationPathOf(TG, 'jay-2605200416')).toBe('conversations/telegram/jay-2605200416');
  });

  it('stores conversation_path on a fresh contact', () => {
    const r = ensureContact(emptyState(), WA, '!room:beeper.local', { pushedName: 'morgan', slugHint: 'morgan' });
    expect(r.entry.conversation_path).toBe(conversationPathOf(WA, r.slug));
    expect(r.entry.conversation_path.startsWith('conversations/whatsapp/')).toBe(true);
  });

  it('backfills conversation_path + a populated threadCwd on a legacy entry that lacks them', () => {
    // legacy shape: a started thread but threadCwd:null and no conversation_path
    const s = { contacts: { [WA]: { '111@s.whatsapp.net': {
      slug: 'Mom-2605200520', personality: 'default', threadId: 'sess-mom', threadCwd: null, pushedName: 'Mom',
    } } } };
    const r = ensureContact(s, WA, '111@s.whatsapp.net', { pushedName: 'Mom' });
    expect(r.changed).toBe(true);
    expect(r.entry.conversation_path).toBe(conversationPathOf(WA, 'Mom-2605200520'));
    expect(r.entry.threadCwd).toBe(slugDir(WA, 'Mom-2605200520'));
  });

  it('is stable — a second pass with everything already set makes no change', () => {
    const r1 = ensureContact(emptyState(), WA, '!room:beeper.local', { pushedName: 'morgan' });
    const r2 = ensureContact(r1.state, WA, '!room:beeper.local', { pushedName: 'morgan' });
    expect(r2.changed).toBe(false);
  });

  it('a rename updates conversation_path to the new slug (and nulls threadCwd)', () => {
    const r1 = ensureContact(emptyState(), WA, '26087681749235@lid', { pushedName: '', slugHint: 'diego' });
    const r2 = ensureContact(r1.state, WA, '26087681749235@lid', { pushedName: 'Diego Pérez' });
    expect(r2.renamedTo).toBeTruthy();
    expect(r2.entry.conversation_path).toBe(conversationPathOf(WA, r2.slug));
    expect(r2.entry.threadCwd ?? null).toBe(null);
  });
});

describe('recentContacts — the /e browser list', () => {
  const mk = () => {
    let s = emptyState();
    s = ensureContact(s, WA, '1@s', { pushedName: 'Alice' }).state;
    s = ensureContact(s, WA, '2@s', { pushedName: 'Bob' }).state;
    s = ensureContact(s, TG, '3', { pushedName: 'Carol' }).state;
    // an alias must NOT appear as its own row
    s = ensureContact(s, WA, '1b@lid', { pushedName: 'Alice', slugHint: 'Alice' }).state;
    return s;
  };

  it('returns primaries newest-first by recencyOf, capped at limit, skipping aliases', () => {
    const s = mk();
    const rank = { 'Alice': 30, 'Bob': 10, 'Carol': 20 };
    const recencyOf = (_surface, _slug, entry) => rank[entry.pushedName] ?? 0;
    const out = recentContacts(s, { limit: 10, recencyOf });
    expect(out.map((r) => r.pushedName)).toEqual(['Alice', 'Carol', 'Bob']);   // 30, 20, 10
    expect(out.every((r) => !r.entry.aliasOf)).toBe(true);
    expect(out).toHaveLength(3);   // alias collapsed into Alice's primary
  });

  it('honors the limit', () => {
    const s = mk();
    const recencyOf = (_s, _sl, e) => ({ Alice: 30, Bob: 10, Carol: 20 })[e.pushedName] ?? 0;
    expect(recentContacts(s, { limit: 2, recencyOf }).map((r) => r.pushedName)).toEqual(['Alice', 'Carol']);
  });

  it('no recencyOf → stable (all 0), still returns primaries', () => {
    expect(recentContacts(mk(), { limit: 10 })).toHaveLength(3);
  });

  it('offset paginates (next page)', () => {
    const s = mk();
    const recencyOf = (_s, _sl, e) => ({ Alice: 30, Bob: 10, Carol: 20 })[e.pushedName] ?? 0;
    expect(recentContacts(s, { limit: 2, offset: 0, recencyOf }).map((r) => r.pushedName)).toEqual(['Alice', 'Carol']);
    expect(recentContacts(s, { limit: 2, offset: 2, recencyOf }).map((r) => r.pushedName)).toEqual(['Bob']);
    expect(recentContacts(s, { limit: 2, offset: 4, recencyOf })).toHaveLength(0);
  });
});

describe('isPlaceholderSlug — placeholder vs real names', () => {
  it('treats contact-<ts> / contact / empty as placeholders', () => {
    expect(isPlaceholderSlug('contact-2606101622')).toBe(true);
    expect(isPlaceholderSlug('contact')).toBe(true);
    expect(isPlaceholderSlug('')).toBe(true);
    expect(isPlaceholderSlug(null)).toBe(true);
  });
  it('treats real names (with or without suffix) as NOT placeholders', () => {
    expect(isPlaceholderSlug('morgan-2606101622')).toBe(false);
    expect(isPlaceholderSlug('le_moi-2605211521')).toBe(false);
    expect(isPlaceholderSlug('morgan')).toBe(false);
    // a base that merely CONTAINS 'contact' is real (only exact 'contact' is the fallback)
    expect(isPlaceholderSlug('contactos-2605211521')).toBe(false);
  });
});

describe('ensureContact — self-heals a placeholder slug when the title resolves', () => {
  // The Morgan bug (operator 2026-06-14): a chat first seen before its Beeper
  // title resolved got slug 'contact-<ts>'; later the title was known but the
  // slug stayed nameless forever because path-1 only refreshed pushedName.
  const ROOM = '!RdGUTtUiSNnirVXjHgP2:beeper.local';
  function placeholderState() {
    const r = ensureContact(emptyState(), WA, ROOM, {});   // no name → contact-<ts>
    expect(r.slug).toMatch(/^contact-\d{10}$/);
    // pretend a thread was already spawned at the placeholder cwd
    return { state: recordThread(r.state, WA, ROOM, 'thread-abc'), placeholderSlug: r.slug };
  }

  it('renames the slug to the resolved name, keeping the firstSeen suffix', () => {
    const { state, placeholderSlug } = placeholderState();
    const suffix = placeholderSlug.match(/-(\d{10})$/)[1];
    const r = ensureContact(state, WA, ROOM, { pushedName: 'morgan', slugHint: 'morgan' });
    expect(r.renamedFrom).toBe(placeholderSlug);
    expect(r.renamedTo).toBe(`morgan-${suffix}`);
    expect(r.slug).toBe(`morgan-${suffix}`);
    expect(r.changed).toBe(true);
    expect(isPlaceholderSlug(r.slug)).toBe(false);
    // the registry entry moved to the new slug + nulled the now-stale thread
    expect(r.state.contacts[WA][ROOM].slug).toBe(`morgan-${suffix}`);
    expect(r.state.contacts[WA][ROOM].threadId).toBe(null);
  });

  it('does NOT re-slug a contact that already has a real name', () => {
    let s = ensureContact(emptyState(), WA, '85555832479795@lid', { pushedName: 'le moi', slugHint: 'le moi' }).state;
    const before = s.contacts[WA]['85555832479795@lid'].slug;
    const r = ensureContact(s, WA, '85555832479795@lid', { pushedName: 'le moi', slugHint: 'le moi' });
    expect(r.renamedFrom).toBe(null);
    expect(r.renamedTo).toBe(null);
    expect(r.slug).toBe(before);
  });

  it('leaves a placeholder alone while the name is still unknown', () => {
    const { state, placeholderSlug } = placeholderState();
    const r = ensureContact(state, WA, ROOM, {});   // still no name
    expect(r.renamedFrom).toBe(null);
    expect(r.slug).toBe(placeholderSlug);
    expect(isPlaceholderSlug(r.slug)).toBe(true);
  });

  it('does not collide onto an existing slug', () => {
    // another contact already holds morgan-<suffix>; the placeholder must not steal it
    const { state, placeholderSlug } = placeholderState();
    const suffix = placeholderSlug.match(/-(\d{10})$/)[1];
    const taken = `morgan-${suffix}`;
    const withTaken = { ...state, contacts: { ...state.contacts, [WA]: { ...state.contacts[WA], '!other:beeper.local': { slug: taken, personality: 'default' } } } };
    const r = ensureContact(withTaken, WA, ROOM, { pushedName: 'morgan', slugHint: 'morgan' });
    expect(r.renamedTo).toBe(null);            // collision → no rename
    expect(r.slug).toBe(placeholderSlug);      // stays a placeholder until safe
  });

  it('tracks a RENAME of an already-named contact/group (not frozen)', () => {
    // morgan exists with a real name + a live thread; the contact/group is renamed.
    let s = ensureContact(emptyState(), WA, ROOM, { pushedName: 'morgan' }).state;
    s = recordThread(s, WA, ROOM, 'thread-xyz');
    const before = s.contacts[WA][ROOM].slug;            // morgan-<suffix>
    const suffix = before.match(/-(\d{10})$/)[1];
    const r = ensureContact(s, WA, ROOM, { pushedName: 'Mauricio' });
    expect(r.renamedFrom).toBe(before);
    expect(r.renamedTo).toBe(`Mauricio-${suffix}`);      // keeps the firstSeen suffix
    expect(r.entry.pushedName).toBe('Mauricio');
    expect(r.state.contacts[WA][ROOM].threadId).toBe(null);   // thread reset on rename
  });

  it('no rename when the name is unchanged (anti-flap / idempotent)', () => {
    let s = ensureContact(emptyState(), WA, ROOM, { pushedName: 'Dando Ruiz' }).state;
    const before = s.contacts[WA][ROOM].slug;
    // re-encounter with the same title, plus a lowercase-dash slugHint that must
    // NOT cause a flap (rename is driven off pushedName only)
    const r = ensureContact(s, WA, ROOM, { pushedName: 'Dando Ruiz', slugHint: 'dando-ruiz' });
    expect(r.renamedFrom).toBe(null);
    expect(r.slug).toBe(before);
  });
});

describe('findContactByJid (surface-scoped)', () => {
  it('returns null for unknown JID', () => {
    expect(findContactByJid(emptyState(), WA, '0@lid')).toBe(null);
  });
  it('returns the slug for a JID with a primary entry, scoped to surface', () => {
    const s = {
      contacts: {
        whatsapp: {
          '26087681749235@lid':           { slug: 'diego', personality: 'default' },
          '584122182178@s.whatsapp.net':  { aliasOf: '26087681749235@lid' },
          '1@lid':                        { slug: 'bob', personality: 'default' },
        },
        telegram: {
          '88164392': { slug: 'an-tg', personality: 'system' },
        },
      },
    };
    expect(findContactByJid(s, WA, '26087681749235@lid')).toBe('diego');
    expect(findContactByJid(s, WA, '584122182178@s.whatsapp.net')).toBe('diego');
    expect(findContactByJid(s, WA, '1@lid')).toBe('bob');
    expect(findContactByJid(s, WA, '88164392')).toBe(null);          // TG-only
    expect(findContactByJid(s, TG, '88164392')).toBe('an-tg');
    expect(findContactByJid(s, TG, '26087681749235@lid')).toBe(null); // WA-only
  });
});

describe('patchContact + recordThread (surface-scoped)', () => {
  const baseState = () => ({
    contacts: { whatsapp: {
      'j': { slug: 'diego', personality: 'default', pushedName: 'D' },
    } },
  });
  it('patchContact accepts a JID key', () => {
    const s2 = patchContact(baseState(), WA, 'j', { personality: 'serious' });
    expect(s2.contacts[WA].j.personality).toBe('serious');
    expect(s2.contacts[WA].j.pushedName).toBe('D');
    expect(s2.contacts[WA].j.slug).toBe('diego');
  });
  it('patchContact accepts a slug for back-compat', () => {
    const s2 = patchContact(baseState(), WA, 'diego', { personality: 'joke' });
    expect(s2.contacts[WA].j.personality).toBe('joke');
  });
  it('patchContact resolves through aliasOf to primary', () => {
    const s = { contacts: { whatsapp: {
      'j': { slug: 'diego', personality: 'default' },
      'k': { aliasOf: 'j' },
    } } };
    const s2 = patchContact(s, WA, 'k', { personality: 'silent' });
    expect(s2.contacts[WA].j.personality).toBe('silent');
    expect(s2.contacts[WA].k).toEqual({ aliasOf: 'j' });
  });
  it('patchContact rejects unknown surface', () => {
    expect(() => patchContact(baseState(), 'mars', 'j', {}))
      .toThrow(/unknown surface/);
  });
  it('recordThread sets threadId + ISO timestamp on the primary', () => {
    const s = { contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default' } } } };
    const s2 = recordThread(s, WA, 'j', 'thr-abc', '2026-05-19T18:34:00.000Z');
    expect(s2.contacts[WA].j.threadId).toBe('thr-abc');
    expect(s2.contacts[WA].j.threadCreatedAt).toBe('2026-05-19T18:34:00.000Z');
    expect(s2.contacts[WA].j.identityInjectedAt).toBe('2026-05-19T18:34:00.000Z');
  });

  // being-aware recordThread: 'e' stays flat (unchanged); any other being writes a
  // nested per-being block so its thread persists alongside E's.
  const nestBase = () => ({ contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default', pushedName: 'D' } } } });
  it("default 'e' still writes FLAT thread fields (no nested block)", () => {
    const s = recordThread(nestBase(), WA, 'j', 'thr-e', '2026-05-19T18:34:00.000Z');
    expect(s.contacts[WA].j.threadId).toBe('thr-e');
    expect(s.contacts[WA].j.wren).toBeUndefined();
  });
  it('a sibling writes a NESTED <being> block, leaving E flat fields intact', () => {
    let s = recordThread(nestBase(), WA, 'j', 'thr-e', '2026-05-19T18:34:00.000Z');          // E flat
    s = recordThread(s, WA, 'j', 'thr-wren', '2026-05-20T10:00:00.000Z', 'wren');             // wren nested
    expect(s.contacts[WA].j.threadId).toBe('thr-e');                                          // E untouched
    expect(s.contacts[WA].j.wren).toEqual({
      threadId: 'thr-wren', threadCreatedAt: '2026-05-20T10:00:00.000Z', identityInjectedAt: '2026-05-20T10:00:00.000Z',
    });
  });
  it('merges over an existing nested block (a stored mode survives a thread record)', () => {
    const s0 = { contacts: { whatsapp: { 'j': { slug: 'diego', wren: { mode: 'mention' } } } } };
    const s = recordThread(s0, WA, 'j', 'thr-wren', '2026-05-20T10:00:00.000Z', 'wren');
    expect(s.contacts[WA].j.wren).toEqual({
      mode: 'mention', threadId: 'thr-wren', threadCreatedAt: '2026-05-20T10:00:00.000Z', identityInjectedAt: '2026-05-20T10:00:00.000Z',
    });
  });
  it('residentsOf lists the sibling after a nested thread record', () => {
    const s = recordThread(nestBase(), WA, 'j', 'thr-wren', '2026-05-20T10:00:00.000Z', 'wren');
    expect(residentsOf(s.contacts[WA].j)).toEqual(['e', 'wren']);
  });
  it('being-aware recordThread accepts a slug key too', () => {
    const s = recordThread(nestBase(), WA, 'diego', 'thr-wren', '2026-05-20T10:00:00.000Z', 'wren');
    expect(s.contacts[WA].j.wren.threadId).toBe('thr-wren');
  });

  // Regression: root fields (system_thread, etc.) must survive contact
  // mutations. Earlier the rebuild `{ contacts: ... }` was dropping
  // system_thread on every non-system contact dispatch, wiping the
  // shared system-e memory. Caught by Codex review 2026-05-21.
  it('patchContact preserves root state fields (system_thread, etc.)', () => {
    const s = {
      system_thread: { threadId: 'sys-thr-xyz', threadCreatedAt: '2026-05-21T22:00:00.000Z' },
      contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default' } } },
    };
    const s2 = patchContact(s, WA, 'j', { personality: 'serious' });
    expect(s2.system_thread).toBeDefined();
    expect(s2.system_thread.threadId).toBe('sys-thr-xyz');
  });
  it('ensureContact preserves root state fields', () => {
    const s = {
      system_thread: { threadId: 'sys-thr-zzz' },
      _meta: { somethingElseAtRoot: true },
      contacts: { whatsapp: {} },
    };
    const r = ensureContact(s, WA, '99@lid', { slugHint: 'newguy' });
    expect(r.state.system_thread).toBeDefined();
    expect(r.state.system_thread.threadId).toBe('sys-thr-zzz');
    expect(r.state._meta).toEqual({ somethingElseAtRoot: true });
  });
});

describe('findContactsByName (cross-surface name search)', () => {
  const s = {
    contacts: {
      whatsapp: {
        '1@lid': { slug: 'diego-2605200133', pushedName: 'Diego Pérez (Koma)' },
        '2@lid': { aliasOf: '1@lid' },
        '3@lid': { slug: 'jorge-2605200419', pushedName: 'Jorge' },
      },
      telegram: {
        '88164392': { slug: 'an-self-2605211200', pushedName: 'An (TG)', personality: 'system' },
      },
    },
  };
  it('matches across all surfaces by default', () => {
    const r = findContactsByName(s, 'di');
    const slugs = r.map(x => x.slug);
    expect(slugs).toContain('diego-2605200133');
    expect(slugs.length).toBe(1);   // aliases excluded
  });
  it('returns surface in each result', () => {
    const r = findContactsByName(s, 'an');
    expect(r[0].surface).toBe(TG);
  });
  it('respects an explicit surface filter', () => {
    const r = findContactsByName(s, 'an', WA);
    expect(r).toEqual([]);                // no WA contact named 'an'
  });
  it('returns empty for empty / whitespace term', () => {
    expect(findContactsByName(s, '')).toEqual([]);
    expect(findContactsByName(s, '   ')).toEqual([]);
  });
});

describe('isMuted predicate', () => {
  it('isMuted true only when personality === mute', () => {
    expect(isMuted({ personality: 'mute' })).toBe(true);
    expect(isMuted({ personality: 'default' })).toBe(false);
    expect(isMuted({ personality: 'silent' })).toBe(false);
    expect(isMuted(null)).toBe(false);
  });
});

describe('residentsOf — resident beings vs flat blocks', () => {
  it('a flat `readonly` (instanced-brain) block is NOT a resident — only ["e"]', () => {
    // Shape the brainpool writes into the entry for the default 'e' being.
    const entry = {
      slug: 'fam', pushedName: 'fam', mode: 'on',
      readonly: { brain: 'default', type: 'claude', model: null, effort: null, allowed_tools: 'all', personality: 'default' },
    };
    expect(residentsOf(entry)).toEqual(['e']);
  });
  it('a real nested being block IS a resident (with implicit "e" first)', () => {
    const entry = { slug: 'fam', dora: { mode: 'on', readonly: { model: 'x' } } };
    expect(residentsOf(entry)).toEqual(['e', 'dora']);
  });
});

describe('YAML parse / serialize round-trip', () => {
  it('round-trips an empty state', () => {
    const s = emptyState();
    expect(parse(serialize(s))).toEqual(s);
  });
  it('round-trips a populated, multi-surface state', () => {
    const s = {
      contacts: {
        whatsapp: {
          '26087681749235@lid': {
            slug: 'diego-2605200133',
            personality: 'default',
            threadId: 'abc',
            threadCreatedAt: '2026-05-19T18:34:00.000Z',
            identityInjectedAt: '2026-05-19T18:34:00.000Z',
            pushedName: 'Diego Pérez (Koma)',
          },
          '584122182178@s.whatsapp.net': { aliasOf: '26087681749235@lid' },
        },
        telegram: {
          '88164392': {
            slug: 'an-self-2605211200',
            personality: 'system',
            threadId: null,
            pushedName: 'An',
          },
        },
      },
    };
    expect(parse(serialize(s))).toEqual(s);
  });
  it('parse() of empty / garbage returns emptyState', () => {
    expect(parse('')).toEqual(emptyState());
    expect(parse(null)).toEqual(emptyState());
    expect(parse('   ')).toEqual(emptyState());
  });
});

describe('migrateJsonToYaml — legacy slug-keyed JSON (pre-surface)', () => {
  it('groups multiple JIDs with the same customName into one contact', () => {
    const json = {
      '26087681749235@lid':         { pushedName: 'Diego Pérez (Koma)', customName: 'diego' },
      '584122182178@s.whatsapp.net':{ pushedName: '',                    customName: 'diego' },
      '120363407494846096@g.us':    { pushedName: 'premise-driven: bitcoin & evolution', customName: '' },
    };
    const r = migrateJsonToYaml(json);
    expect(r.migrated).toBe(2);
    expect(r.jids).toBe(3);
    expect(r.state.contacts.diego.jids).toEqual([
      '26087681749235@lid',
      '584122182178@s.whatsapp.net',
    ]);
    expect(r.state.contacts.diego.pushedName).toBe('Diego Pérez (Koma)');
    expect(r.state.contacts['premise-driven bitcoin & evolution']).toBeTruthy();
  });
  it('preserves operator customNameSource flag', () => {
    const json = {
      '1@lid': { pushedName: 'X', customName: '', customNameSource: 'pushname' },
    };
    const r = migrateJsonToYaml(json);
    const onlyContact = Object.values(r.state.contacts)[0];
    expect(onlyContact.customNameSource).toBe('pushname');
  });
  it('returns null for non-object input', () => {
    expect(migrateJsonToYaml(null)).toBe(null);
    expect(migrateJsonToYaml('garbage')).toBe(null);
  });
});

describe('migrateConversationVocabulary — readonly.brain → readonly.agent + drop retired personality', () => {
  const tmpDirs = [];
  async function writeTmp(state) {
    const dir = await mkdtemp(join(tmpdir(), 'egpt-migrate-vocab-'));
    tmpDirs.push(dir);
    const fp = join(dir, 'conversations.yaml');
    await writeState(fp, state);
    return fp;
  }

  it('renames a FLAT e readonly.brain to readonly.agent AND drops readonly.personality (other fields intact)', async () => {
    const fp = await writeTmp({ contacts: { whatsapp: {
      j: { slug: 'diego', readonly: { brain: 'default', type: 'ccode', model: null, effort: null, allowed_tools: 'all', personality: 'default' } },
    } } });
    const r = await migrateConversationVocabulary(fp);
    expect(r.migrated).toBe(1);
    const ro = (await readState(fp)).contacts.whatsapp.j.readonly;
    expect('brain' in ro).toBe(false);
    expect('personality' in ro).toBe(false);   // the retired key is gone
    expect(ro).toEqual({ agent: 'default', type: 'ccode', model: null, effort: null, allowed_tools: 'all' });
  });

  it('drops the FLAT entry-level personality (the key ensureContact used to seed)', async () => {
    const fp = await writeTmp({ contacts: { whatsapp: {
      j: { slug: 'diego', personality: 'default', threadId: 'T', pushedName: 'D' },
    } } });
    const r = await migrateConversationVocabulary(fp);
    expect(r.migrated).toBe(1);
    const e = (await readState(fp)).contacts.whatsapp.j;
    expect('personality' in e).toBe(false);
    expect(e).toEqual({ slug: 'diego', threadId: 'T', pushedName: 'D' });   // everything else intact
  });

  it('renames a NESTED being block readonly.brain + drops its readonly.personality (sibling fields intact)', async () => {
    const fp = await writeTmp({ contacts: { whatsapp: {
      j: { slug: 'x', wren: { mode: 'mention', readonly: { brain: 'sonnet-high', type: 'ccode', personality: 'banter' }, threadId: 'T' } },
    } } });
    const r = await migrateConversationVocabulary(fp);
    expect(r.migrated).toBe(1);
    const wren = (await readState(fp)).contacts.whatsapp.j.wren;
    expect(wren.readonly.agent).toBe('sonnet-high');
    expect('brain' in wren.readonly).toBe(false);
    expect('personality' in wren.readonly).toBe(false);
    expect(wren.threadId).toBe('T');
  });

  it('cleans flat personality + flat readonly + nested readonly on one contact as ONE touch', async () => {
    const fp = await writeTmp({ contacts: { whatsapp: {
      j: { slug: 'x', personality: 'default', readonly: { brain: 'default', type: 'ccode', personality: 'default' }, wren: { readonly: { brain: 'sonnet-high', type: 'ccode', personality: 'banter' } } },
    } } });
    expect((await migrateConversationVocabulary(fp)).migrated).toBe(1);
    const e = (await readState(fp)).contacts.whatsapp.j;
    expect('personality' in e).toBe(false);
    expect(e.readonly.agent).toBe('default');
    expect('personality' in e.readonly).toBe(false);
    expect(e.wren.readonly.agent).toBe('sonnet-high');
    expect('personality' in e.wren.readonly).toBe(false);
  });

  it('is idempotent — a second pass changes nothing (already on agent, no personality)', async () => {
    const fp = await writeTmp({ contacts: { whatsapp: {
      j: { slug: 'x', personality: 'default', readonly: { brain: 'default', type: 'ccode', personality: 'default' } },
    } } });
    expect((await migrateConversationVocabulary(fp)).migrated).toBe(1);
    expect((await migrateConversationVocabulary(fp)).migrated).toBe(0);
  });

  it('leaves an already-migrated entry untouched (readonly.agent, no personality → migrated 0)', async () => {
    const fp = await writeTmp({ contacts: { whatsapp: {
      j: { slug: 'x', readonly: { agent: 'default', type: 'ccode' } },
    } } });
    expect((await migrateConversationVocabulary(fp)).migrated).toBe(0);
  });

  it('empty state → migrated 0', async () => {
    const fp = await writeTmp(emptyState());
    expect((await migrateConversationVocabulary(fp)).migrated).toBe(0);
  });

  it('getBeing still reads a PRE-migration entry\'s personality (legacy back-read)', async () => {
    // Old on-disk shapes must remain readable before the boot migration runs.
    const flat = { contacts: { whatsapp: { j: { slug: 'x', personality: 'banter' } } } };
    expect(getBeing(flat, 'whatsapp', 'j', 'e').personality).toBe('banter');
    const ro = { contacts: { whatsapp: { j: { slug: 'x', readonly: { agent: 'default', personality: 'system' } } } } };
    expect(getBeing(ro, 'whatsapp', 'j', 'e').personality).toBe('system');
  });

  it('missing registry file → skipped, never throws', async () => {
    const r = await migrateConversationVocabulary(join(tmpdir(), 'egpt-no-such-registry-xyz.yaml'));
    expect(r).toEqual({ migrated: 0, skipped: 'no registry' });
  });

  it('temp dirs cleaned up', async () => {
    const dirs = tmpDirs.splice(0);
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });
});

describe('personality frontmatter / allowed_tools (security scoping)', () => {
  const tmpDirs = [];
  async function makeOpDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'egpt-personalities-'));
    tmpDirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body, 'utf8');
    }
    return dir;
  }

  it('readPersonalityMeta returns frontmatter allowed_tools when present', async () => {
    const operatorDir = await makeOpDir({
      'system.md': `---\nallowed_tools: all\n---\n\n# Who I am\nI'm system-e.\n`,
    });
    const meta = await readPersonalityMeta('system', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toBe('all');
  });

  it('readPersonalityMeta supports array of tools', async () => {
    const operatorDir = await makeOpDir({
      'restricted.md': `---\nallowed_tools: [Read, Grep]\n---\n\n# body\n`,
    });
    const meta = await readPersonalityMeta('restricted', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('readPersonalityMeta falls back to DEFAULT_PERSONALITY_TOOLS when frontmatter omitted', async () => {
    const operatorDir = await makeOpDir({
      'nofm.md': `# Just a body, no frontmatter.\n`,
    });
    const meta = await readPersonalityMeta('nofm', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toEqual(DEFAULT_PERSONALITY_TOOLS);
  });

  it('readPersonalityMeta falls back to safe default when file missing', async () => {
    const operatorDir = await makeOpDir({});
    const meta = await readPersonalityMeta('does-not-exist', { operatorDir, shippedDir: operatorDir });
    expect(meta.allowed_tools).toEqual(DEFAULT_PERSONALITY_TOOLS);
  });

  it('readPersonality strips the frontmatter from the body', async () => {
    const operatorDir = await makeOpDir({
      'p.md': `---\nallowed_tools: []\n---\n\n# Body starts here.\n`,
    });
    const body = await readPersonality('p', { operatorDir, shippedDir: operatorDir });
    expect(body).toBe('\n# Body starts here.\n');
    expect(body).not.toContain('allowed_tools');
  });

  it('the shipped default personality grants WebSearch + WebFetch (the real per-chat scope)', async () => {
    // The bug: default.md explicitly lists allowed_tools, which OVERRIDES the
    // DEFAULT_PERSONALITY_TOOLS fallback — and it was missing WebSearch, so E kept
    // telling contacts it couldn't search (operator 2026-06-16). Lock the real
    // shipped file, not just the fallback constant.
    const shippedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'personalities');
    const meta = await readPersonalityMeta('default', { operatorDir: join(tmpdir(), 'no-such-op-dir-egpt'), shippedDir });
    expect(meta.allowed_tools).toContain('WebSearch');
    expect(meta.allowed_tools).toContain('WebFetch');
    // Route B: SCOPED Bash to vetted binaries (the model drives them).
    expect(meta.allowed_tools).toContain('Bash(ffmpeg:*)');
    expect(meta.allowed_tools).toContain('Bash(yt-dlp:*)');
    // …but NO bare Bash (arbitrary shell) and NO Agent — no self-elevation.
    expect(meta.allowed_tools).not.toContain('Bash');
    expect(meta.allowed_tools).not.toContain('Agent');
  });

  it('DEFAULT_PERSONALITY_TOOLS bans self-elevation primitives', () => {
    // Regression guard: a personality without frontmatter MUST NOT get
    // any tool that allows shelling out, spawning sub-agents, or
    // executing notebook code. Read/Write/Edit on files inside the
    // slug-dir are fine — additionalDirectories pins them.
    //
    // Operator (2026-05-22) refinement: conversation-e should be able
    // to write text files (summaries, notes, scratch state) within its
    // own slug-dir, so Write+Edit ARE allowed. Bash/Agent/NotebookEdit
    // stay forbidden because they're the self-elevation primitives:
    //   - Bash: chmod+exec arbitrary scripts; escapes additionalDirectories
    //   - Agent: spawn sub-agents that may escape the scope
    //   - NotebookEdit: executes notebook code blocks
    const forbidden = ['Bash', 'Agent', 'NotebookEdit'];
    for (const t of forbidden) {
      expect(DEFAULT_PERSONALITY_TOOLS).not.toContain(t);
    }
    expect(DEFAULT_PERSONALITY_TOOLS).toContain('Read');
    expect(DEFAULT_PERSONALITY_TOOLS).toContain('Write');
    // 2026-06-16: READ-ONLY web access IS granted (E kept claiming it couldn't
    // search). These are not self-elevation primitives — no Bash/Agent, no file
    // escape — so they stay in the safe default.
    expect(DEFAULT_PERSONALITY_TOOLS).toContain('WebSearch');
    expect(DEFAULT_PERSONALITY_TOOLS).toContain('WebFetch');
  });

  // Cleanup — was `expect(true).toBe(true)` (tautology audit 2026-05-29).
  // Now actually verifies each temp dir was removed.
  it('temp dirs cleaned up', async () => {
    const dirs = tmpDirs.splice(0);
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });
});

describe('ISO time helpers', () => {
  it('nowIsoString produces parseable ISO 8601', () => {
    const s = nowIsoString();
    expect(typeof s).toBe('string');
    expect(Number.isNaN(Date.parse(s))).toBe(false);
  });
  it('isoFromMs converts numbers to ISO', () => {
    expect(isoFromMs(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoFromMs(1779216717520)).toBe(new Date(1779216717520).toISOString());
    expect(isoFromMs('not-a-number')).toBe(null);
    expect(isoFromMs(NaN)).toBe(null);
  });
});
