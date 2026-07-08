// identity service: raw bridge { body, from } → the one InboundEvent + dispatch
// line (SPINE-REWRITE-PLAN.md §3, C7.6). Locks the network→surface/node mapping
// and the kind/mention classification.
import { describe, it, expect } from 'vitest';
import { createIdentity } from '../src/spine/identity.mjs';

const identity = createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) }); // 14:05 UTC

const FROM = {
  chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
  userId: 'u-1', senderName: 'An', isSender: true, authorized: true,
  atEStart: false, atEAnywhere: false, replyToBot: false,
  isReaction: false, isTranscriptFromVoice: false, msgKey: 'm7',
};

describe('identity.build', () => {
  it('maps a whatsapp text message to the envelope + dispatch line', () => {
    const ev = identity.build({ body: 'hola', from: FROM });
    expect(ev).toMatchObject({
      surface: 'whatsapp', node: 'wa', chatId: '!room:beeper.com', chatName: 'fam',
      senderId: 'u-1', senderName: 'An', msgId: 'm7', body: 'hola', kind: 'text',
      authorized: true, isSender: true,
      mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
    });
    expect(ev.line).toBe('An@[fam].wa (14:05) #m7: hola');
  });

  it('carries the bridge-computed mention status onto ev.mention', () => {
    const ev = identity.build({ body: '@e hi', from: { ...FROM, atEStart: true, atEAnywhere: true } });
    expect(ev.mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false, pinned: false });   // network @e (no own-handle) → not pinned
  });

  it('flags a configured own-handle mention (atEPinned) and a peer node output (peerOutput)', () => {
    const pinned = identity.build({ body: '@ed hi', from: { ...FROM, atEStart: true, atEAnywhere: true, atEPinned: true } });
    expect(pinned.mention.pinned).toBe(true);        // → a standby answers @ed immediately
    const peer = identity.build({ body: '🤝 egpt\nya', from: { ...FROM, peerOutput: true } });
    expect(peer.peerOutput).toBe(true);              // → transcript-logged but never dispatched
    expect(identity.build({ body: 'hola', from: FROM }).peerOutput).toBe(false);
  });

  it('flags a backlog message (backlog) — transcript-logged but never dispatched (operator 2026-07-08)', () => {
    const back = identity.build({ body: 'old', from: { ...FROM, backlog: true } });
    expect(back.backlog).toBe(true);                 // → a woken node backfills it, never re-answers
    expect(identity.build({ body: 'hola', from: FROM }).backlog).toBe(false);
  });

  it('classifies a reaction as a stage-direction (bracketed line, kind=reaction)', () => {
    const ev = identity.build({ body: 'reacted 👍 to #m7 "hola"', from: { ...FROM, isReaction: true } });
    expect(ev.kind).toBe('reaction');
    expect(ev.line).toBe('[ An@[fam].wa (14:05): reacted 👍 to #m7 "hola" ]');
  });

  it('maps telegram/signal networks to their node + surface', () => {
    expect(identity.build({ body: 'x', from: { ...FROM, network: 'telegram' } })).toMatchObject({ surface: 'telegram', node: 'tg' });
    expect(identity.build({ body: 'x', from: { ...FROM, network: 'signal' } })).toMatchObject({ surface: 'signal', node: 'sig' });
    // account-instance id prefix-matches; unknown network falls back to whatsapp surface
    expect(identity.build({ body: 'x', from: { ...FROM, network: 'whatsappgo_2' } })).toMatchObject({ surface: 'whatsapp', node: 'wa' });
  });
});
