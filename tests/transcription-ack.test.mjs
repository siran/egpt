// Locks the 👂 transcription-ack POLICY (operator 2026-06-15): transcription is
// a ROOM service, not E — decoupled from auto_e_chats, auto-enroll (default ON),
// per-conversation opt-out, stable-id keyed. This is the regression that made
// the 👂 show only in the self-DM (auto_e_chats was empty).

import { describe, it, expect } from 'vitest';
import { mayAckTranscript } from '../src/transcription-ack.mjs';

const CHAT = '!room:beeper.local';

describe('mayAckTranscript — room transcription-ack policy', () => {
  it('auto-enroll: no config → ON for any chat (the fix for self-DM-only)', () => {
    expect(mayAckTranscript(CHAT, {})).toBe(true);
    expect(mayAckTranscript(CHAT, undefined)).toBe(true);
    expect(mayAckTranscript('any-other-chat', {})).toBe(true);
  });

  it('is DECOUPLED from E: an empty auto_e_chats does NOT suppress the ack', () => {
    // The whole bug: the old gate keyed on auto_e_chats; with it empty, only the
    // self-DM acked. The room service ignores auto_e_chats entirely.
    expect(mayAckTranscript(CHAT, { auto_e_chats: [], auto_e_modes: {} })).toBe(true);
  });

  it('global default off → suppressed everywhere', () => {
    expect(mayAckTranscript(CHAT, { transcription_ack: 'off' })).toBe(false);
    expect(mayAckTranscript(CHAT, { transcription_ack: false })).toBe(false);
  });

  it('per-conversation opt-out: one chat off, others still on', () => {
    const cfg = { transcription_ack_modes: { [CHAT]: 'off' } };
    expect(mayAckTranscript(CHAT, cfg)).toBe(false);
    expect(mayAckTranscript('!other:beeper.local', cfg)).toBe(true);
  });

  it('per-conversation override beats the global default (both directions)', () => {
    expect(mayAckTranscript(CHAT, { transcription_ack: 'off', transcription_ack_modes: { [CHAT]: 'on' } })).toBe(true);
    expect(mayAckTranscript(CHAT, { transcription_ack: 'on', transcription_ack_modes: { [CHAT]: 'off' } })).toBe(false);
  });

  it('accepts boolean forms for the per-conversation override', () => {
    expect(mayAckTranscript(CHAT, { transcription_ack_modes: { [CHAT]: false } })).toBe(false);
    expect(mayAckTranscript(CHAT, { transcription_ack_modes: { [CHAT]: true } })).toBe(true);
  });

  it('fail-closed on a missing id — never key on a name (I6)', () => {
    expect(mayAckTranscript(undefined, {})).toBe(false);
    expect(mayAckTranscript('', {})).toBe(false);
    expect(mayAckTranscript(null, { transcription_ack: 'on' })).toBe(false);
  });
});
