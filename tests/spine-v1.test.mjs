// v1 end-to-end pipe (SPINE-REWRITE-PLAN.md §9 "pipe test"): the REAL identity +
// gating + transcript + sender + router services wired through createSpine,
// against a fake Bridge + fake Brain. Asserts, per auto-mode, that gating +
// transcript + delivery all behave — no network, no Claude, no live account.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { emptyState } from '../conversations-state.mjs';

function fakeBridge() {
  let cb = null;
  return {
    sent: [], streams: [],
    onMessage(fn) { cb = fn; },
    emit(m) { return cb(m); },
    send(chat, text) { this.sent.push({ chat, text }); },
    startStream(chat, init) {
      const h = { chat, init, finals: [], delivered: false, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
      this.streams.push(h); return h;
    },
    stop() {},
  };
}
function fakeBrain() {
  return { calls: [], async turn(being, ev, onPartial) { this.calls.push({ being, ev }); onPartial?.(`↩ ${ev.body}`); return { text: `↩ ${ev.body}`, being }; } };
}
function memTranscript() {
  let state = emptyState();
  const files = new Map();
  const io = {
    appendFile: async (p, data) => { files.set(p, (files.get(p) ?? '') + data); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
  };
  const svc = createTranscript({ loadState: async () => state, writeState: async (s) => { state = s; }, io, now: () => new Date(Date.UTC(2026, 5, 29, 14, 5)) });
  return { svc, files };
}

// Build a spine with the real services and a config the test controls.
function harness(config) {
  const bridge = fakeBridge();
  const brain = fakeBrain();
  const { svc: transcript, files } = memTranscript();
  const heartbeats = { runDue() {} };
  const spine = createSpine({
    bridge, brain,
    identity: createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) }),
    gating: createGating({ getConfig: () => config }),
    router: createRouter(),
    sender: createSender({ bridge }),
    transcript, heartbeats,
  });
  spine.start();
  return { bridge, brain, files };
}

const baseFrom = {
  chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
  userId: 'u-1', senderName: 'An', isSender: false, authorized: true, msgKey: 'm1',
};
const msg = ({ body = 'hola', atE = false } = {}) =>
  ({ body, from: { ...baseFrom, atEStart: atE, atEAnywhere: atE, replyToBot: false } });

// the single transcript file's content (slug carries a nondeterministic suffix,
// so assert on content not path).
const onlyFile = (files) => { const v = [...files.values()]; expect(v).toHaveLength(1); return v[0]; };

const cfgWithMode = (mode, extra = {}) => ({ auto_modes: { '!room:beeper.com': { e: mode } }, whatsapp: { ...extra } });

describe('v1 pipe — gated receive → brain → reply → send, per mode', () => {
  it("'on': brain runs, reply stream-edited, inbound + reply both transcribed", async () => {
    const { bridge, brain, files } = harness(cfgWithMode('on'));
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('e');
    expect(bridge.streams[0].finals).toEqual(['↩ hola']);   // delivered via stream-edit
    expect(bridge.sent).toHaveLength(0);                    // no fallback send
    const t = onlyFile(files);
    expect(t).toContain('An@[fam].wa (14:05) #m1: hola');    // inbound dispatch line
    expect(t).toContain('[@e (14:05)]: ↩ hola');             // reply line
  });

  it("'mute': receives + logs inbound, but NO brain, NO send", async () => {
    const { bridge, brain, files } = harness(cfgWithMode('mute'));
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    const t = onlyFile(files);
    expect(t).toContain('An@[fam].wa (14:05) #m1: hola');
    expect(t).not.toContain('[@e');                          // no reply
  });

  it("'off': not received — NOT logged, no brain, no send", async () => {
    const { bridge, brain, files } = harness(cfgWithMode('off'));
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(files.size).toBe(0);   // 'off' is not received at all
  });

  it("send_to_egpt=always in a mute chat: E RUNS for context, reply recorded NOT surfaced, NO send", async () => {
    const { bridge, brain, files } = harness(cfgWithMode('mute', { send_to_egpt: 'always' }));
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(1);              // E ran despite mute
    expect(bridge.sent).toHaveLength(0);              // nothing surfaced
    expect(bridge.streams).toHaveLength(0);           // no train for a non-surfacing turn
    const t = onlyFile(files);
    expect(t).toContain('#m1: hola');                                  // inbound logged
    expect(t).toContain('[@e (14:05)]: (not surfaced) ↩ hola');        // reply recorded, withheld
  });

  it("'mention' without @e: logged, withheld (no brain, no send)", async () => {
    const { bridge, brain, files } = harness(cfgWithMode('mention'));
    await bridge.emit(msg({ body: 'just chatting' }));
    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(onlyFile(files)).toContain('just chatting');
  });

  it("'mention' WITH @e: brain runs, reply delivered", async () => {
    const { bridge, brain, files } = harness(cfgWithMode('mention'));
    await bridge.emit(msg({ body: '@e estas?', atE: true }));
    expect(brain.calls).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['↩ @e estas?']);
    expect(onlyFile(files)).toContain('[@e (14:05)]: ↩ @e estas?');
  });

  it('auto_e_paused: absolute kill — even @e in on-mode is withheld but logged', async () => {
    const { bridge, brain, files } = harness(cfgWithMode('on', { auto_e_paused: true }));
    await bridge.emit(msg({ body: '@e estas?', atE: true }));
    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
    expect(onlyFile(files)).toContain('#m1: @e estas?');
  });
});
