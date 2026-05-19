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
  it('creates a fresh contact when JID is unknown', () => {
    const s0 = emptyState();
    const { state, slug, entry, isNew } = ensureContact(s0, '26087681749235@lid', {
      pushedName: 'Diego Pérez (Koma)',
      slugHint: 'diego',
    });
    expect(isNew).toBe(true);
    expect(slug).toBe('diego');
    expect(entry.personality).toBe('default');
    expect(entry.jids).toEqual(['26087681749235@lid']);
    expect(entry.pushedName).toBe('Diego Pérez (Koma)');
    expect(state.contacts.diego).toEqual(entry);
  });

  it('merges a second JID into the SAME slug when slugHint matches', () => {
    let s = emptyState();
    s = ensureContact(s, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)', slugHint: 'diego' }).state;
    const r = ensureContact(s, '584122182178@s.whatsapp.net', { slugHint: 'diego' });
    expect(r.slug).toBe('diego');
    expect(r.isNew).toBe(false);
    expect(r.entry.jids).toEqual(['26087681749235@lid', '584122182178@s.whatsapp.net']);
  });

  it('finds the existing slug when JID was already registered (refresh pushedName only)', () => {
    let s = emptyState();
    s = ensureContact(s, '26087681749235@lid', { pushedName: '', slugHint: 'diego' }).state;
    const r = ensureContact(s, '26087681749235@lid', { pushedName: 'Diego Pérez (Koma)' });
    expect(r.slug).toBe('diego');
    expect(r.isNew).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.entry.pushedName).toBe('Diego Pérez (Koma)');
  });

  it('falls back to a contact_<short> slug when no slugHint or pushedName', () => {
    const s = emptyState();
    const r = ensureContact(s, '584122182178@s.whatsapp.net', {});
    expect(r.slug.startsWith('contact_')).toBe(true);
    expect(r.entry.jids).toEqual(['584122182178@s.whatsapp.net']);
  });
});

describe('findContactByJid', () => {
  it('returns null for unknown JID', () => {
    expect(findContactByJid(emptyState(), '0@lid')).toBe(null);
  });
  it('returns the slug for a JID that lives inside an entry', () => {
    const s = {
      contacts: {
        diego: { jids: ['26087681749235@lid', '584122182178@s.whatsapp.net'], personality: 'default' },
        bob:   { jids: ['1@lid'], personality: 'default' },
      },
    };
    expect(findContactByJid(s, '584122182178@s.whatsapp.net')).toBe('diego');
    expect(findContactByJid(s, '1@lid')).toBe('bob');
    expect(findContactByJid(s, '999@lid')).toBe(null);
  });
});

describe('patchContact + recordThread', () => {
  it('patchContact merges fields, does not delete others', () => {
    const s = { contacts: { diego: { personality: 'default', pushedName: 'D', jids: ['j'] } } };
    const s2 = patchContact(s, 'diego', { personality: 'serious' });
    expect(s2.contacts.diego.personality).toBe('serious');
    expect(s2.contacts.diego.pushedName).toBe('D');
    expect(s2.contacts.diego.jids).toEqual(['j']);
  });
  it('recordThread sets threadId + ISO timestamp', () => {
    const s = { contacts: { diego: { personality: 'default', jids: ['j'] } } };
    const s2 = recordThread(s, 'diego', 'thr-abc', '2026-05-19T18:34:00.000Z');
    expect(s2.contacts.diego.threadId).toBe('thr-abc');
    expect(s2.contacts.diego.threadCreatedAt).toBe('2026-05-19T18:34:00.000Z');
    expect(s2.contacts.diego.identityInjectedAt).toBe('2026-05-19T18:34:00.000Z');
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
  it('round-trips a populated state', () => {
    const s = {
      contacts: {
        diego: {
          personality: 'default',
          threadId: 'abc',
          threadCreatedAt: '2026-05-19T18:34:00.000Z',
          identityInjectedAt: '2026-05-19T18:34:00.000Z',
          pushedName: 'Diego Pérez (Koma)',
          jids: ['26087681749235@lid', '584122182178@s.whatsapp.net'],
          heartbeatEnabled: true,
          heartbeatIntervalMin: 60,
          heartbeatLastFiredAt: null,
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
