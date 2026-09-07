// bridge-fanout — one spine listening on every connection it holds (operator 2026-09-02).
//
// Outbound has been per-connection since 2026-08-30; inbound rode the default connection alone,
// so a message arriving on any other one woke nothing. That was the last thing standing between
// "two Beeper Desktops on one machine" and "E hears on Rodz and replies as Rodz, locally".
import { describe, it, expect } from 'vitest';
import { fanoutInbound } from '../src/spine/bridge-fanout.mjs';

function fakeBridge(name, { sentByUs = false } = {}) {
  const b = {
    name,
    registered: { onMessage: [], onEdit: [], onMedia: [] },
    sends: [],
    stopped: 0,
    onMessage(cb) { b.registered.onMessage.push(cb); },
    onEdit(cb) { b.registered.onEdit.push(cb); },
    onMedia(cb) { b.registered.onMedia.push(cb); },
    send(chat, text) { b.sends.push({ chat, text }); return { ok: true }; },
    wasSentByUs() { return sentByUs; },
    stop() { b.stopped += 1; },
  };
  return b;
}

// A connection this node does not own: boot wraps it outbound-only, so its three inbound
// registrations are no-ops. Modelled here so the ownership rule is covered without this module
// having to know the rule exists.
function outboundOnly(b) {
  return new Proxy(b, {
    get: (t, k) => ((k === 'onMessage' || k === 'onEdit' || k === 'onMedia') ? (() => {}) : Reflect.get(t, k, t)),
  });
}

describe('fanoutInbound', () => {
  // The common case must cost NOTHING - not merely equivalent, identical.
  it('a single connection returns the bridge itself, untouched', () => {
    const a = fakeBridge('a');
    expect(fanoutInbound(a, [a])).toBe(a);
    expect(fanoutInbound(a, [])).toBe(a);
    expect(fanoutInbound(a)).toBe(a);
  });

  it('registers the SAME callback on every connection', () => {
    const a = fakeBridge('a'), b = fakeBridge('b'), c = fakeBridge('c');
    const f = fanoutInbound(a, [a, b, c]);
    const cb = () => {};
    f.onMessage(cb); f.onEdit(cb); f.onMedia(cb);
    for (const br of [a, b, c]) {
      expect(br.registered.onMessage).toEqual([cb]);
      expect(br.registered.onEdit).toEqual([cb]);
      expect(br.registered.onMedia).toEqual([cb]);
    }
  });

  // THE REASON THIS EXISTS: a message on a NON-default connection must reach the spine.
  it('inbound on a non-default connection reaches the handler', () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    const f = fanoutInbound(a, [a, b]);
    const seen = [];
    f.onMessage((m) => seen.push(m));
    b.registered.onMessage[0]({ body: 'e hi', from: { chatId: '!rodz-view' } });
    expect(seen).toEqual([{ body: 'e hi', from: { chatId: '!rodz-view' } }]);
  });

  // OUTBOUND IS UNCHANGED: everything that is not an inbound registration still lands on the
  // default bridge, so every existing call site behaves exactly as before.
  it('outbound still goes to the default connection only', () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    const f = fanoutInbound(a, [a, b]);
    f.send('!chat', 'hola');
    expect(a.sends).toEqual([{ chat: '!chat', text: 'hola' }]);
    expect(b.sends).toEqual([]);
    expect(f.name).toBe('a');
  });

  // THE ECHO GATE. Asked only of the default connection, a reply sent on ANOTHER connection
  // comes back as inbound, the default truthfully says "not mine", and the spine processes its
  // own reply - a loop, on a real account.
  it('wasSentByUs is true when ANY connection sent it', () => {
    const a = fakeBridge('a', { sentByUs: false });
    const b = fakeBridge('b', { sentByUs: true });
    const f = fanoutInbound(a, [a, b]);
    expect(f.wasSentByUs('!chat', 'm1')).toBe(true);
  });

  it('wasSentByUs is false only when NO connection sent it', () => {
    const a = fakeBridge('a', { sentByUs: false });
    const b = fakeBridge('b', { sentByUs: false });
    expect(fanoutInbound(a, [a, b]).wasSentByUs('!chat', 'm1')).toBe(false);
  });

  it('wasSentByUs survives a connection that does not implement it', () => {
    const a = fakeBridge('a', { sentByUs: false });
    const b = { onMessage() {}, onEdit() {}, onMedia() {} };   // no wasSentByUs at all
    expect(fanoutInbound(a, [a, b]).wasSentByUs('!c', 'm')).toBe(false);
  });

  // THE ROSTER QUESTION (operator 2026-09-07). One real group is a DIFFERENT room per account, so
  // the connection a message arrived on is usually the ONLY one that has the chat at all — every
  // other answers UNKNOWN. Asked of the default connection alone, `fallback_handle`'s
  // unless_present read that unknown and stayed silent, and a group only the second account is in
  // got no answer at all (tests/multi-connection-wake.test.mjs).
  it('chatHasParticipant asks EVERY connection — the one that has the chat answers', async () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    a.chatHasParticipant = async () => null;        // An's Desktop has never seen Rodz's room
    b.chatHasParticipant = async () => false;       // Rodz's Desktop has it, and An is not in it
    expect(await fanoutInbound(a, [a, b]).chatHasParticipant('!rodz-only', '+16468217865')).toBe(false);
  });

  // NOT `.some()`, unlike wasSentByUs: true | false | null, and null must stay null. A definite
  // TRUE from any connection wins; a definite FALSE beats an unknown; unknown everywhere is
  // unknown, which is the state the router fails closed on.
  it('chatHasParticipant: any definite TRUE wins, then any definite FALSE, else UNKNOWN', async () => {
    const mk = (v) => ({ ...fakeBridge('x'), chatHasParticipant: async () => v });
    const ask = (...vals) => {
      const bs = vals.map(mk);
      return fanoutInbound(bs[0], bs).chatHasParticipant('!c', '+1');
    };
    expect(await ask(null, true)).toBe(true);
    expect(await ask(false, true)).toBe(true);
    expect(await ask(null, false)).toBe(false);
    expect(await ask(null, null)).toBeNull();
  });

  it('chatHasParticipant: a connection that throws is that ONE connection\'s unknown, not the node\'s', async () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    a.chatHasParticipant = async () => { throw new Error('beeper down'); };
    b.chatHasParticipant = async () => true;
    expect(await fanoutInbound(a, [a, b]).chatHasParticipant('!c', '+1')).toBe(true);
  });

  it('chatHasParticipant survives a connection that does not implement it', async () => {
    const a = fakeBridge('a');
    a.chatHasParticipant = async () => false;
    const b = { onMessage() {}, onEdit() {}, onMedia() {} };   // no chatHasParticipant at all
    expect(await fanoutInbound(a, [a, b]).chatHasParticipant('!c', '+1')).toBe(false);
  });

  it('stop reaches every connection, not just the default', () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    fanoutInbound(a, [a, b]).stop();
    expect(a.stopped).toBe(1);
    expect(b.stopped).toBe(1);
  });

  // OWNERSHIP holds without this module knowing about it: an outbound-only connection silently
  // drops the registration, so `owner_node` still decides who wakes.
  it('a non-owned (outbound-only) connection never receives inbound', () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    const f = fanoutInbound(a, [a, outboundOnly(b)]);
    f.onMessage(() => {});
    expect(a.registered.onMessage).toHaveLength(1);
    expect(b.registered.onMessage).toHaveLength(0);   // the proxy swallowed it
  });

  it('a null connection in the list is skipped rather than thrown on', () => {
    const a = fakeBridge('a'), b = fakeBridge('b');
    const f = fanoutInbound(a, [a, null, b, undefined]);
    f.onMessage(() => {});
    expect(a.registered.onMessage).toHaveLength(1);
    expect(b.registered.onMessage).toHaveLength(1);
  });
});
