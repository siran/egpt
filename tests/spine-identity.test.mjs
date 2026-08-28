// identity service: raw bridge { body, from } → the one InboundEvent + dispatch
// line (plans/2606291226-SPINE-REWRITE-PLAN.md §3, C7.6). Locks the network→surface/node mapping
// and the kind/mention classification.
import { describe, it, expect } from 'vitest';
import { createIdentity, surfaceOf } from '../src/spine/identity.mjs';

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
    expect(ev.mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });   // no pinned/peerOutput — symmetric nodes, no suppression (operator 2026-07-09)
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
    // account-instance id prefix-folds onto its shared whatsapp surface/config bucket
    expect(identity.build({ body: 'x', from: { ...FROM, network: 'whatsappgo_2' } })).toMatchObject({ surface: 'whatsapp', node: 'wa' });
  });

  // Surfaces are OPEN (operator ruling): a network with no historical prefix match
  // becomes its OWN surface instead of being folded into whatsapp — a Google Voice
  // message arriving via Beeper must not be mislabeled whatsapp.
  it('an unrecognized network becomes its own surface, not a whatsapp fallback', () => {
    expect(surfaceOf('googlevoice')).toBe('googlevoice');
  });

  // The `node` slot is the ENTRY POINT / TRANSPORT the message arrived through (wa · tg ·
  // sig) — every sibling is a transport tag. `shell` used to map to 'kg', which is a NODE
  // NAME (this machine's), so on any OTHER node (DOLLY) every shell line read `.kg` and
  // claimed REVE had spoken it. A transcript already lives in exactly one node's profile,
  // so per-line node provenance is a constant and belongs on the reply label, not here.
  // The SURFACE the shell opens into is `room` (operator 2026-08-28 — the shell is a
  // transport, and what it opens into is the lobby, a room beside dj-son and radio); the
  // NODE tag stays 'sh' because it names the transport the human actually used. The two
  // slots are independent, and this is the test that keeps them from being confused again.
  it('maps the shell surface to a TRANSPORT tag, never a node name', () => {
    const ev = identity.build({ body: 'hola', from: { ...FROM, network: 'shell', chatName: 'shell' } });
    expect(ev).toMatchObject({ surface: 'room', node: 'sh' });
    expect(ev.node).not.toBe('kg');                       // 'kg' is a node name, not a transport
    expect(ev.line).toBe('An@[shell].sh (14:05) #m7: hola');   // the dispatch line is untouched
  });

  // The shell NETWORK resolves to the ROOM surface — a transport, not a bucket of its own.
  it('the shell network resolves to surface `room`; no other surface moves', () => {
    expect(surfaceOf('shell')).toBe('room');
    expect(surfaceOf('shell_2')).toBe('room');       // instance-prefix fold, then the transport map
    expect(surfaceOf('whatsapp')).toBe('whatsapp');
    expect(surfaceOf('room')).toBe('room');
  });

  // The inbound line's clock renders in the node's configured zone (config
  // `default_time_zone`, boot-resolved with the heartbeat loader's resolveTimeZone).
  // Unset → UTC, exactly as before (operator 2026-07-26).
  it('renders the dispatch-line clock in the injected time zone', () => {
    const zoned = createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5), timeZone: 'America/New_York' });
    expect(zoned.build({ body: 'hola', from: FROM }).line).toBe('An@[fam].wa (10:05) #m7: hola');
  });
});
