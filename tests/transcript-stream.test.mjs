// tests/transcript-stream.test.mjs — THE RAW BYTE TRAIN ON THE RECORD (operator 2026-08-27).
//
// "There is some funky-business happening in the thinking train of E. The interim thoughts
// are being replaced by the final answer. Sometimes it is writing something and then boom,
// it changes, and the previous output is not even getting transcribed."
//
// 372c17f stopped transcribing streaming frames for a real, measured reason (13,958 lines /
// 1.3 MB of `edited #<id>` blocks, each carrying the full before AND after text). The ruling
// that replaces it splits the job by WHO IS SPEAKING:
//
//   1. The EMITTING node logs every byte the model emits, in order, verbatim. It is running
//      the CLI, so there is nothing to reconstruct — and a reply of N bytes costs N bytes,
//      not five snapshots of it.
//   2. An OBSERVING node logs only the INCREMENTS, never the deletions. A peer only ever
//      hands it message EDITS (before/after), so what was ADDED must be derived.
//
// Both land IN transcript.md (operator 2026-08-27: "whatever reply is emitted by model (the
// bytes) gets written into the transcript (aka logged)"). Not a sidecar: the record a human
// reads and a being is prompted with is exactly the thing the interim content was vanishing
// from. The train is its own `(streaming)` block; the settled reply still lands as its own
// line below it, and nothing already written is ever removed, rewritten or de-duplicated.
import { describe, it, expect } from 'vitest';
import { streamIncrement, liveFrameIncrement, editAction, LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { Room } from '../src/room-core.mjs';
import { emptyState, ensureContact } from '../src/conversations-state.mjs';

const settle = () => new Promise((r) => setTimeout(r, 25));
const fakeContacts = { resolve: async () => 'fam-1234567890' };
const mkIo = (files) => ({
  appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
  mkdir: async () => {},
  existsSync: (p) => files.has(p),
  readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
  writeFile: async (p, d) => { files.set(p, d); },
  readdir: async () => [],
});
const fileEndingIn = (files, suffix) => [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1] ?? '';

// ── the ONE derivation both halves share ────────────────────────────────────────────────
describe('streamIncrement — what was ADDED, never what was removed', () => {
  it('a pure append yields exactly the appended bytes', () => {
    expect(streamIncrement('Buen lugar', 'Buen lugar random')).toBe(' random');
    expect(streamIncrement('', 'Hola')).toBe('Hola');
    expect(streamIncrement('same', 'same')).toBe('');
  });

  it('a SIGNED frame is not a prefix-extension — the common suffix is discovered, not named', () => {
    // The live shape as of cd96edc: the bridge signature wraps the core, and the live marker
    // sits at the end of it. `after` therefore never startsWith `before` on a real node — a
    // prefix-only guard would return the whole wrapped text every frame and re-create the
    // 1.3 MB flood. No signature format appears in the code that makes this pass.
    const wrap = (core) => `🌉kg ${core} ⏳ 🌉`;
    // The common prefix runs to "para " and the common suffix is " ⏳ 🌉", so what comes back
    // is the added word — which concatenates straight onto what is already on the record.
    expect(streamIncrement(wrap('Buen lugar random para'), wrap('Buen lugar random para verla'))).toBe('verla ');
    const dolly = (core) => `💸do ${core} ⏳ 💸`;
    expect(streamIncrement(dolly('Buen lugar'), dolly('Buen lugar random'))).toBe('random ');
  });

  it('a DIVERGENCE is returned whole (logged, never dropped) and opens on its own line', () => {
    // The reported bug: the accumulated text is REPLACED, not extended (codex-cli-session's
    // item/completed does `currentTurn.text = item.text`; warm-cli resolves with `result`).
    const inc = streamIncrement('Let me check the config first', 'The answer is 42.');
    expect(inc).toBe('\nThe answer is 42.');
    expect(inc).toContain('The answer is 42.');          // logged
    expect(inc).not.toContain('Let me check');           // and the earlier text is NOT re-emitted
  });

  it('a shrink adds nothing — a deletion is not an increment', () => {
    expect(streamIncrement('Buen lugar random', 'Buen lugar')).toBe('');
    expect(streamIncrement('anything', '')).toBe('');
  });

  it('never cuts a surrogate pair in half', () => {
    // Two different emoji share a high surrogate (🌉 U+1F309 / 🌀 U+1F300 are both D83C …),
    // so a naive code-unit boundary can emit a lone surrogate into the record.
    const inc = streamIncrement('tag 🌀 end', 'tag 🌉 end');
    expect(inc).toBe('🌉');
    expect([...inc].length).toBe(1);                     // one CODE POINT, not a broken half
  });
});

describe('liveFrameIncrement — derived from an edit stage-direction, `-` side never returned', () => {
  const frame = (o, n) => editAction({ targetId: '176209', oldText: o, newText: n });

  it('returns only the text the frame added', () => {
    const body = frame(`🤝 don Buen lugar random para ${LIVE_FRAME_MARK}`, `🤝 don Buen lugar random para verla — ¿la disfrutaste ${LIVE_FRAME_MARK}`);
    expect(liveFrameIncrement(body)).toBe('verla — ¿la disfrutaste ');
  });

  it('reads the signed shape too (the marker is not at the end of a real frame)', () => {
    const wrap = (core) => `🌉kg\n🤝 don\n${core} ${LIVE_FRAME_MARK}\n🌉`;
    const body = frame(wrap('Buen lugar random para'), wrap('Buen lugar random para verla'));
    expect(liveFrameIncrement(body)).toBe('verla ');
  });

  it('a non-edit body yields nothing', () => {
    expect(liveFrameIncrement('reacted 👍 to #7 "hola"')).toBe('');
    expect(liveFrameIncrement(null)).toBe('');
  });

  // THE COST CHECK, over a whole wrapped stream: every character of the reply reaches the
  // record exactly once, and the whole sequence costs about what the reply costs — not the
  // 5×-per-reply snapshots that made the SPOILER transcript 1.3 MB.
  //
  // Whitespace can DISPLACE by one token (the prefix swallows a content space that coincides
  // with the wrapper's separator space) — asserted here so nobody "fixes" it by computing the
  // suffix first, which over-matches into the content and reconstructs WRONG.
  it('a 10-frame signed stream: every character once, at the cost of the reply itself', () => {
    const wrap = (core) => `🌉kg\n🤝 don\n${core} ${LIVE_FRAME_MARK}\n🌉`;
    const full = 'Buen lugar random para verla — ¿la disfrutaste?';
    let prev = wrap(`${LIVE_FRAME_MARK} Thinking…`), log = '', snapshotBytes = 0;
    for (let i = 1; i <= 10; i++) {
      const next = wrap(full.slice(0, Math.round((full.length * i) / 10)));
      const body = editAction({ targetId: '176209', oldText: prev, newText: next });
      log += liveFrameIncrement(body);
      snapshotBytes += body.length;                      // what the pre-372c17f record cost
      prev = next;
    }
    const squash = (s) => s.replace(/\s+/g, '');
    expect(squash(log)).toBe(squash(full));              // every character, once, in order
    expect(log.length).toBeLessThan(full.length + 8);    // the reply's own size, not a multiple of it
    expect(snapshotBytes).toBeGreaterThan(10 * log.length);
  });
});

// ── THE OBSERVING HALF ──────────────────────────────────────────────────────────────────
describe('transcript.log — an observing node logs a peer frame INCREMENT, never the deletion', () => {
  const identity = createIdentity({ now: () => Date.UTC(2026, 6, 25, 19, 10) });
  const peer = {
    chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
    userId: 'u1', senderName: 'An', isStageDirection: true, msgKey: '176209',
  };
  const editEv = (targetId, oldText, newText, from = peer) =>
    identity.build({ body: editAction({ targetId, oldText, newText }), from: { ...from, msgKey: targetId } });

  it('a stream sequence: the transcript gains the added text ONLY, and the settle under it', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files), now: () => new Date(Date.UTC(2026, 6, 25, 19, 10)) });

    const frames = [
      `🤝 don Buen lugar random para ${LIVE_FRAME_MARK}`,
      `🤝 don Buen lugar random para verla — ¿la disfrutaste o se sint ${LIVE_FRAME_MARK}`,
    ];
    let prev = `🤝 don ${LIVE_FRAME_MARK} Thinking…`;
    for (const f of frames) { await t.log(editEv('176209', prev, f)); prev = f; }
    const settled = '🤝 don Buen lugar random para verla — ¿la disfrutaste o se sintió como fan service?';
    await t.log(editEv('176209', prev, settled));
    await settle();

    const text = fileEndingIn(files, 'transcript.md');

    // the INCREMENTS are on the record, in order, and they concatenate back into the reply
    expect(text).toContain('Buen lugar random para ');
    expect(text).toContain('verla — ¿la disfrutaste o se sint ');
    // ANTI-FLOOD LOCK (372c17f): no full before/after snapshot PAIR from a live frame. Exactly
    // ONE `edited #` block lands — the settle — and the early text is written once, not once
    // per frame with its predecessor beside it.
    expect(text.match(/edited #\d+/g)).toEqual(['edited #176209']);
    // Once streamed, plus the settle block's own two sides. KNOWN RESIDUE, deliberately not
    // asserted away and unchanged by this chunk: the settle's `-` side is the LAST PARTIAL
    // because the diff baseline (the bridge's per-message _seenText, src/bridges/beeper.mjs)
    // advances on every frame. 372c17f flagged it; it is two lines in a file this chunk does
    // not own. What IS locked here is that NO FRAME writes a pair — 2 frames, 0 blocks.
    expect(text.split('Buen lugar random para').length - 1).toBe(3);
    expect(text).not.toContain(`Buen lugar random para ${LIVE_FRAME_MARK}`);   // no frame block, as since 372c17f
    // the SETTLE is still the record, in its own block under the train
    expect(text).toContain('se sintió como fan service?');
    expect(text.indexOf('verla — ¿la disfrutaste o se sint ')).toBeLessThan(text.indexOf('edited #176209'));
  });

  it('a signed frame streams its increment too — and still writes no frame block', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files), now: () => new Date(Date.UTC(2026, 6, 25, 19, 10)) });
    const wrap = (core) => `🌉kg\n🤝 don\n${core}\n🌉`;
    const placeholder = wrap(`${LIVE_FRAME_MARK} Thinking…`);
    const frames = [wrap(`Buen lugar random para ${LIVE_FRAME_MARK}`), wrap(`Buen lugar random para verla ${LIVE_FRAME_MARK}`)];

    let prev = placeholder;
    for (const f of frames) { await t.log(editEv('176209', prev, f)); prev = f; }
    await settle();

    const text = fileEndingIn(files, 'transcript.md');
    expect(text).toContain('verla');
    expect(text.split('Buen lugar random para').length - 1).toBe(1);   // added once, not re-snapshotted
    expect(text).not.toContain('edited #');                            // no frame is an entry
    expect(text).not.toContain('    - ');                              // and no deletion is ever written
  });

  it('a stream frame is still not a received message — returns false, no stats side-effect', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    expect(await t.log(editEv('176209', `🤝 don ${LIVE_FRAME_MARK} Thinking…`, `🤝 don Buen lugar ${LIVE_FRAME_MARK}`))).toBe(false);
    await settle();
    expect([...files.keys()].some((p) => p.endsWith('.yaml'))).toBe(false);
  });

  it('the bytes land EXACTLY at Room.forChat(surface, slug).transcriptPath — no second file', async () => {
    const files = new Map();
    const t = createTranscript({ contacts: fakeContacts, io: mkIo(files) });
    await t.logStream({ surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'fam' }, '', 'hola');
    expect([...files.keys()]).toEqual([Room.forChat('whatsapp', 'fam-1234567890').transcriptPath]);
  });
});

// ── THE EMITTING HALF (the reported bug) ────────────────────────────────────────────────
// This node runs the CLI, so it receives the model's own token stream. Before this change the
// ONLY thing that reached the record was `reply.text` — the FINAL answer — so every interim
// thought a later frame replaced was gone from the file entirely.
describe('spine — the emitting node records every byte the model emitted, in order', () => {
  function harness(brain) {
    let state = emptyState();
    const ens = ensureContact(state, 'whatsapp', '!room:beeper.com', { pushedName: 'fam', slugHint: 'fam' });
    state = ens.state;
    state.contacts.whatsapp['!room:beeper.com'].agents = { e: { mode: 'on' } };
    const loadState = async () => state;
    const writeState = async (s) => { state = s; };
    const files = new Map();
    const statsFiles = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      rename: async () => {},
      readFile: async (p) => { if (!statsFiles.has(p)) throw new Error('ENOENT'); return statsFiles.get(p); },
      writeFile: async (p, d) => { statsFiles.set(p, d); },
      readdir: async () => [],
    };
    const contacts = createContacts({ loadState, writeState, io });
    const transcript = createTranscript({ contacts, io, now: () => new Date(Date.UTC(2026, 5, 29, 14, 5)) });
    let cb = null;
    const bridge = {
      onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, send() {}, stop() {},
      startStream() { return { update() {}, async finish() { this.delivered = true; }, delivered: false }; },
    };
    const spine = createSpine({
      bridge, brain,
      identity: createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) }),
      gating: createGating({ getConfig: () => ({}), loadState }),
      router: createRouter(), sender: createSender({ bridge }),
      transcript, heartbeats: { runDue() {} },
    });
    spine.start();
    return { bridge, files };
  }
  const msg = (body = 'hola') => ({
    body,
    from: { chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', isSender: false, authorized: true, msgKey: 'm1', atEStart: false, atEAnywhere: false, replyToBot: false },
  });

  it('interim text that a later frame REPLACES is on the record (the reported bug)', async () => {
    // The live shape: the CLI narrates while it works, then the turn resolves with a final
    // answer that is NOT an extension of the narration ("boom, it changes").
    const brain = {
      async turn(being, ev, onPartial) {
        onPartial('Let me look at the config');
        onPartial('Let me look at the config file first…');
        onPartial('42 is the answer.');                 // the accumulated text is REPLACED
        return { text: '42 is the answer.', being };
      },
    };
    const { bridge, files } = harness(brain);
    await bridge.emit(msg());
    await settle();

    const text = fileEndingIn(files, 'transcript.md');
    expect(text).toContain('Let me look at the config file first…');   // the interim thought SURVIVES
    expect(text).toContain('42 is the answer.');                       // and so does what replaced it
    expect(text.indexOf('Let me look')).toBeLessThan(text.indexOf('42 is the answer.'));   // in order
    expect(text).toContain('[@e (14:05)]: (streaming) ');              // the train, opened as its own block
    // The token stream is written ONCE — the appended tail only, never a re-snapshot.
    expect(text.split('Let me look at the config').length - 1).toBe(1);
    // …and the SETTLED reply still lands as its own line under it, exactly as before.
    expect(text).toContain('\n\n[@e (14:05)]: 42 is the answer.\n\n');
    expect(text.indexOf('(streaming)')).toBeLessThan(text.indexOf('[@e (14:05)]: 42 is the answer.'));
  });

  it('the train is a SEPARATE block — the inbound line, the train and the reply are three entries', async () => {
    const brain = {
      async turn(being, ev, onPartial) { onPartial('pensando'); onPartial('pensando… listo'); return { text: 'listo', being }; },
    };
    const { bridge, files } = harness(brain);
    await bridge.emit(msg());
    await settle();
    const blocks = fileEndingIn(files, 'transcript.md').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    expect(blocks.slice(-3)).toEqual([
      'An@[fam].wa (14:05) #m1: hola',
      '[@e (14:05)]: (streaming) pensando… listo',
      '[@e (14:05)]: listo',
    ]);
  });

  it('the raw model bytes are logged — action lines included, before partialProse strips them', async () => {
    // partialProse withholds action tokens from the CHAT (they would render and vanish). The
    // RECORD is not the chat: "whatever the model says, whatever it is, gets logged".
    const brain = {
      async turn(being, ev, onPartial) {
        onPartial('/react 👍 #m1\nlisto');
        return { text: 'listo', being };
      },
    };
    const { bridge, files } = harness(brain);
    await bridge.emit(msg());
    await settle();
    expect(fileEndingIn(files, 'transcript.md')).toContain('/react 👍 #m1');
  });

  it('a turn that never streams writes no train block — the file is what it always was', async () => {
    const brain = { async turn(being) { return { text: 'ok', being }; } };
    const { bridge, files } = harness(brain);
    await bridge.emit(msg());
    await settle();
    const text = fileEndingIn(files, 'transcript.md');
    expect(text).not.toContain('(streaming)');
    expect(text).toContain('[@e (14:05)]: ok');
  });
});
