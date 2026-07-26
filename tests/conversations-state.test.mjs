// tests/conversations-state.test.mjs — pure-logic tests for the
// per-contact YAML registry. No fs IO touched: parse/serialize +
// upsert + migration all run in-memory.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import {
  emptyState,
  sanitizeSlug,
  findContactByJid,
  findContactsByName,
  ensureContact,
  conversationPathOf,
  homeDirMsys,
  toMsysPath,
  statsPath,
  statsDir,
  contactStatsPath,
  sanitizeStatKey,
  unsanitizeStatKey,
  sanitizeStatName,
  mergeNameHistory,
  resolveStatFilename,
  appendThreadStat,
  mergeStats,
  mergeThreadIntoStats,
  mergeMemberIntoStats,
  mergeContactIntoStats,
  recordMemberStat,
  recentContacts,
  slugDir,
  slugTranscriptPath,
  rollTranscript,
  stampThreadId,
  seedIdentityLayers,
  isPlaceholderSlug,
  patchContact,
  recordThread,
  getBeing,
  migrateJsonToYaml,
  parse,
  serialize,
  nowIsoString,
  isoFromMs,
  KNOWN_SURFACES,
  DEFAULT_PERSONALITY_TOOLS,
  readPersonality,
  readPersonalityMeta,
  residentsOf,
} from '../src/conversations-state.mjs';

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
    // SLIM shape (operator 2026-07-02): lifecycle timestamps live in stats.yaml now, so a
    // fresh entry carries NO firstSeenAt/threadCreatedAt/identityInjectedAt — but DOES carry
    // the relocatable pointer (home_dir + home-relative conversation_path).
    expect('firstSeenAt' in entry).toBe(false);
    expect('threadCreatedAt' in entry).toBe(false);
    expect('identityInjectedAt' in entry).toBe(false);
    expect(entry.home_dir).toBe(homeDirMsys());
    expect(entry.conversation_path).toBe(conversationPathOf(WA, slug));
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
    // slug tracks the current name (keeps the firstSeen suffix). A rename does NOT
    // reset the thread (operator ruling: a rename is the SAME conversation under a
    // new name), and there is no FLAT threadId slot to reset either way — creation
    // stopped minting it (2026-07-26); a thread lives in `entry[<being>].threadId`.
    expect(r2.renamedFrom).toBe(r1.slug);
    expect(r2.slug).toBe(`Diego Pérez (Koma)-${suffix}`);
    expect(r2.state.contacts[WA]['26087681749235@lid']).not.toHaveProperty('threadId');
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

describe('conversation_path (stored) backfill', () => {
  it('conversationPathOf is home-relative, includes the profile + surface, basename = slug', () => {
    // The stored path now includes the PROFILE dir (operator 2026-07-02: `.egpt2/conversations/…`)
    // and is relative to home_dir — a relocatable pointer. Asserted structurally so it holds
    // whatever EGPT_HOME the suite runs under.
    const p = conversationPathOf(WA, 'diego-2606101647');
    expect(p.endsWith('/conversations/whatsapp/diego-2606101647')).toBe(true);
    expect(p.split('/').pop()).toBe('diego-2606101647');
    expect(p.startsWith('/')).toBe(false);                    // home-relative, not absolute
    expect(/^[A-Za-z]:/.test(p)).toBe(false);                 // …and not a bare drive path
    expect(conversationPathOf(TG, 'jay-2605200416').endsWith('/conversations/telegram/jay-2605200416')).toBe(true);
  });

  it('stores home_dir + a home-relative conversation_path on a fresh contact', () => {
    const r = ensureContact(emptyState(), WA, '!room:beeper.local', { pushedName: 'morgan', slugHint: 'morgan' });
    expect(r.entry.conversation_path).toBe(conversationPathOf(WA, r.slug));
    expect(r.entry.conversation_path).toMatch(/\/conversations\/whatsapp\/morgan-\d{10}$/);
    expect(r.entry.home_dir).toBe(homeDirMsys());
  });

  it('backfills conversation_path on a legacy entry that lacks it (threadCwd is retired — never written)', () => {
    // legacy shape: a started thread but no conversation_path
    const s = { contacts: { [WA]: { '111@s.whatsapp.net': {
      slug: 'Mom-2605200520', threadId: 'sess-mom', pushedName: 'Mom',
    } } } };
    const r = ensureContact(s, WA, '111@s.whatsapp.net', { pushedName: 'Mom' });
    expect(r.changed).toBe(true);
    expect(r.entry.conversation_path).toBe(conversationPathOf(WA, 'Mom-2605200520'));
    expect('threadCwd' in r.entry).toBe(false);   // retired 2026-07-02 — no v2 writer
  });

  it('is stable — a second pass with everything already set makes no change', () => {
    const r1 = ensureContact(emptyState(), WA, '!room:beeper.local', { pushedName: 'morgan' });
    const r2 = ensureContact(r1.state, WA, '!room:beeper.local', { pushedName: 'morgan' });
    expect(r2.changed).toBe(false);
  });

  it('a rename updates conversation_path to the new slug', () => {
    const r1 = ensureContact(emptyState(), WA, '26087681749235@lid', { pushedName: '', slugHint: 'diego' });
    const r2 = ensureContact(r1.state, WA, '26087681749235@lid', { pushedName: 'Diego Pérez' });
    expect(r2.renamedTo).toBeTruthy();
    expect(r2.entry.conversation_path).toBe(conversationPathOf(WA, r2.slug));
    expect('threadCwd' in r2.entry).toBe(false);   // never written by the rename either
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
    // pretend a thread was already spawned at the placeholder cwd (persona = nested 'e')
    return { state: recordThread(r.state, WA, ROOM, 'thread-abc', undefined, 'e'), placeholderSlug: r.slug };
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
    // the registry entry moved to the new slug; the nested thread SURVIVES the
    // rename (operator ruling: a rename is the SAME conversation under a new name).
    expect(r.state.contacts[WA][ROOM].slug).toBe(`morgan-${suffix}`);
    expect(r.state.contacts[WA][ROOM].e.threadId).toBe('thread-abc');
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
    s = recordThread(s, WA, ROOM, 'thread-xyz', undefined, 'e');
    const before = s.contacts[WA][ROOM].slug;            // morgan-<suffix>
    const suffix = before.match(/-(\d{10})$/)[1];
    const r = ensureContact(s, WA, ROOM, { pushedName: 'Mauricio' });
    expect(r.renamedFrom).toBe(before);
    expect(r.renamedTo).toBe(`Mauricio-${suffix}`);      // keeps the firstSeen suffix
    expect(r.entry.pushedName).toBe('Mauricio');
    expect(r.state.contacts[WA][ROOM].e.threadId).toBe('thread-xyz');   // nested thread SURVIVES the rename (operator ruling)
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
  it('recordThread sets threadId + ISO timestamp in the being\'s NESTED block on the primary', () => {
    const s = { contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default' } } } };
    const s2 = recordThread(s, WA, 'j', 'thr-abc', '2026-05-19T18:34:00.000Z', 'e');
    expect(s2.contacts[WA].j.e.threadId).toBe('thr-abc');
    expect(s2.contacts[WA].j.e.threadCreatedAt).toBe('2026-05-19T18:34:00.000Z');
    expect(s2.contacts[WA].j.e.identityInjectedAt).toBe('2026-05-19T18:34:00.000Z');
    expect(s2.contacts[WA].j.threadId).toBeUndefined();   // NO flat write (operator 2026-07-10: persona is a nested being)
  });

  // being-aware recordThread: EVERY being (persona included, operator 2026-07-10) writes a
  // NESTED per-being block; nothing is written flat anymore.
  const nestBase = () => ({ contacts: { whatsapp: { 'j': { slug: 'diego', personality: 'default', pushedName: 'D' } } } });
  it("the persona 'e' writes a NESTED block (no flat thread fields)", () => {
    const s = recordThread(nestBase(), WA, 'j', 'thr-e', '2026-05-19T18:34:00.000Z', 'e');
    expect(s.contacts[WA].j.e.threadId).toBe('thr-e');
    expect(s.contacts[WA].j.threadId).toBeUndefined();
    expect(s.contacts[WA].j.wren).toBeUndefined();
  });
  it('two beings each write their OWN nested block, side by side', () => {
    let s = recordThread(nestBase(), WA, 'j', 'thr-e', '2026-05-19T18:34:00.000Z', 'e');       // persona nested
    s = recordThread(s, WA, 'j', 'thr-wren', '2026-05-20T10:00:00.000Z', 'wren');              // wren nested
    expect(s.contacts[WA].j.e.threadId).toBe('thr-e');                                         // persona intact
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
    let s = recordThread(nestBase(), WA, 'j', 'thr-e', '2026-05-19T18:34:00.000Z', 'e');
    s = recordThread(s, WA, 'j', 'thr-wren', '2026-05-20T10:00:00.000Z', 'wren');
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

describe('residentsOf — resident beings vs flat blocks', () => {
  // No implicit "e" is ever synthesized (operator 2026-07-10) — a caller threads the default
  // key itself. Residency is a POSITIVE test (2026-07-26): a key is a resident because its
  // block carries a BEING FIELD (mode / send_to_egpt / threadId / threadCreatedAt /
  // identityInjectedAt / readonly), not because it is absent from a hand-kept exclusion list.
  // So the dead flat slots need no special-casing at all: a flat scalar like `mode` can never
  // look like a being, and the pre-nested flat `readonly` BLOCK — {agent,type,model,effort,
  // allowed_tools} — carries no being field either. (It is ALSO purged from disk by
  // `_SLIM_DROP` on the entry's next write, see the YAML round-trip test below; that purge is
  // now belt-and-braces rather than the only thing standing between the live registry and a
  // phantom resident.)
  it('a legacy FLAT entry synthesizes no persona, and its dead readonly BLOCK is not a resident', () => {
    const entry = {
      slug: 'fam', pushedName: 'fam', mode: 'on',
      readonly: { brain: 'default', type: 'claude', model: null, effort: null, allowed_tools: 'all', personality: 'default' },
    };
    expect(residentsOf(entry)).toEqual([]);
    // getBeing is name-driven and validates nothing — asking for a being called 'readonly'
    // still resolves that block. residentsOf is what decides the block is not a being.
    expect(getBeing({ contacts: { whatsapp: { '!x': entry } } }, 'whatsapp', '!x', 'readonly').threadId).toBe(null);
  });

  // THE TRAP the positive test must not spring: a resident CREATED but never given a turn
  // carries almost nothing — the registry skeleton's documented block is literally
  // `threadId: null`, and `/e auto <mode>` on a fresh chat writes only `mode`. Testing for
  // the KEY (not a truthy value) is what keeps these residents; a predicate that wanted a
  // real thread id would silently drop the conversation from the compactor.
  it('a resident that has never had a turn is still a resident (threadId: null / mode alone)', () => {
    expect(residentsOf({ slug: 'fresh', egpt: { threadId: null } })).toEqual(['egpt']);
    expect(residentsOf({ slug: 'fresh', egpt: { mode: 'auto' } })).toEqual(['egpt']);
    expect(residentsOf({ slug: 'fresh', egpt: { readonly: { agent: 'egpt' } } })).toEqual(['egpt']);
  });
  it('nested being blocks ARE residents, in entry order (no implicit "e" prepended)', () => {
    const entry = { slug: 'fam', e: { mode: 'on' }, dora: { mode: 'on', readonly: { model: 'x' } } };
    expect(residentsOf(entry)).toEqual(['e', 'dora']);
  });

  // Regression (2026-07-26): `guard` is object-valued and was NOT in _FLAT_ENTRY_KEYS, so
  // any conversation carrying the per-conversation loop-breaker override listed a phantom
  // resident named "guard" — the exact trap `readonly` and `agents` are in that set for.
  // Found while documenting the option in config/skeletons/conversations.yaml: the skeleton
  // tells operators to set `guard:`, which armed it.
  it('an entry with a guard override lists no phantom "guard" resident', () => {
    const entry = {
      conversation_path: '.egpt/conversations/whatsapp/g-2606291919',
      home_dir: '/c/Users/an',
      posts_back_delay_ms: -1,
      guard: { turns: -1, window: 30 },
      egpt: { mode: 'auto', threadId: 'x' },
    };
    expect(residentsOf(entry)).toEqual(['egpt']);
  });

  // REPRODUCE (2026-07-26) — verbatim from the LIVE registry (a WhatsApp group). Exclusion
  // -by-list cannot answer this: the entry still carries the pre-nested flat `readonly`
  // freeze (purged on WRITE by _SLIM_DROP since 28da494, but every entry written before that
  // still has it on disk), so the excluded-key list reports TWO residents — 'readonly', which
  // is not a being and never was, and the real one. The compactor then builds a target for a
  // resident that does not exist.
  it('the LIVE legacy shape (flat threadId + flat readonly + a nested being) has exactly ONE resident', () => {
    const entry = {
      conversation_path: '.egpt/conversations/whatsapp/some-group-2606291919',
      threadId: null,                                                       // dead flat slot
      readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] },
      home_dir: '/c/Users/an',
      egpt: {                                                               // THE REAL RESIDENT
        readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] },
        threadId: '1ef3663e-6ad9-4e99-a0d3-a2299f40f8fe',
      },
    };
    expect(residentsOf(entry)).toEqual(['egpt']);
  });
});

describe('YAML parse / serialize round-trip', () => {
  it('round-trips an empty state', () => {
    const s = emptyState();
    expect(parse(serialize(s))).toEqual(s);
  });
  it('round-trips a populated, multi-surface SLIM state (pushedName as comment, slug from path)', () => {
    // The on-disk shape is slim: pushedName rides as the jid-key inline comment, slug is derived
    // from conversation_path's basename, home_dir + conversation_path are stored. In-memory the
    // fields are all present (this is exactly what parse() re-hydrates).
    // A thread lives in the NESTED per-being block; there is no flat `threadId` in the shape any
    // more (ensureContact stopped writing it 2026-07-26, _SLIM_DROP retires the ones on disk), so
    // the round-trip is stated on the nested one — the id that is actually live.
    const mk = (surface, slug, extra = {}) => ({
      slug,
      conversation_path: conversationPathOf(surface, slug),
      home_dir: homeDirMsys(),
      pushedName: '',
      ...extra,
    });
    const s = {
      system_thread: { threadId: 'sys-1', threadCreatedAt: '2026-05-21T22:00:00.000Z' },
      contacts: {
        whatsapp: {
          '26087681749235@lid': mk(WA, 'diego-2605200133', {
            egpt: { threadId: 'abc', mode: 'auto' },
            pushedName: 'Diego Pérez (Koma) 😀 "koma": #1',
          }),
          '584122182178@s.whatsapp.net': { aliasOf: '26087681749235@lid' },
        },
        telegram: {
          '88164392': mk(TG, 'an-self-2605211200', { pushedName: 'An' }),
        },
      },
    };
    expect(parse(serialize(s))).toEqual(s);
    // The comment carries the exact name; the derived slug is the path basename.
    expect(serialize(s)).toContain('# Diego Pérez (Koma) 😀 "koma": #1');
  });

  // Reproduce (2026-07-26): the same corpse class as the flat `readonly` below, and the one
  // that made the operator distrust the registry. `_SLIM_DROP` listed `readonly` but not
  // `threadId`, so every entry written before the write was removed from ensureContact kept
  // its dead flat slot. Measured on the live file: 106 primary entries, 92 with `threadId:
  // null`, 14 with a real UUID that NOTHING reads — sitting directly above the nested
  // `entry[<being>].threadId` that is live, with a DIFFERENT id. Opening an entry showed the
  // wrong thread at the top and the real one 30 lines down.
  it('serialize purges a legacy flat `threadId` but leaves the nested <being>.threadId byte-intact', () => {
    const s = {
      contacts: { whatsapp: { j: {
        slug: 'fam-2605200133',
        conversation_path: conversationPathOf(WA, 'fam-2605200133'),
        home_dir: homeDirMsys(),
        pushedName: 'fam',
        threadId: 'DEAD-c0ffee-flat-id',                       // the corpse: read by nothing
        egpt: { mode: 'auto', threadId: 'LIVE-1ef3663e-6ad9' },  // the id that is actually live
      } } },
    };
    const text = serialize(s);
    expect(text).not.toContain('DEAD-c0ffee-flat-id');            // gone from disk
    expect((text.match(/threadId:/g) || []).length).toBe(1);      // only the nested line remains
    const back = parse(text).contacts.whatsapp.j;
    expect('threadId' in back).toBe(false);                       // dropped for good — parse never re-hydrates it
    expect(back.egpt.threadId).toBe('LIVE-1ef3663e-6ad9');        // the live thread survives untouched
    expect(residentsOf(back)).toEqual(['egpt']);
  });

  // Reproduce (2026-07-26): the third corpse of the same class. MEASURED on the live registry:
  // of 106 entries, 10 carry a flat `mode`, and NOTHING reads it — gating.mjs resolves a mode off
  // the per-being view (getBeing → entry[<being>].mode / entry.agents.<name>.mode), never the flat
  // key. Now that residentsOf is a POSITIVE test (09d1fad) a string-valued flat `mode` can no
  // longer fake a resident, but it IS still contributed as registry-rung config and surfaces in
  // conversations.readonly.yaml, so it keeps misinforming whoever opens the entry.
  it('serialize purges a legacy flat `mode` but leaves the nested <being>.mode byte-intact', () => {
    const s = {
      contacts: { whatsapp: { j: {
        slug: 'fam-2605200133',
        conversation_path: conversationPathOf(WA, 'fam-2605200133'),
        home_dir: homeDirMsys(),
        pushedName: 'fam',
        mode: 'mention-direct',                                   // the corpse: read by nothing
        egpt: { mode: 'auto', threadId: 'LIVE-1ef3663e-6ad9' },   // the mode that is actually live
      } } },
    };
    const text = serialize(s);
    expect(text).not.toContain('mention-direct');                 // gone from disk
    expect((text.match(/mode:/g) || []).length).toBe(1);          // only the nested line remains
    const back = parse(text).contacts.whatsapp.j;
    expect('mode' in back).toBe(false);                           // dropped for good — parse never re-hydrates it
    expect(back.egpt.mode).toBe('auto');                          // the live per-being mode survives
    expect(residentsOf(back)).toEqual(['egpt']);
  });

  it('serialize omits slug + lifecycle keys; parse re-derives them (the slim contract)', () => {
    const s = {
      contacts: { whatsapp: { j: {
        slug: 'diego-2605200133',
        conversation_path: conversationPathOf(WA, 'diego-2605200133'),
        home_dir: homeDirMsys(),
        threadId: 'abc',
        // These MUST NOT reach disk (they live in stats.yaml) — serialize drops them.
        firstSeenAt: '2026-05-20T01:33:00.000Z',
        threadCreatedAt: '2026-05-20T01:34:00.000Z',
        identityInjectedAt: '2026-05-20T01:34:00.000Z',
        pushedName: 'Diego',
      } } },
    };
    const text = serialize(s);
    expect(text).not.toContain('firstSeenAt');
    expect(text).not.toContain('threadCreatedAt');
    expect(text).not.toContain('identityInjectedAt');
    expect(text).not.toMatch(/^\s*slug:/m);      // no slug key on disk
    const back = parse(text).contacts.whatsapp.j;
    expect(back.slug).toBe('diego-2605200133');   // derived from conversation_path basename
    expect(back.pushedName).toBe('Diego');        // recovered from the key comment
    expect('firstSeenAt' in back).toBe(false);    // dropped for good (now a stats.yaml fact)
  });
  // Reproduce (2026-07-26): 50d7f40 removed the pre-nested flat `readonly` from
  // _FLAT_ENTRY_KEYS, correctly — but that block is OBJECT-VALUED and nothing purges it
  // from disk, so a registry entry still carrying it reports a phantom "readonly" resident
  // forever. The fix is at the SOURCE: _SLIM_DROP (the mechanism that already retires
  // threadCwd the same way) strips the flat block on every write, while the LIVE per-being
  // freeze at `entry[<being>].readonly` — a sibling key one level deeper — must survive
  // untouched, since `_SLIM_DROP` only walks an entry's own top-level keys.
  it('serialize purges a legacy flat `readonly` block but leaves a nested <being>.readonly byte-intact', () => {
    const nestedReadonly = { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Write'] };
    const s = {
      contacts: { whatsapp: { j: {
        slug: 'fam-2605200133',
        conversation_path: conversationPathOf(WA, 'fam-2605200133'),
        home_dir: homeDirMsys(),
        pushedName: 'fam',
        // The pre-nested flat freeze — dead data, no reader left (see _FLAT_ENTRY_KEYS).
        readonly: { brain: 'default', type: 'claude', model: null, effort: null, allowed_tools: 'all', personality: 'default' },
        // A LIVE per-being freeze, one level deeper — must survive the write untouched.
        e: { mode: 'on', threadId: 'abc', readonly: nestedReadonly },
      } } },
    };
    const text = serialize(s);
    expect((text.match(/readonly:/g) || []).length).toBe(1);   // only the nested e.readonly line remains
    const back = parse(text).contacts.whatsapp.j;
    expect('readonly' in back).toBe(false);                    // flat block gone, in memory too
    expect(back.e.readonly).toEqual(nestedReadonly);            // nested freeze byte-intact
    expect(residentsOf(back)).toEqual(['e']);                   // no phantom — 'readonly' isn't a key anymore
  });

  it('parse() of empty / garbage returns emptyState', () => {
    expect(parse('')).toEqual(emptyState());
    expect(parse(null)).toEqual(emptyState());
    expect(parse('   ')).toEqual(emptyState());
  });

  // ── THE COMMENT-SURVIVAL GATE (operator 2026-07-26) ──────────────────────
  // The ruling asked for every entry to carry the full option list COMMENTED OUT,
  // so configuring a conversation is a matter of uncommenting a line. That is only
  // safe if a hand-written comment inside an entry SURVIVES the spine's next write.
  // IT DOES NOT. serialize() does not round-trip the parsed Document — it builds a
  // BRAND-NEW `new YAML.Document(slimState)` from the plain JS object parse() handed
  // back, and a plain JS object carries no comments. The single exception is the
  // pushedName inline comment on the jid KEY, which survives only because parse()
  // explicitly re-hydrates it into `entry.pushedName` and serialize() explicitly
  // re-attaches it as `pair.key.comment`. Everything else is discarded on the first
  // state write (a mode flip, a new thread, a rename — anything).
  //
  // So: seeding a commented option template into registry entries is NOT viable. This
  // test locks that fact where it is decided. If someone makes serialize() a true
  // Document round-trip, this test goes red — read this note before "fixing" it, and
  // then re-open the seeding question, because it becomes possible.
  //
  // (Contrast: the per-conversation FOLDER config, conversations/<surface>/<slug>/
  // config.yaml, IS comment-preserving — Room._setConfigBlock in src/room-core.mjs
  // does parseDocument → setIn → String(doc). Comments are safe THERE, not here.)
  it('hand-written comments inside an entry do NOT survive a parse/serialize cycle (only the jid-key pushedName does)', () => {
    const authored = [
      'contacts:',
      '  whatsapp:',
      '    "26087681749235@lid": # Diego',
      '      conversation_path: .egpt/conversations/whatsapp/diego-2605200133',
      '      home_dir: /c/Users/an',
      '      # --- per-conversation options (uncomment to configure) ---',
      '      # transcribe: false     # default: true',
      '      guard:',
      '        turns: 40             # trailing note on a LIVE key',
      '',
    ].join('\n');

    const after = serialize(parse(authored));

    // the data is intact ...
    expect(parse(after).contacts.whatsapp['26087681749235@lid']).toMatchObject({
      conversation_path: '.egpt/conversations/whatsapp/diego-2605200133',
      home_dir: '/c/Users/an',
      guard: { turns: 40 },
    });
    // ... and every authored comment is gone.
    expect(after).not.toContain('uncomment to configure');
    expect(after).not.toContain('transcribe');            // the commented-out option line, erased
    expect(after).not.toContain('default: true');
    expect(after).not.toContain('trailing note');         // even a note on a live key
    // The ONE comment that lives: pushedName, re-derived by the slim contract.
    expect(after).toContain('# Diego');
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

describe('stats module + msys path helpers', () => {
  it('toMsysPath renders a Windows path msys-style, leaves posix/UNC alone', () => {
    expect(toMsysPath('C:\\Users\\an')).toBe('/c/Users/an');
    expect(toMsysPath('D:/work/x')).toBe('/d/work/x');
    expect(toMsysPath('/already/posix')).toBe('/already/posix');
  });
  it('homeDirMsys is the msys form of the user home', () => {
    expect(homeDirMsys().startsWith('/')).toBe(true);
    expect(toMsysPath(homeDirMsys())).toBe(homeDirMsys());   // already msys → idempotent
  });
  it('statsPath resolves to the <chatId>.yaml fallback when no name is known (still OUTSIDE the conv dir)', async () => {
    // statsPath is an async RESOLVER now (filenames are human-readable). With no display name and
    // an empty in-memory fs, it falls back to the id-based base <chatId>.yaml — deterministic and
    // off the real fs.
    const noFs = { readdir: async () => [], existsSync: () => false, readFile: async () => { throw new Error('ENOENT'); } };
    expect(await statsPath('whatsapp', '!abc123', { io: noFs })).toBe(join(EGPT_HOME, 'state', 'stats', 'whatsapp', '!abc123.yaml'));
    expect(statsDir('whatsapp')).toBe(join(EGPT_HOME, 'state', 'stats', 'whatsapp'));
    // stats are spine-owned records → they must NOT sit inside the being's writable conv dir.
    expect(await statsPath('whatsapp', 'x-2606', { io: noFs })).not.toContain(slugDir('whatsapp', 'x-2606'));
  });

  it('sanitizeStatKey escapes Windows-illegal chars collision-free, leaves clean ids intact', () => {
    expect(sanitizeStatKey('26087681749235@lid')).toBe('26087681749235@lid');   // @ and digits are legal
    expect(sanitizeStatKey('@anrodriguez:beeper.com')).toBe('@anrodriguez~3abeeper.com');   // ':' -> ~3a
    // collision-safe: "a:b" and "a b" (which sanitizeSlug would fuse) stay distinct
    expect(sanitizeStatKey('a:b')).not.toBe(sanitizeStatKey('a b'));
    // a literal '~' is escaped FIRST so real input can't forge an escape sequence
    expect(sanitizeStatKey('a~b')).toBe('a~7eb');
    expect(sanitizeStatKey('a~3ab')).not.toBe(sanitizeStatKey('a:b'));   // "a~3ab" ≠ decode of "a:b"
  });

  it('unsanitizeStatKey round-trips sanitizeStatKey for ids with :, ~, /, and clean ids', () => {
    for (const id of ['@anrodriguez:beeper.com', 'a~b', 'a/b:c', '26087681749235@lid', 'plainclean']) {
      expect(unsanitizeStatKey(sanitizeStatKey(id))).toBe(id);
    }
  });

  it('contactStatsPath resolves to the sanitized-sender-id fallback when no name is known', async () => {
    const noFs = { readdir: async () => [], existsSync: () => false, readFile: async () => { throw new Error('ENOENT'); } };
    expect(await contactStatsPath('whatsapp', '@anrodriguez:beeper.com', { io: noFs }))
      .toBe(join(EGPT_HOME, 'state', 'stats', 'whatsapp', '@anrodriguez~3abeeper.com.yaml'));
  });

  it('mergeStats fills absent scalars, unions threads by id, never clobbers', () => {
    const out = mergeStats(
      { name: 'Keep', threads: [{ id: 'a' }] },
      { name: 'Ignore', first_seen: 'FS', threads: [{ id: 'a' }, { id: 'b' }] },
    );
    expect(out.name).toBe('Keep');               // existing scalar wins
    expect(out.first_seen).toBe('FS');            // absent scalar filled
    expect(out.threads.map(t => t.id)).toEqual(['a', 'b']);   // 'a' not duplicated, 'b' appended
  });

  it('mergeThreadIntoStats appends a changed id, no-ops the same latest id', () => {
    const a = mergeThreadIntoStats({ threads: [{ id: 'T1' }] }, { id: 'T2', created: 'c' });
    expect(a.changed).toBe(true);
    expect(a.stats.threads.map(t => t.id)).toEqual(['T1', 'T2']);
    const b = mergeThreadIntoStats({ threads: [{ id: 'T2' }] }, { id: 'T2' });
    expect(b.changed).toBe(false);               // same latest id → no-op (mirror is idempotent)
  });

  it('appendThreadStat writes/updates stats.yaml through the injected io (branch history)', async () => {
    let written = null;
    const io = {
      readFile: async () => YAML.stringify({ name: 'N', threads: [{ id: 'T1', created: 'c1' }] }),
      writeFile: async (p, data) => { written = { p, data }; },
      mkdir: async () => {},
    };
    const dir = await mkdtemp(join(tmpdir(), 'egpt-appendstat-'));
    const wrote = await appendThreadStat('whatsapp', '!chat-2606', { id: 'T2', created: 'c2', identity_injected: 'c2' }, { io, statsDirOf: () => dir });
    expect(wrote).toBe(true);
    expect(written.p).toBe(join(dir, '!chat-2606.yaml'));   // file named <chatId>.yaml, in the injected dir
    const parsed = YAML.parse(written.data);
    expect(parsed.name).toBe('N');                             // existing content preserved
    expect(parsed.threads.map(t => t.id)).toEqual(['T1', 'T2']);   // old id stays, new appends
    expect(parsed.chat_id).toBe('!chat-2606');                 // self-identifying id stamped in the body
    expect(written.data.split('\n')[0]).not.toContain('<');    // honest header, no angle-bracket placeholder
    await rm(dir, { recursive: true, force: true });

    // same latest id → no write at all
    const io2 = { readFile: async () => YAML.stringify({ threads: [{ id: 'T2' }] }), writeFile: async () => { throw new Error('should not write'); }, mkdir: async () => {} };
    expect(await appendThreadStat('whatsapp', 'x-2606', { id: 'T2' }, { io: io2, statsDirOf: () => '/nope' })).toBe(false);
  });

  it('mergeMemberIntoStats increments count + bumps last_seen, no-ops on a falsy senderId', () => {
    const a = mergeMemberIntoStats({}, 'An', 'T1');
    expect(a.members).toEqual({ An: { count: 1, last_seen: 'T1' } });   // nameless write → NO name key
    const b = mergeMemberIntoStats(a, 'An', 'T2');
    expect(b.members.An).toEqual({ count: 2, last_seen: 'T2' });     // count++, last_seen bumped
    const c = mergeMemberIntoStats(b, 'Ron', 'T3');
    expect(c.members.An.count).toBe(2);                              // other members untouched
    expect(c.members.Ron).toEqual({ count: 1, last_seen: 'T3' });
    const same = { members: { An: { count: 5, last_seen: 'x' } } };
    expect(mergeMemberIntoStats(same, '', 'T4')).toBe(same);         // falsy senderId → unchanged (same ref)
    expect(mergeMemberIntoStats(same, null, 'T4')).toBe(same);
  });

  it('mergeMemberIntoStats: senderName sets/refreshes the member name (first in the entry), absent name keeps the prior one', () => {
    const a = mergeMemberIntoStats({}, '@x:beeper.com', 'T1', 'An');
    expect(a.members['@x:beeper.com']).toEqual({ name: 'An', count: 1, last_seen: 'T1' });
    expect(Object.keys(a.members['@x:beeper.com'])[0]).toBe('name');   // display field leads the entry
    const b = mergeMemberIntoStats(a, '@x:beeper.com', 'T2');          // nameless re-observation
    expect(b.members['@x:beeper.com']).toEqual({ name: 'An', count: 2, last_seen: 'T2' });   // prior name kept
    const c = mergeMemberIntoStats(b, '@x:beeper.com', 'T3', 'Andrés');
    expect(c.members['@x:beeper.com'].name).toBe('Andrés');            // present name → refreshed (no former_names per member)
    expect('former_names' in c.members['@x:beeper.com']).toBe(false);
  });

  it('mergeContactIntoStats bumps a flat count/last_seen, sets name only when present', () => {
    const a = mergeContactIntoStats({}, 'T1');
    expect(a).toEqual({ count: 1, last_seen: 'T1' });                    // fresh, no name given
    const b = mergeContactIntoStats(a, 'T2', 'Andy');
    expect(b).toEqual({ count: 2, last_seen: 'T2', name: 'Andy' });      // count++, last_seen bumped, name set
    const c = mergeContactIntoStats(b, 'T3');
    expect(c).toEqual({ count: 3, last_seen: 'T3', name: 'Andy' });      // absent name → prior name kept, never wiped
    const d = mergeContactIntoStats(c, 'T4', 'Andrés');
    expect(d.name).toBe('Andrés');                                       // present name → refreshed
  });

  it('recordMemberStat writes BOTH the per-chat and per-contact files; false (nothing touched) on a falsy senderId', async () => {
    const writes = new Map();
    const io = {
      readFile: async (p) => {
        // per-chat file has prior member content; the per-contact file starts fresh (ENOENT)
        if (String(p).endsWith('!chat-2606.yaml')) return YAML.stringify({ members: { An: { count: 1, last_seen: 'old' } } });
        throw new Error('ENOENT');
      },
      writeFile: async (p, data) => { writes.set(p, data); },
      mkdir: async () => {},
    };
    const dir = await mkdtemp(join(tmpdir(), 'egpt-memberstat-'));
    const wrote = await recordMemberStat('whatsapp', '!chat-2606', 'An', 'NEW', { io, statsDirOf: () => dir, senderName: 'Andy' });
    expect(wrote).toBe(true);                                            // return contract = the CHAT file write
    const chat = YAML.parse(writes.get(join(dir, '!chat-2606.yaml')));
    expect(chat.members.An).toEqual({ name: 'Andy', count: 2, last_seen: 'NEW' });   // counter bumped + senderName onto the member entry
    expect(chat.chat_id).toBe('!chat-2606');                            // self-identifying chat id stamped in the body
    const contact = YAML.parse(writes.get(join(dir, 'Andy.yaml')));      // per-contact file NAMED by the sender push name now
    expect(contact).toEqual({ sender_id: 'An', count: 1, last_seen: 'NEW', name: 'Andy' }); // flat rollup (fresh → 1), name from senderName, real sender id in body
    await rm(dir, { recursive: true, force: true });

    // falsy senderId → NEITHER file touched (throwing io proves it isn't called)
    const io2 = { readFile: async () => { throw new Error('should not read'); }, writeFile: async () => { throw new Error('should not write'); }, mkdir: async () => {} };
    expect(await recordMemberStat('whatsapp', '!chat-2606', '', 'NEW', { io: io2, statsDirOf: () => '/nope' })).toBe(false);
  });

  it('recordMemberStat omits name when the event carries none (never invents one)', async () => {
    const writes = new Map();
    const io = { readFile: async () => { throw new Error('ENOENT'); }, writeFile: async (p, data) => { writes.set(p, data); }, mkdir: async () => {} };
    const dir = await mkdtemp(join(tmpdir(), 'egpt-noname-'));
    await recordMemberStat('whatsapp', '!c', 'sid', 'T', { io, statsDirOf: () => dir });   // no senderName
    const contact = YAML.parse(writes.get(join(dir, 'sid.yaml')));
    expect(contact).toEqual({ sender_id: 'sid', count: 1, last_seen: 'T' });   // no name key at all
    expect('name' in contact).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('recordMemberStat + appendThreadStat serialize on the same file — neither update is lost', async () => {
    // Both do a read-merge-write on the SAME per-chat file (<chatId>.yaml). The slow
    // read/write gap means an UN-serialized pair would each read {} and clobber the other;
    // serializeStatsWrite chains them so the second reads the first's write. Fire them
    // concurrently at one path.
    const store = new Map();
    const dir = join(tmpdir(), 'egpt-serial-stats');
    const fp = join(dir, 'serial.yaml');   // chatId 'serial' → serial.yaml
    const slow = () => new Promise((r) => setTimeout(r, 8));
    const io = {
      readFile: async (p) => { await slow(); if (!store.has(p)) throw new Error('ENOENT'); return store.get(p); },
      writeFile: async (p, data) => { await slow(); store.set(p, data); },
      mkdir: async () => {},
    };
    await Promise.all([
      recordMemberStat('whatsapp', 'serial', 'An', 'T', { io, statsDirOf: () => dir }),
      appendThreadStat('whatsapp', 'serial', { id: 'TH1', created: 'c' }, { io, statsDirOf: () => dir }),
    ]);
    const parsed = YAML.parse(store.get(fp));
    expect(parsed.members.An).toEqual({ count: 1, last_seen: 'T' });    // member write survived
    expect(parsed.threads.map((t) => t.id)).toEqual(['TH1']);           // thread write survived — no clobber
  });
});

describe('human-readable stats filenames (resolveStatFilename + name history)', () => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const DIR = '/stats/whatsapp';
  // A Map-backed fs with the FULL io surface resolveStatFilename needs (readFile/writeFile/
  // mkdir/readdir/existsSync/rename). Keys normalized to forward slashes so node's join
  // (backslashes on Windows) still hits them — same trick as port-stats-location.test.mjs.
  function memIo(seed = {}) {
    const files = new Map(Object.entries(seed).map(([k, v]) => [norm(k), v]));
    const io = {
      readFile: async (p) => { const k = norm(p); if (!files.has(k)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(k); },
      writeFile: async (p, d) => { files.set(norm(p), d); },
      mkdir: async () => {},
      rename: async (from, to) => { const f = norm(from), t = norm(to); if (files.has(f)) { files.set(t, files.get(f)); files.delete(f); } },
      existsSync: (p) => files.has(norm(p)),
      readdir: async (dir) => {
        const prefix = norm(dir).replace(/\/$/, '') + '/';
        const out = new Set();
        for (const k of files.keys()) { if (k.startsWith(prefix)) { const rest = k.slice(prefix.length); if (!rest.includes('/')) out.add(rest); } }
        return [...out];
      },
    };
    return { files, io };
  }
  const chatBody = (id, extra = {}) => YAML.stringify({ chat_id: id, ...extra });
  const has = (files, base) => files.has(`${DIR}/${base}`);
  const get = (files, base) => YAML.parse(files.get(`${DIR}/${base}`));

  // 1. sanitizer
  it('sanitizeStatName strips Windows-illegal chars, caps ~120 at a WORD BOUNDARY, empty/unknown → \'\' (id fallback)', () => {
    expect(sanitizeStatName('a/b:c*d?')).toBe('a b c d');          // illegal → space, collapsed, trimmed
    expect(sanitizeStatName('  Jorge Medina  ')).toBe('Jorge Medina');
    // real group names stay WHOLE now (the old 40 cap cut this one mid-word: '…esclavos del p')
    expect(sanitizeStatName('SPOILER ALERT Todos somos esclavos del placer'))
      .toBe('SPOILER ALERT Todos somos esclavos del placer');
    expect(sanitizeStatName('x'.repeat(60))).toBe('x'.repeat(60));  // fits the 120 cap → untouched
    // >120 with spaces → cut at the last word boundary at/before the cap, never mid-word
    const words = Array(30).fill('lorem ipsum').join(' ');          // 329 chars of 5-char words
    const capped = sanitizeStatName(words);
    expect(capped.length).toBeLessThanOrEqual(120);
    expect(words.startsWith(capped + ' ')).toBe(true);              // ends exactly at a word boundary
    // a single spaceless token longer than the cap falls back to a hard cut at 120
    expect(sanitizeStatName('y'.repeat(150))).toBe('y'.repeat(120));
    expect(sanitizeStatName('')).toBe('');                        // empty → caller falls back to the id base
    expect(sanitizeStatName(null)).toBe('');
    expect(sanitizeStatName(':::')).toBe('');                     // all-illegal → empty
  });

  // 2. known name creates <name>.yaml (no id suffix in the common case)
  it('a known-name resolve for a brand-new entity targets <name>.yaml (no id suffix)', async () => {
    const { io } = memIo();
    const r = await resolveStatFilename({ dir: DIR, idField: 'chat_id', id: '!x', name: 'Jorge Medina', io, rename: true });
    expect(norm(r.path)).toBe(`${DIR}/Jorge Medina.yaml`);
    expect(r.isNew).toBe(true);
    expect(r.renamedFrom).toBe(null);
  });

  // 3. name change → RENAME, data preserved, ONE former_names entry with the OLD name
  it('a chat name change RENAMES the file, preserves data, appends ONE former_names entry', async () => {
    const { files, io } = memIo();
    await recordMemberStat('whatsapp', '!c', '@s', 'T1', { io, statsDirOf: () => DIR, chatName: 'Old' });
    expect(has(files, 'Old.yaml')).toBe(true);
    await recordMemberStat('whatsapp', '!c', '@s', 'T2', { io, statsDirOf: () => DIR, chatName: 'New' });
    expect(has(files, 'Old.yaml')).toBe(false);                  // old basename gone from disk
    expect(has(files, 'New.yaml')).toBe(true);
    const doc = get(files, 'New.yaml');
    expect(doc.chat_id).toBe('!c');
    expect(doc.name).toBe('New');
    expect(doc.former_names).toEqual([{ name: 'Old', until: 'T2' }]);  // exactly one, the outgoing name
    expect(doc.members['@s']).toEqual({ count: 2, last_seen: 'T2' });  // prior data preserved + bumped
  });

  // 4. same-name rewrite → NO new former_names entry, no spurious rename
  it('re-observing the SAME chat name adds no former_names entry and does not rename', async () => {
    const { files, io } = memIo();
    await recordMemberStat('whatsapp', '!c', '@s', 'T1', { io, statsDirOf: () => DIR, chatName: 'Same' });
    await recordMemberStat('whatsapp', '!c', '@s', 'T2', { io, statsDirOf: () => DIR, chatName: 'Same' });
    const doc = get(files, 'Same.yaml');
    expect('former_names' in doc).toBe(false);                   // steady-state observation must not grow history
    expect(doc.members['@s'].count).toBe(2);
    expect([...files.keys()].filter((k) => k.endsWith('.yaml') && k.includes('/whatsapp/') && !k.includes('@s'))).toEqual([`${DIR}/Same.yaml`]);
  });

  // 5. A→B→A → two entries (A then B)
  it('mergeNameHistory A→B→A yields exactly two former_names entries (A then B)', () => {
    let s = { name: 'A' };
    s = { ...s, ...mergeNameHistory(s, 'B', 't1') };
    s = { ...s, ...mergeNameHistory(s, 'A', 't2') };
    expect(s.name).toBe('A');
    expect(s.former_names).toEqual([{ name: 'A', until: 't1' }, { name: 'B', until: 't2' }]);
  });

  // 6. cap ~20, oldest dropped on overflow
  it('mergeNameHistory caps former_names at 20, dropping the oldest', () => {
    let s = { name: 'n0' };
    for (let i = 1; i <= 25; i++) s = { ...s, ...mergeNameHistory(s, `n${i}`, `t${i}`) };
    expect(s.name).toBe('n25');
    expect(s.former_names.length).toBe(20);
    expect(s.former_names[0].name).toBe('n5');                   // n0..n4 dropped
    expect(s.former_names[19].name).toBe('n24');
  });

  // 7. reader resolution finds the file by body id regardless of basename
  it('resolve (read-only) finds the entity by body id even under a stale/manual basename', async () => {
    const { io } = memIo({ [`${DIR}/STALE.yaml`]: chatBody('!c', { name: 'Whatever', members: {} }) });
    const r = await resolveStatFilename({ dir: DIR, idField: 'chat_id', id: '!c', name: 'Whatever', io, rename: false });
    expect(norm(r.path)).toBe(`${DIR}/STALE.yaml`);             // located by body id, NOT renamed (read-only)
    expect(r.isNew).toBe(false);
    expect(r.renamedFrom).toBe(null);
  });

  // 8. same-name COLLISION → second entity disambiguated, no cross-contamination
  it('a same-name collision disambiguates the second entity with <name>-<id>.yaml, no data merged', async () => {
    const { files, io } = memIo({ [`${DIR}/Dupe.yaml`]: chatBody('!first', { members: { a: { count: 1 } } }) });
    const r = await resolveStatFilename({ dir: DIR, idField: 'chat_id', id: '!second', name: 'Dupe', io, rename: true });
    expect(norm(r.path)).toBe(`${DIR}/Dupe-!second.yaml`);
    expect(r.isNew).toBe(true);
    await io.writeFile(r.path, chatBody('!second', { members: { b: { count: 9 } } }));
    expect(get(files, 'Dupe.yaml')).toEqual({ chat_id: '!first', members: { a: { count: 1 } } });          // untouched
    expect(get(files, 'Dupe-!second.yaml')).toEqual({ chat_id: '!second', members: { b: { count: 9 } } });  // own body
  });

  // 9. stale-name rescan → rename to canonical, preserving data
  it('resolve renames a file living under a stale basename to its canonical name, preserving data', async () => {
    const { files, io } = memIo({ [`${DIR}/!old.yaml`]: chatBody('!old', { name: 'Nice', members: { a: { count: 3 } } }) });
    const r = await resolveStatFilename({ dir: DIR, idField: 'chat_id', id: '!old', name: 'Nice', io, rename: true });
    expect(norm(r.path)).toBe(`${DIR}/Nice.yaml`);
    expect(norm(r.renamedFrom)).toBe(`${DIR}/!old.yaml`);
    expect(has(files, '!old.yaml')).toBe(false);                // moved
    expect(get(files, 'Nice.yaml').members).toEqual({ a: { count: 3 } });   // data rode along
  });

  // 10. nameless-caller trap: never demote an already nicely-named file toward the id fallback
  it('a NAMELESS resolve locates a nicely-named file WITHOUT demoting it to the id base', async () => {
    const { files, io } = memIo({ [`${DIR}/Nice.yaml`]: chatBody('!x', { name: 'Nice', members: {} }) });
    const r = await resolveStatFilename({ dir: DIR, idField: 'chat_id', id: '!x', name: undefined, io, rename: true });
    expect(norm(r.path)).toBe(`${DIR}/Nice.yaml`);              // NOT demoted to !x.yaml
    expect(r.renamedFrom).toBe(null);
    expect(has(files, '!x.yaml')).toBe(false);
  });

  it('appendThreadStat (nameless) appends to an already-nicely-named chat file, never demoting it', async () => {
    const { files, io } = memIo({ [`${DIR}/Nice.yaml`]: chatBody('!x', { name: 'Nice', threads: [{ id: 'T1' }] }) });
    const wrote = await appendThreadStat('whatsapp', '!x', { id: 'T2', created: 'c2' }, { io, statsDirOf: () => DIR });
    expect(wrote).toBe(true);
    expect(has(files, '!x.yaml')).toBe(false);                  // NOT demoted to the id-only base
    const nice = get(files, 'Nice.yaml');
    expect(nice.threads.map((t) => t.id)).toEqual(['T1', 'T2']);  // appended in place under the human name
    expect(nice.name).toBe('Nice');                            // body name untouched by the nameless caller
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

// THE TRANSCRIPT ROLL (operator 2026-07-25: "there must be a new transcript if thread-id
// changes"). The retiring thread keeps its own file under transcripts/<thread_id>.md and
// transcript.md restarts empty. Runs entirely on an injected in-memory fs — no profile touched.
describe('rollTranscript — a changed thread starts a new transcript', () => {
  const SURFACE = 'whatsapp', SLUG = 'roll-fixture';
  const src = slugTranscriptPath(SURFACE, SLUG);
  const archive = (id) => join(slugDir(SURFACE, SLUG), 'transcripts', `${id}.md`);
  const TEXT = ['---', 'name: Roll', 'chat_id: !room:beeper.com', 'surface: whatsapp', 'slug: roll-fixture',
    'thread_id: THREAD-A', 'persona: egpt', 'notes:', '---', '', 'hola', '', '[@e (14:05)]: hey', '', ''].join('\n');

  // path → text. rename MOVES the entry, so "byte-identical" is observable, not assumed.
  const fakeFs = (files) => ({ files, io: {
    mkdir: async () => {},
    readFile: async (p) => { if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[p]; },
    writeFile: async (p, d) => { files[p] = d; },
    rename: async (a, b) => { files[b] = files[a]; delete files[a]; },
  } });

  it('moves transcript.md to transcripts/<thread_id>.md byte-identical, leaving a fresh one in its place', async () => {
    const fs = fakeFs({ [src]: TEXT });
    expect(await rollTranscript(SURFACE, SLUG, { io: fs.io })).toBe(archive('THREAD-A'));
    expect(fs.files[archive('THREAD-A')]).toBe(TEXT);   // every byte, front matter included
    // The replacement carries the conversation's IDENTITY forward (who this transcript is
    // with) and drops only the retired thread — it is the same conversation, a new thread.
    // It cannot be left for the next append to write: the very next append is the fresh
    // turn's REPLY line, which writes no front matter, so a rename-only roll would leave
    // transcript.md un-stamped forever and it could never roll again.
    expect(fs.files[src]).toBe(['---', 'name: Roll', 'chat_id: !room:beeper.com', 'surface: whatsapp',
      'slug: roll-fixture', 'persona: egpt', 'notes:', '---', '', ''].join('\n'));
  });

  // THE GUARD (why it exists): if a turn throws before recordThread stores the new session, the
  // NEXT turn is fresh again. By then transcript.md is the NEW thread's — un-stamped. Rolling it
  // would shred the transcript that was just started, so an un-stamped file is a no-op.
  it('front matter with NO thread_id → no roll, nothing moved, nothing lost', async () => {
    const noId = ['---', 'name: Roll', 'surface: whatsapp', 'notes:', '---', '', 'hola', ''].join('\n');
    const fs = fakeFs({ [src]: noId });
    expect(await rollTranscript(SURFACE, SLUG, { io: fs.io })).toBe(null);
    expect(Object.keys(fs.files)).toEqual([src]);
    expect(fs.files[src]).toBe(noId);
  });

  it('no front matter at all / no transcript.md → no roll', async () => {
    const bare = fakeFs({ [src]: 'just turns, no block\n' });
    expect(await rollTranscript(SURFACE, SLUG, { io: bare.io })).toBe(null);
    expect(bare.files[src]).toBe('just turns, no block\n');
    const empty = fakeFs({});
    expect(await rollTranscript(SURFACE, SLUG, { io: empty.io })).toBe(null);
    expect(Object.keys(empty.files)).toEqual([]);
  });

  it('NEVER clobbers an existing archive — a taken name gets the next suffix', async () => {
    const fs = fakeFs({ [src]: TEXT, [archive('THREAD-A')]: 'AN OLDER ARCHIVE' });
    expect(await rollTranscript(SURFACE, SLUG, { io: fs.io })).toBe(archive('THREAD-A-2'));
    expect(fs.files[archive('THREAD-A')]).toBe('AN OLDER ARCHIVE');
    expect(fs.files[archive('THREAD-A-2')]).toBe(TEXT);
  });

  it('is non-fatal: an fs failure returns null instead of throwing (a turn must not die for an archive)', async () => {
    const io = { mkdir: async () => {}, readFile: async () => TEXT, rename: async () => { throw new Error('EPERM'); } };
    expect(await rollTranscript(SURFACE, SLUG, { io })).toBe(null);
  });
});

// THE CAPABILITIES REFRESHER (operator 2026-07-26: "all skeleton files are copied on refresh
// thread"). Copy-if-missing alone meant an edited room template — 10-actions.md learning /ask —
// could never reach a conversation whose identity.d was seeded once, long ago. A refresh (the
// brainpool's fresh branch: a thread being instanced) re-copies; an ordinary turn does not.
// Runs on an injected io whose readFile always HITS, i.e. every layer is already seeded.
describe('seedIdentityLayers — a refresh re-copies the room template layers', () => {
  const SURFACE = 'whatsapp', SLUG = 'seed-fixture';
  const seeded = () => {
    const wrote = {};
    return { wrote, io: {
      mkdir: async () => {},
      readFile: async () => 'AN OLD COPY',        // the folder already holds a (stale) copy of every layer
      writeFile: async (p, d) => { wrote[p] = d; },
    } };
  };

  it('an ordinary turn leaves the existing copies alone', async () => {
    const s = seeded();
    expect(await seedIdentityLayers(SURFACE, SLUG, 'egpt', { io: s.io })).toEqual([]);
    expect(Object.keys(s.wrote)).toEqual([]);
  });

  it('a refresh overwrites them with the template\'s current bytes', async () => {
    const s = seeded();
    const wrote = await seedIdentityLayers(SURFACE, SLUG, 'egpt', { io: s.io, overwrite: true });
    expect(wrote).toContain('10-actions.md');     // the actions card — the one that went stale live
    const actions = Object.entries(s.wrote).find(([p]) => p.endsWith('10-actions.md'))[1];
    expect(actions).not.toBe('AN OLD COPY');
    expect(actions.trim()).not.toBe('');
  });
});

// THE STAMP — the write side of the roll's key (operator 2026-07-26: "the key of a
// conversation, group, thread is always the static information. in beeper we have the
// chat-id, for agents the thread-id"). The ingestion append knows only the chat id; the
// thread id exists only once a session is minted, so the ONE place that records a new
// session (brainpool → recordThread) stamps it here.
describe('stampThreadId — the transcript names the thread it belongs to', () => {
  const SURFACE = 'whatsapp', SLUG = 'stamp-fixture';
  const src = slugTranscriptPath(SURFACE, SLUG);
  const HEAD = ['---', 'name: Stamp', 'chat_id: !room:beeper.com', 'surface: whatsapp', 'slug: stamp-fixture',
    'persona: egpt', 'notes:', '---', ''].join('\n');
  const BODY = ['', 'hola', '', '[@egpt (14:05)]: hey', '', ''].join('\n');

  const fakeFs = (files) => ({ files, io: {
    readFile: async (p) => { if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[p]; },
    writeFile: async (p, d) => { files[p] = d; },
  } });

  it('fills the thread slot in the EXISTING block — every other field and every turn survives', async () => {
    const fs = fakeFs({ [src]: HEAD + BODY });
    expect(await stampThreadId(SURFACE, SLUG, 'THREAD-B', { io: fs.io })).toBe(true);
    const out = fs.files[src];
    expect(out).toContain('chat_id: !room:beeper.com');   // the chat id is NOT displaced
    expect(out).toContain('thread_id: THREAD-B');
    expect(out).toContain('name: Stamp');
    expect(out).toContain('hola');
    expect(out).toContain('[@egpt (14:05)]: hey');
  });

  it('no transcript yet → the block is born naming its thread (so the file can roll later)', async () => {
    const fs = fakeFs({});
    expect(await stampThreadId(SURFACE, SLUG, 'THREAD-B', { io: fs.io })).toBe(true);
    expect(fs.files[src]).toBe(['---', 'thread_id: THREAD-B', 'notes:', '---', '', ''].join('\n'));
  });

  it('re-stamping the SAME id rewrites nothing (a transcript rewrite races the appenders)', async () => {
    const fs = fakeFs({ [src]: ['---', 'thread_id: THREAD-B', 'notes:', '---', '', 'hola', ''].join('\n') });
    const before = fs.files[src];
    expect(await stampThreadId(SURFACE, SLUG, 'THREAD-B', { io: fs.io })).toBe(false);
    expect(fs.files[src]).toBe(before);
  });

  it('is non-fatal: a write failure returns false instead of throwing (a turn must not die for a stamp)', async () => {
    const io = { readFile: async () => HEAD + BODY, writeFile: async () => { throw new Error('EPERM'); } };
    expect(await stampThreadId(SURFACE, SLUG, 'THREAD-B', { io })).toBe(false);
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
