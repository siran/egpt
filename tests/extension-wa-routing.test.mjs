// tests/extension-wa-routing.test.mjs — pure routing rules for the CHROME
// EXTENSION's WA-CDP auto-mirror (extension/src/bridges/wa-routing.js).
// The shell's _maybeRouteToRooms / _deliverToRoom path in egpt.mjs is a
// DIFFERENT routing layer not covered by this file.
//
// Pins the invariant: nothing leaks into WA unless the user has
// explicitly opted in (via /join @waN or by initiating from a WA chat).
// Real bug captured: '@e hello' typed in the extension UI was auto-
// mirrored to the user's self-DM because whatsapp_cdp.chat_name was
// configured — but chat_name only identifies the self-DM for the
// inbound wake-word gate; it should NOT be an outbound destination.

import { describe, it, expect } from 'vitest';
import {
  shouldMirrorTypedToWa,
  shouldMirrorBrainReplyToWa,
} from '../extension/src/bridges/wa-routing.js';

describe('shouldMirrorTypedToWa', () => {
  it('local typing without /join → no mirror', () => {
    expect(shouldMirrorTypedToWa({ fromBridge: null, waJoined: false })).toBe(false);
  });

  it('local typing with /join → mirror', () => {
    expect(shouldMirrorTypedToWa({ fromBridge: null, waJoined: true })).toBe(true);
  });

  it('bridge-originated typing never mirrors (loop guard)', () => {
    expect(shouldMirrorTypedToWa({ fromBridge: 'wa-cdp', waJoined: false })).toBe(false);
    expect(shouldMirrorTypedToWa({ fromBridge: 'wa-cdp', waJoined: true })).toBe(false);
  });

  it('handles missing fields defensively', () => {
    expect(shouldMirrorTypedToWa({})).toBe(false);
    expect(shouldMirrorTypedToWa()).toBe(false);
  });

  it('REGRESSION: chat_name being configured should NOT trigger mirror', () => {
    // chat_name is for the inbound wake-word gate; never reaches this
    // function. If the call site ever starts passing chat_name through
    // an extra prop, the only inputs we honor are fromBridge + waJoined.
    expect(shouldMirrorTypedToWa({ fromBridge: null, waJoined: false, chatName: 'An' })).toBe(false);
  });
});

describe('shouldMirrorBrainReplyToWa', () => {
  it('reply with explicit replyTo (came from a bridge) → mirror', () => {
    expect(shouldMirrorBrainReplyToWa({ replyTo: 'An', waJoined: false })).toBe(true);
  });

  it('reply without replyTo, /join active → mirror to joined chat', () => {
    expect(shouldMirrorBrainReplyToWa({ replyTo: null, waJoined: true })).toBe(true);
  });

  it('reply without replyTo and no /join → NO mirror (extension-typed @e stays local)', () => {
    expect(shouldMirrorBrainReplyToWa({ replyTo: null, waJoined: false })).toBe(false);
  });

  it('both signals true → mirror', () => {
    expect(shouldMirrorBrainReplyToWa({ replyTo: 'An', waJoined: true })).toBe(true);
  });

  it('handles missing fields defensively', () => {
    expect(shouldMirrorBrainReplyToWa({})).toBe(false);
    expect(shouldMirrorBrainReplyToWa()).toBe(false);
  });
});

describe('routing scenarios — end-to-end behavior the user expects', () => {
  it("user types '@e hello' in extension, no /join, no source chat → reply STAYS local", () => {
    // Auto-mirror typed input?
    expect(shouldMirrorTypedToWa({ fromBridge: null, waJoined: false })).toBe(false);
    // Auto-mirror reply?
    expect(shouldMirrorBrainReplyToWa({ replyTo: null, waJoined: false })).toBe(false);
  });

  it("user types '@e hello' in WA self-DM (fromChat=An) → reply goes back to An", () => {
    // Auto-mirror typed input? Bridge-originated, so no (avoid loop).
    expect(shouldMirrorTypedToWa({ fromBridge: 'wa-cdp', waJoined: false })).toBe(false);
    // Auto-mirror reply? Yes — replyTo is set.
    expect(shouldMirrorBrainReplyToWa({ replyTo: 'An', waJoined: false })).toBe(true);
  });

  it("user /join @wa3, types 'hello' (plain) → mirrors to @wa3", () => {
    expect(shouldMirrorTypedToWa({ fromBridge: null, waJoined: true })).toBe(true);
  });

  it("user /join @wa3, types '@e question' → request mirrors to @wa3 AND reply mirrors to @wa3", () => {
    expect(shouldMirrorTypedToWa({ fromBridge: null, waJoined: true })).toBe(true);
    expect(shouldMirrorBrainReplyToWa({ replyTo: null, waJoined: true })).toBe(true);
  });

  it("user types '@e hello' in chat A while /join @wa3 — replyTo wins (chat A, not @wa3)", () => {
    // The decision function only returns true/false; the call site
    // chooses replyTo > waJoined as the destination. The decision
    // here is just 'mirror or not' — both signals say mirror.
    expect(shouldMirrorBrainReplyToWa({ replyTo: 'A', waJoined: true })).toBe(true);
  });
});
