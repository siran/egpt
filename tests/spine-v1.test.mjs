// v1 end-to-end pipe (plans/2606291226-SPINE-REWRITE-PLAN.md §9 "pipe test"): the REAL identity +
// gating + transcript + sender + router services wired through createSpine,
// against a fake Bridge + fake Brain. Asserts, per auto-mode, that gating +
// transcript + delivery all behave — no network, no Claude, no live account.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { emptyState, ensureContact } from '../conversations-state.mjs';

function fakeBridge() {
  let cb = null;
  return {
    sent: [], streams: [],
    onMessage(fn) { cb = fn; },
    emit(m) { return cb(m); },
    send(chat, text) { this.sent.push({ chat, text }); },
    startStream(chat, init, tag) {
      const h = { chat, init, tag, finals: [], delivered: false, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
      this.streams.push(h); return h;
    },
    stop() {},
  };
}
function fakeBrain() {
  return { calls: [], async turn(being, ev, onPartial) { this.calls.push({ being, ev }); onPartial?.(`↩ ${ev.body}`); return { text: `↩ ${ev.body}`, being }; } };
}
// Build a spine with the real services. ONE in-memory conv-state is shared by
// transcript + gating; the room's E `mode` is pre-seeded there (modes now live in
// conversations.yaml, not config). `config` carries only the globals (auto_e_paused,
// send_to_egpt default, …).
function harness(config = {}, mode) {
  let state = emptyState();
  if (mode !== undefined) {
    const ens = ensureContact(state, 'whatsapp', '!room:beeper.com', { pushedName: 'fam', slugHint: 'fam' });
    state = ens.state;
    if (mode) state.contacts.whatsapp['!room:beeper.com'].mode = mode;   // '' → leave default
  }
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };

  const files = new Map();
  const renames = [];
  // stats collector (recordMemberStat) reads/writes go to their own in-memory map, kept
  // separate from `files` (transcript appendFile output) so it doesn't touch real fs and
  // doesn't perturb the onlyFile() assertions below, which count transcript-only entries.
  const statsFiles = new Map();
  const io = {
    appendFile: async (p, data) => { files.set(p, (files.get(p) ?? '') + data); },
    mkdir: async () => {},
    existsSync: (p) => files.has(p),
    rename: async (from, to) => { renames.push({ from, to }); },
    readFile: async (p) => { if (!statsFiles.has(p)) throw new Error('ENOENT'); return statsFiles.get(p); },
    writeFile: async (p, d) => { statsFiles.set(p, d); },
    // resolveStatFilename (inside recordMemberStat) scans the surface dir by body id; virtualize
    // readdir over statsFiles so it never falls back to the REAL fs. Lists the basenames of the
    // stats-map keys directly under `dir` (paths normalized so Windows backslashes match).
    readdir: async (dir) => {
      const norm = (p) => String(p).replace(/\\/g, '/');
      const prefix = norm(dir).replace(/\/$/, '') + '/';
      const out = new Set();
      for (const k of statsFiles.keys()) {
        const nk = norm(k);
        if (nk.startsWith(prefix)) { const rest = nk.slice(prefix.length); if (!rest.includes('/')) out.add(rest); }
      }
      return [...out];
    },
  };
  const contacts = createContacts({ loadState, writeState, io });
  const transcript = createTranscript({ contacts, io, now: () => new Date(Date.UTC(2026, 5, 29, 14, 5)) });

  const bridge = fakeBridge();
  const brain = fakeBrain();
  const spine = createSpine({
    bridge, brain,
    identity: createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) }),
    gating: createGating({ getConfig: () => config, loadState }),
    router: createRouter(),
    sender: createSender({ bridge }),
    transcript, heartbeats: { runDue() {} },
  });
  spine.start();
  return { bridge, brain, files, renames };
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

describe('v1 pipe — gated receive → brain → reply → send, per mode', () => {
  it("'on': brain runs, reply stream-edited, inbound + reply both transcribed", async () => {
    const { bridge, brain, files } = harness({}, 'on');
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('e');
    expect(bridge.streams[0].finals).toEqual(['↩ hola ∎']);   // delivered via stream-edit, ends with ∎
    expect(bridge.sent).toHaveLength(0);                      // no fallback send
    const t = onlyFile(files);
    expect(t).toContain('An@[fam].wa (14:05) #m1: hola');    // inbound dispatch line
    expect(t).toContain('[@e (14:05)]: ↩ hola');             // reply line
  });

  it("'mute': receives + logs inbound, but NO brain, NO send", async () => {
    const { bridge, brain, files } = harness({}, 'mute');
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    const t = onlyFile(files);
    expect(t).toContain('An@[fam].wa (14:05) #m1: hola');
    expect(t).not.toContain('[@e');                          // no reply
  });

  it("'off': not received — NOT logged, no brain, no send", async () => {
    const { bridge, brain, files } = harness({}, 'off');
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(files.size).toBe(0);   // 'off' is not received at all
  });

  it("send_to_egpt=always in a mute chat: E RUNS for context, reply recorded NOT surfaced, NO send", async () => {
    const { bridge, brain, files } = harness({ whatsapp: { send_to_egpt: 'always' } }, 'mute');
    await bridge.emit(msg());
    expect(brain.calls).toHaveLength(1);              // E ran despite mute
    expect(bridge.sent).toHaveLength(0);              // nothing surfaced
    expect(bridge.streams).toHaveLength(0);           // no train for a non-surfacing turn
    const t = onlyFile(files);
    expect(t).toContain('#m1: hola');                                  // inbound logged
    expect(t).toContain('[@e (14:05)]: (not surfaced) ↩ hola');        // reply recorded, withheld
  });

  it("'mention' without @e: logged, withheld (no brain, no send)", async () => {
    const { bridge, brain, files } = harness({}, 'mention');
    await bridge.emit(msg({ body: 'just chatting' }));
    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(onlyFile(files)).toContain('just chatting');
  });

  it("'mention' WITH @e: brain runs, reply delivered", async () => {
    const { bridge, brain, files } = harness({}, 'mention');
    await bridge.emit(msg({ body: '@e estas?', atE: true }));
    expect(brain.calls).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['↩ @e estas? ∎']);
    expect(onlyFile(files)).toContain('[@e (14:05)]: ↩ @e estas?');   // transcript has no ∎ — that's a chat-only marker
  });

  it("legacy 'accum': stored mode degrades to mention — received + logged, withheld without @e", async () => {
    // A live node may still carry `mode: accum` in conversations.yaml. accum is
    // retired (operator 2026-07-01): isAutoMode('accum') is false, so decide()'s
    // `isAutoMode(bv?.mode) ? bv.mode : defaultMode(...)` falls through to the E
    // default ('mention'). So a legacy accum chat behaves EXACTLY as a mention
    // chat: it receives (logged), but a non-@e burst is withheld.
    const { bridge, brain, files } = harness({}, 'accum');
    await bridge.emit(msg({ body: 'just chatting' }));
    expect(brain.calls).toHaveLength(0);                 // mention gate closed → no brain
    expect(bridge.sent).toHaveLength(0);
    expect(onlyFile(files)).toContain('just chatting');  // still received + logged (not 'off')
  });

  it("legacy 'accum' WITH @e: mention gate opens — brain runs, reply delivered", async () => {
    const { bridge, brain, files } = harness({}, 'accum');
    await bridge.emit(msg({ body: '@e estas?', atE: true }));
    expect(brain.calls).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['↩ @e estas? ∎']);
    expect(onlyFile(files)).toContain('[@e (14:05)]: ↩ @e estas?');
  });

  it('auto_e_paused: absolute kill — even @e in on-mode is withheld but logged', async () => {
    const { bridge, brain, files } = harness({ whatsapp: { auto_e_paused: true } }, 'on');
    await bridge.emit(msg({ body: '@e estas?', atE: true }));
    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
    expect(onlyFile(files)).toContain('#m1: @e estas?');
  });

  it('a plain message with no @sibling still routes to e', async () => {
    const { bridge, brain } = harness({}, 'on');
    await bridge.emit(msg({ body: 'hola' }));
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('e');
  });

  it('a renamed chat: transcript continues in the NEW slug dir, old dir moved via the injected io', async () => {
    // The contact was registered as 'fam'; a message now arrives with the chat
    // retitled 'crew'. The shared resolver re-slugs on the title change, moves the
    // folder old→new (io.rename), and the turn's transcript lands under the new slug.
    const { bridge, files, renames } = harness({}, 'on');
    await bridge.emit({ body: 'hola', from: { ...baseFrom, chatName: 'crew', atEStart: false, atEAnywhere: false, replyToBot: false } });

    expect(renames).toHaveLength(1);
    expect(renames[0].from).toMatch(/whatsapp[\\/]fam-\d{10}$/);
    expect(renames[0].to).toMatch(/whatsapp[\\/]crew-\d{10}$/);

    const paths = [...files.keys()];
    const transcriptPath = paths.find((p) => /transcript\.md$/.test(p));
    expect(transcriptPath).toMatch(/crew-\d{10}[\\/]transcript\.md$/);   // lands in the NEW dir
    expect(paths.some((p) => /fam-\d{10}[\\/]transcript\.md$/.test(p))).toBe(false);  // nothing left in the old dir
    expect(files.get(transcriptPath)).toContain('An@[crew].wa (14:05) #m1: hola');
  });
});

// A full-pipe sibling case through the REAL router + gating + transcript + sender
// (with body_emoji/label), a fake Bridge + fake Brain. Self-contained harness so
// the E-mode harness above stays untouched: it seeds an optional E mode AND an
// optional nested sibling mode, and wires config.agents into router + sender.
function siblingHarness(config = {}, { eMode, wrenMode } = {}) {
  let state = emptyState();
  const ens = ensureContact(state, 'whatsapp', '!room:beeper.com', { pushedName: 'fam', slugHint: 'fam' });
  state = ens.state;
  const entry = state.contacts.whatsapp['!room:beeper.com'];
  if (eMode) entry.mode = eMode;
  if (wrenMode) entry.wren = { mode: wrenMode };   // a nested resident-being block
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };

  const files = new Map();
  // see harness() above: stats collector reads/writes go to their own in-memory map, kept
  // separate from `files` so it doesn't touch real fs and doesn't perturb onlyFile().
  const statsFiles = new Map();
  const io = {
    appendFile: async (p, data) => { files.set(p, (files.get(p) ?? '') + data); },
    mkdir: async () => {}, existsSync: (p) => files.has(p), rename: async () => {},
    readFile: async (p) => { if (!statsFiles.has(p)) throw new Error('ENOENT'); return statsFiles.get(p); },
    writeFile: async (p, d) => { statsFiles.set(p, d); },
  };
  const contacts = createContacts({ loadState, writeState, io });
  const transcript = createTranscript({ contacts, io, now: () => new Date(Date.UTC(2026, 5, 29, 14, 5)) });
  const bodyEmojiOf = (b) => (b === 'e' ? '🐶' : config.agents?.[b]?.body_emoji ?? null);
  const labelOf = (b) => (b === 'e' ? 'egpt' : config.agents?.[b]?.name ?? b);

  const bridge = fakeBridge();
  const brain = fakeBrain();
  const spine = createSpine({
    bridge, brain,
    identity: createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) }),
    gating: createGating({ getConfig: () => config, loadState }),
    router: createRouter({ getAgents: () => config.agents ?? {} }),
    sender: createSender({ bridge, bodyEmojiOf, labelOf }),
    transcript, heartbeats: { runDue() {} },
  });
  spine.start();
  return { bridge, brain, files };
}

describe('v1 pipe — local agent routing (@wren)', () => {
  const cfg = { agents: { wren: { configuration: 'sonnet-high', name: 'wren', body_emoji: '🐦' } } };

  it("'@wren do X': brain.turn(being=wren), reply delivered with wren's emoji+label, transcript line [@wren …]", async () => {
    const { bridge, brain, files } = siblingHarness(cfg);
    await bridge.emit(msg({ body: '@wren do X' }));
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('wren');
    // delivered via the reply train, tagged with wren's body_emoji + label
    expect(bridge.streams[0].finals).toEqual(['↩ @wren do X ∎']);
    expect(bridge.streams[0].tag).toMatchObject({ bodyEmoji: '🐦', label: 'wren' });
    // reply-to quote fires (the sibling is mentioned by its own @name)
    expect(bridge.streams[0].tag.replyTo).toBe('m1');
    expect(onlyFile(files)).toContain('[@wren (14:05)]: ↩ @wren do X');
  });

  it('a plain message still routes to e (not the sibling)', async () => {
    const { bridge, brain } = siblingHarness(cfg, { eMode: 'on' });
    await bridge.emit(msg({ body: 'hola' }));
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('e');
  });

  it('a muted sibling stays silent: @wren received + logged, but NO brain, NO send', async () => {
    const { bridge, brain, files } = siblingHarness(cfg, { wrenMode: 'mute' });
    await bridge.emit(msg({ body: '@wren do X' }));
    expect(brain.calls).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    const t = onlyFile(files);
    expect(t).toContain('#m1: @wren do X');   // inbound still logged
    expect(t).not.toContain('[@wren');        // …but no reply line
  });
});
