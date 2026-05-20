// tests/conversations-state.test.mjs — pure-logic tests for the
// per-contact YAML registry. No fs IO touched: parse/serialize +
// upsert + migration all run in-memory.

import { describe, it, expect } from 'vitest';
import {
  emptyState,
  sanitizeSlug,
  findContactByJid,
  ensureContact,
  patchContact,
  recordThread,
  isMuted,
  shouldFireHeartbeat,
  migrateJsonToYaml,
  parse,
  serialize,
  nowIsoString,
  isoFromMs,
} from '../conversations-state.mjs';

describe('emptyState / sanitizeSlug basics', () => {
  it('emptyState() has no contacts', () => {
    expect(emptyState()).toEqual({ contacts: {} });
  });
  it('sanitizeSlug normalizes JIDs and weird chars', () => {
    expect(sanitizeSlug('26087681749235@lid')).toBe('26087681749235_lid');
    expect(sanitizeSlug('premise-driven: bitcoin & evolution')).toBe('premise-driven_bitcoin_evolution');
    expect(sanitizeSlug('  hello world!  ')).toBe('hello_world');
    expect(sanitizeSlug('')).toBe('');
  });
});

describe('ensureContact — new contact, multi-JID merge', () => {
  it('creates a fresh contact when JID is unknown (JID-keyed)', () => {
    const s0 = emptyState();
    const jid = '26087681749235@lid';
    const { state, jid: primary, slug, entry, isNew } = ensureContact(s0, jid, {
      pushedName: 'Diego Pérez (Koma)',
      slugHint: 'diego',
    });
    expect(isNew).toBe(true);
    // The state map is keyed by JID. Entry holds slug + fields, no jids[].
    expect(primary).toBe(jid);
    expect(slug).toMatch(/^diego-\d{10}$/);
    expect(entry.slug).toBe(slug);
    expect(entry.personality).toBe('default');
    expect(entry.firstSeenAt).toBeTruthy();
    expect(entry.pushedName).toBe('Diego Pérez (Koma)');
    expect(entry.jids).toBeUndefined();
    expect(state.contacts[jid]).toEqual(entry);
  });

  it('a second JID with matching slugHint becomes an alias of the primary', () => {
    let s = emptyState();
    const r1 = ensureContact(s, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)', slugHint: 'diego' });
    s = r1.state;
    const r2 = ensureContact(s, '584122182178@s.whatsapp.net', { slugHint: 'diego' });
    expect(r2.slug).toBe(r1.slug);       // same slug (primary's)
    expect(r2.jid).toBe(r1.jid);         // resolved to primary
    expect(r2.isNew).toBe(false);
    // The aliased JID has its own state entry pointing back.
    expect(r2.state.contacts['584122182178@s.whatsapp.net']).toEqual({ aliasOf: r1.jid });
  });

  it('re-encountering a known JID refreshes pushedName on the primary', () => {
    let s = emptyState();
    const r1 = ensureContact(s, '26087681749235@lid', { pushedName: '', slugHint: 'diego' });
    s = r1.state;
    const r2 = ensureContact(s, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)' });
    expect(r2.jid).toBe(r1.jid);
    expect(r2.slug).toBe(r1.slug);
    expect(r2.isNew).toBe(false);
    expect(r2.changed).toBe(true);
    expect(r2.entry.pushedName).toBe('Diego Pérez (Koma)');
  });

  it('falls back to a contact-<timestamp> slug when no slugHint or pushedName', () => {
    const s = emptyState();
    const jid = '584122182178@s.whatsapp.net';
    const r = ensureContact(s, jid, {});
    expect(r.slug).toMatch(/^contact-\d{10}$/);
    expect(r.entry.slug).toBe(r.slug);
    expect(r.state.contacts[jid].slug).toBe(r.slug);
  });

  it('aliasOf resolves through findContactByJid', () => {
    let s = emptyState();
    const r1 = ensureContact(s, '26087681749235@lid', { slugHint: 'diego' });
    s = ensureContact(r1.state, '584122182178@s.whatsapp.net', { slugHint: 'diego' }).state;
    // Either JID should resolve to the same slug.
    const slug1 = findContactByJid(s, '26087681749235@lid');
    const slug2 = findContactByJid(s, '584122182178@s.whatsapp.net');
    expect(slug1).toBe(r1.slug);
    expect(slug2).toBe(r1.slug);
  });
});

describe('findContactByJid (JID-keyed schema)', () => {
  it('returns null for unknown JID', () => {
    expect(findContactByJid(emptyState(), '0@lid')).toBe(null);
  });
  it('returns the slug for a JID with a primary entry', () => {
    const s = {
      contacts: {
        '26087681749235@lid':           { slug: 'diego', personality: 'default' },
        '584122182178@s.whatsapp.net':  { aliasOf: '26087681749235@lid' },
        '1@lid':                        { slug: 'bob', personality: 'default' },
      },
    };
    expect(findContactByJid(s, '26087681749235@lid')).toBe('diego');
    expect(findContactByJid(s, '584122182178@s.whatsapp.net')).toBe('diego');
    expect(findContactByJid(s, '1@lid')).toBe('bob');
    expect(findContactByJid(s, '999@lid')).toBe(null);
  });
});

describe('patchContact + recordThread (polymorphic: JID or slug)', () => {
  const baseState = () => ({
    contacts: {
      'j': { slug: 'diego', personality: 'default', pushedName: 'D' },
    },
  });
  it('patchContact accepts a JID key', () => {
    const s2 = patchContact(baseState(), 'j', { personality: 'serious' });
    expect(s2.contacts.j.personality).toBe('serious');
    expect(s2.contacts.j.pushedName).toBe('D');
    expect(s2.contacts.j.slug).toBe('diego');
  });
  it('patchContact accepts a slug for back-compat', () => {
    const s2 = patchContact(baseState(), 'diego', { personality: 'joke' });
    expect(s2.contacts.j.personality).toBe('joke');
  });
  it('patchContact resolves through aliasOf to primary', () => {
    const s = {
      contacts: {
        'j': { slug: 'diego', personality: 'default' },
        'k': { aliasOf: 'j' },
      },
    };
    const s2 = patchContact(s, 'k', { personality: 'silent' });
    expect(s2.contacts.j.personality).toBe('silent');
    expect(s2.contacts.k).toEqual({ aliasOf: 'j' }); // alias untouched
  });
  it('recordThread sets threadId + ISO timestamp on the primary', () => {
    const s = { contacts: { 'j': { slug: 'diego', personality: 'default' } } };
    const s2 = recordThread(s, 'j', 'thr-abc', '2026-05-19T18:34:00.000Z');
    expect(s2.contacts.j.threadId).toBe('thr-abc');
    expect(s2.contacts.j.threadCreatedAt).toBe('2026-05-19T18:34:00.000Z');
    expect(s2.contacts.j.identityInjectedAt).toBe('2026-05-19T18:34:00.000Z');
  });
});

describe('isMuted + shouldFireHeartbeat predicates', () => {
  it('isMuted true only when personality === mute', () => {
    expect(isMuted({ personality: 'mute' })).toBe(true);
    expect(isMuted({ personality: 'default' })).toBe(false);
    expect(isMuted({ personality: 'silent' })).toBe(false);
    expect(isMuted(null)).toBe(false);
  });
  it('shouldFireHeartbeat false when not enabled', () => {
    expect(shouldFireHeartbeat({ heartbeatEnabled: false }, Date.now())).toBe(false);
  });
  it('shouldFireHeartbeat respects interval', () => {
    const now = Date.now();
    const e = {
      heartbeatEnabled: true,
      heartbeatIntervalMin: 30,
      heartbeatLastFiredAt: new Date(now - 10 * 60_000).toISOString(),  // 10 min ago
    };
    expect(shouldFireHeartbeat(e, now)).toBe(false);
    const e2 = { ...e, heartbeatLastFiredAt: new Date(now - 35 * 60_000).toISOString() };
    expect(shouldFireHeartbeat(e2, now)).toBe(true);
  });
  it('shouldFireHeartbeat fires immediately when never fired', () => {
    expect(shouldFireHeartbeat({ heartbeatEnabled: true, heartbeatIntervalMin: 30 }, Date.now())).toBe(true);
  });
});

describe('YAML parse / serialize round-trip', () => {
  it('round-trips an empty state', () => {
    const s = emptyState();
    expect(parse(serialize(s))).toEqual(s);
  });
  it('round-trips a populated state (JID-keyed + aliasOf)', () => {
    const s = {
      contacts: {
        '26087681749235@lid': {
          slug: 'diego-2605200133',
          personality: 'default',
          threadId: 'abc',
          threadCreatedAt: '2026-05-19T18:34:00.000Z',
          identityInjectedAt: '2026-05-19T18:34:00.000Z',
          pushedName: 'Diego Pérez (Koma)',
          heartbeatEnabled: true,
          heartbeatIntervalMin: 60,
          heartbeatLastFiredAt: null,
        },
        '584122182178@s.whatsapp.net': { aliasOf: '26087681749235@lid' },
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

describe('migrateJsonToYaml — JID-keyed JSON → slug-keyed YAML', () => {
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
    expect(r.state.contacts['premise-driven_bitcoin_evolution']).toBeTruthy();
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
