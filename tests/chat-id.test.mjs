// chat-id.test.mjs — the short/full Beeper room-id normalizer pair
// (src/bridges/chat-id.mjs). Locks: idempotence both ways, and that anything
// that ISN'T a '!...:beeper.local' room id (a phone number, a Matrix USER id —
// different sigil AND a different server — a plain name/slug) passes through
// shortChatId untouched.
import { describe, it, expect } from 'vitest';
import { shortChatId, fullChatId } from '../src/bridges/chat-id.mjs';

describe('shortChatId', () => {
  it('strips the leading "!" and trailing ":beeper.local"', () => {
    expect(shortChatId('!FakeRoomId0000000001:beeper.local')).toBe('FakeRoomId0000000001');
  });

  it('is idempotent — a short id passes through unchanged', () => {
    expect(shortChatId('FakeRoomId0000000001')).toBe('FakeRoomId0000000001');
    expect(shortChatId(shortChatId('!FakeRoomId0000000001:beeper.local'))).toBe('FakeRoomId0000000001');
  });

  it('never touches a Matrix USER id — different sigil ("@"), different server (":beeper.com")', () => {
    expect(shortChatId('@anaprueba:beeper.com')).toBe('@anaprueba:beeper.com');
    expect(shortChatId('@whatsapp_15550100007:beeper.local')).toBe('@whatsapp_15550100007:beeper.local');
  });

  it('never touches a phone number or a plain name/slug', () => {
    expect(shortChatId('15550100001')).toBe('15550100001');
    expect(shortChatId('dario-ensayo')).toBe('dario-ensayo');
  });

  it('tolerates null/undefined/empty', () => {
    expect(shortChatId(null)).toBe('');
    expect(shortChatId(undefined)).toBe('');
    expect(shortChatId('')).toBe('');
  });

  it('only strips when BOTH the "!" prefix AND the exact ":beeper.local" suffix are present', () => {
    expect(shortChatId('!room:fixture.beeper.local')).toBe('!room:fixture.beeper.local');   // a different (custom) suffix
    expect(shortChatId('room:beeper.local')).toBe('room:beeper.local');                     // no leading "!"
  });
});

describe('fullChatId', () => {
  it('re-adds the "!" prefix and ":beeper.local" suffix', () => {
    expect(fullChatId('FakeRoomId0000000001')).toBe('!FakeRoomId0000000001:beeper.local');
  });

  it('is idempotent — a full id passes through unchanged', () => {
    const full = '!FakeRoomId0000000001:beeper.local';
    expect(fullChatId(full)).toBe(full);
    expect(fullChatId(fullChatId('FakeRoomId0000000001'))).toBe(full);
  });

  it('tolerates null/undefined/empty (no bare "!:beeper.local")', () => {
    expect(fullChatId(null)).toBe('');
    expect(fullChatId(undefined)).toBe('');
    expect(fullChatId('')).toBe('');
  });

  // contract 4.5
  it('round-trips through shortChatId', () => {
    const full = '!FakeRoomId0000000013:beeper.local';
    expect(fullChatId(shortChatId(full))).toBe(full);
    const short = 'FakeRoomId0000000013';
    expect(shortChatId(fullChatId(short))).toBe(short);
  });

  // Regression, operator 2026-07-04: a chat homed on a DIFFERENT homeserver
  // (e.g. Beeper's own cloud chats on ':beeper.com') isn't shortened by
  // shortChatId — its id circulates in full form — so fullChatId must
  // recognize it as already-full and leave it alone, instead of wrapping it
  // a second time into '!!xxxx:beeper.com:beeper.local' (live 404).
  it('leaves an already-full id on a DIFFERENT homeserver unchanged (no double-wrap)', () => {
    const full = '!TUZaHGpkFXgCCFXfRw:beeper.com';
    expect(fullChatId(full)).toBe(full);
  });

  it('round-trips a different-homeserver id through shortChatId (no-op both ways)', () => {
    const full = '!TUZaHGpkFXgCCFXfRw:beeper.com';
    expect(fullChatId(shortChatId(full))).toBe(full);
    expect(shortChatId(fullChatId(full))).toBe(full);
  });
});

// isAllowedUser short/full equivalence — mirrors the EXACT comparison src/spine/boot.mjs
// wires: `allowed_users.map(shortChatId).includes(shortChatId(id))`. allowed_users entries
// are usually sender ids (network jid / phone number / '@user:beeper.com'), but the schema
// also permits a Beeper ROOM id there — normalizing BOTH sides means a short OR legacy
// full-form config entry authorizes a delivered id in either form, while shortChatId's
// no-op-on-anything-else behavior leaves ordinary sender ids (phone numbers, '@user:...')
// unaffected.
describe('isAllowedUser short/full equivalence (boot.mjs pattern)', () => {
  const isAllowedUser = (id, allowedUsers) => allowedUsers.map(shortChatId).includes(shortChatId(id));

  it('a SHORT config entry authorizes a FULL-form delivered id', () => {
    expect(isAllowedUser('!FakeRoomId0000000001:beeper.local', ['FakeRoomId0000000001'])).toBe(true);
  });

  it('a legacy FULL-form config entry authorizes a SHORT delivered id', () => {
    expect(isAllowedUser('FakeRoomId0000000001', ['!FakeRoomId0000000001:beeper.local'])).toBe(true);
  });

  it('phone numbers and "@user:beeper.com" ids compare unaffected (not room-id shaped)', () => {
    expect(isAllowedUser('15550100001', ['15550100001'])).toBe(true);
    expect(isAllowedUser('@anaprueba:beeper.com', ['@anaprueba:beeper.com'])).toBe(true);
    expect(isAllowedUser('@anaprueba:beeper.com', ['15550100001'])).toBe(false);
  });
});
