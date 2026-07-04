// Turn-resolution defects + cycle accumulation (operator 2026-07-04, the live
// double-mention acceptance run). Three defects the queued-turn path exposed, plus the
// accumulation feature — each REPRODUCED first (fails on the pre-fix spine), then fixed:
//
//   DEFECT 1  a turn that ends without deliverable text (empty '', or a failure-SHAPED
//             result string), or that THROWS after its placeholder opened, must resolve
//             the placeholder VISIBLY — never a silent delete or a forever "⏳ Thinking…".
//   DEFECT 2  a per-turn TIMEOUT fails the turn visibly, EVICTS the wedged warm entry,
//             and lets the queue drain on.
//   DEFECT 3  E's own reply is RECORDED to the transcript under the new no-await handoff.
//   FEATURE   a QUEUED turn prompts with the accumulated cycle (intervening chatter + E's
//             own replies delivered meanwhile) ending with its own mention line; an
//             IMMEDIATE turn keeps its single dispatch line.
import { describe, it, expect, vi } from 'vitest';
import { createSpine } from '../spine.mjs';
import { createSender } from '../src/spine/sender.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A bridge that (a) drives one inbound message and (b) records the reply streams the REAL
// sender opens on it, so a test can assert the ACTUAL delivered marker text.
function fakeBridge() {
  let cb = null;
  const streams = [], sent = [];
  return {
    streams, sent,
    onMessage(fn) { cb = fn; },
    emit(msg) { return cb(msg); },
    send(chat, text, opts) { sent.push({ chat, text, opts }); },
    startStream(chat, init, opts) {
      const h = {
        chat, init, opts, frames: [], finals: [], deleted: false, delivered: false,
        update(t) { h.frames.push(t); },
        async finish(t) { h.finals.push(t); h.delivered = true; },
        async delete() { h.deleted = true; },
      };
      streams.push(h); return h;
    },
    stop() {},
  };
}

// A sender that records each placeholder + its resolution (finish / fail / activate),
// with an optional finishThrows to simulate a bridge delivery fault AFTER the brain.
function recordingSender({ finishThrows = false } = {}) {
  const placeholders = [];
  return {
    placeholders,
    open(chatId, opts = {}) {
      const ph = { chatId, opts, updates: [], finished: null, failed: null, activated: false };
      placeholders.push(ph);
      return {
        activate() { ph.activated = true; },
        update(p) { ph.updates.push(p); },
        async finish(reply, { surface = true } = {}) {
          if (finishThrows) throw new Error('bridge-finish-boom');
          ph.finished = { text: typeof reply === 'string' ? reply : reply?.text, surface };
        },
        async fail(e) { ph.failed = e?.message ?? String(e); },
      };
    },
  };
}

// A transcript that records every (ev, reply) pair — the recording chokepoint DEFECT 3
// is about.
function recordingTranscript() {
  const entries = [];
  return { entries, async log(ev, reply) { entries.push({ line: ev.line ?? ev.body, reply }); } };
}

// identity passes the raw fields (incl. an explicit `line` + `mention`) through as the
// envelope; the router always resolves E and rides the message's own mention; gating is
// mention-mode (chatter received-but-not-replied; a mention replies; an empty reply still
// surfaces → the no-reply marker).
const fakeIdentity = { build: (m) => ({ ...m, line: m.line ?? m.body }) };
const fakeRouter = { resolve: (ev) => ({ being: 'e', mention: ev.mention }) };
const fakeGating = {
  async decide(_being, _ev, mention) {
    const mentioned = !!(mention?.atEStart || mention?.atEAnywhere || mention?.replyToBot);
    return { mode: 'mention', receives: true, mayReply: mentioned, sendToEgpt: 'mode' };
  },
  surfaces: (d) => !!d.mayReply,   // mention-mode: surfaces iff mayReply (empty still surfaces)
};
const fakeHeartbeats = { runDue() {} };

const CHAT = 'chat-Z@g.us';
const AT = { atEStart: true, atEAnywhere: true, replyToBot: false };
const NOAT = { atEStart: false, atEAnywhere: false, replyToBot: false };
const msg = (body, msgId, mention, line) => ({
  surface: 'wa', node: 'wa', chatId: CHAT, chatName: 'grp', senderId: 'u', senderName: 'An',
  msgId, ts: 1000, body, kind: 'text', mention, line: line ?? body, raw: {},
});
const mention = (body, id, line) => msg(body, id, AT, line);
const chatter = (body, id, line) => msg(body, id, NOAT, line);

function buildSpine(over = {}) {
  const bridge = over.bridge ?? fakeBridge();
  const spine = createSpine({
    bridge,
    brain: over.brain,
    store: over.store,
    identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
    sender: over.sender, transcript: over.transcript ?? recordingTranscript(),
    heartbeats: fakeHeartbeats,
    clock: { now: () => 1000 },
    turnTimeoutMs: over.turnTimeoutMs ?? 600_000,
    log: over.log,
  });
  spine.start();
  return { spine, bridge };
}

describe('spine — DEFECT 1: an empty / failed / thrown turn resolves the placeholder VISIBLY', () => {
  it('brain returns EMPTY text → the no-reply marker is delivered (not a silent delete, not stuck)', async () => {
    const bridge = fakeBridge();
    const notes = [];
    const brain = { async turn() { return { text: '', sessionId: 's0' }; } };
    buildSpine({ bridge, brain, sender: createSender({ bridge }), log: { line: (s) => notes.push(s) } });
    await bridge.emit(mention('@e hola', 'm1'));

    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].deleted).toBe(false);                                  // NOT silently deleted
    expect(bridge.streams[0].finals).toEqual(['⚠️ no reply (turn failed/empty) ∎']);  // VISIBLE marker
    expect(notes.some((n) => /no deliverable text \(empty\)/.test(n))).toBe(true);   // and it's LOUD in the log
  });

  it('brain returns a FAILURE-SHAPED result string → no-reply marker, raw failure recorded UNsurfaced (not delivered raw)', async () => {
    const bridge = fakeBridge();
    const transcript = recordingTranscript();
    const brain = { async turn() { return { text: '!! claude exit 1: boom', sessionId: 's0' }; } };
    buildSpine({ bridge, brain, sender: createSender({ bridge }), transcript });
    await bridge.emit(mention('@e hola', 'm1'));

    expect(bridge.streams[0].finals).toEqual(['⚠️ no reply (turn failed/empty) ∎']);   // NOT '!! claude exit… ∎'
    const rec = transcript.entries.find((e) => e.reply);
    expect(rec.reply.text).toBe('!! claude exit 1: boom');                             // raw failure preserved
    expect(rec.reply.surfaced).toBe(false);                                            // recorded, not surfaced
  });

  it('a THROW after the placeholder opened (delivery fault) → placeholder fails visibly AND the reply is still recorded', async () => {
    const sender = recordingSender({ finishThrows: true });
    const transcript = recordingTranscript();
    const brain = { async turn() { return { text: 'the answer', sessionId: 's0' }; } };
    const { bridge } = buildSpine({ brain, sender, transcript });
    await bridge.emit(mention('@e hola', 'm1'));

    expect(sender.placeholders[0].failed).toMatch(/bridge-finish-boom/);   // placeholder resolved VISIBLY (not stuck)
    const rec = transcript.entries.find((e) => e.reply);
    expect(rec.reply.text).toBe('the answer');                             // recorded BEFORE the faulting delivery
    expect(rec.reply.surfaced).toBe(true);
  });
});

describe('spine — DEFECT 2: per-turn timeout fails visibly, evicts the warm entry, queue drains on', () => {
  it('a hung turn times out → marker + brain.evict(convKey) + the queued turn still delivers', async () => {
    const evicted = [];
    const brain = {
      calls: 0,
      evict(being, ev) { evicted.push(`${being}:${ev.surface}:${ev.chatId}`); },
      async turn(being, ev) {
        const i = brain.calls++;
        if (i === 0) return new Promise(() => {});         // turn 1 HANGS forever
        return { text: `reply-${ev.body}`, sessionId: `s${i}` };
      },
    };
    const sender = recordingSender();
    const { bridge } = buildSpine({ brain, sender, turnTimeoutMs: 30 });
    const p1 = bridge.emit(mention('one', 'm1'));
    const p2 = bridge.emit(mention('two', 'm2'));
    await Promise.all([p1, p2]);

    expect(evicted).toEqual([`e:wa:${CHAT}`]);                             // the wedged entry was evicted
    expect(sender.placeholders[0].failed).toMatch(/timeout/i);            // turn 1 failed visibly
    expect(sender.placeholders[1].finished.text).toBe('reply-two');       // the queue drained on
  });
});

describe('spine — DEFECT 3: E\'s own reply is recorded under the new handoff', () => {
  it('a normal reply lands as an (ev, reply) transcript entry with surfaced:true', async () => {
    const transcript = recordingTranscript();
    const brain = { async turn() { return { text: 'hola de vuelta', sessionId: 's0' }; } };
    const { bridge } = buildSpine({ brain, sender: recordingSender(), transcript });
    await bridge.emit(mention('@e hola', 'm1'));

    const rec = transcript.entries.find((e) => e.reply);
    expect(rec).toBeTruthy();
    expect(rec.reply.text).toBe('hola de vuelta');
    expect(rec.reply.surfaced).toBe(true);
  });
});

describe('spine — FEATURE: a queued turn prompts with the accumulated cycle', () => {
  it('turn 2 (queued) sees turn-1 reply + chatter, ending with its own mention; turn 1 (immediate) stays single-line', async () => {
    // Gate turn 1 at the brain (so turn 2 QUEUES), then gate turn 1's tail at store.recordThread
    // (which runs AFTER E's reply is pushed to the cycle but BEFORE turn 2 drains) so we can slot
    // the chatter in deterministically: cycle becomes [reply-one, chatter] before turn 2 drains.
    let releaseBrain; const brainGate = new Promise((r) => { releaseBrain = r; });
    let releaseTail; const tailGate = new Promise((r) => { releaseTail = r; });
    const brain = {
      calls: [],
      async turn(being, ev) {
        const i = brain.calls.length;
        brain.calls.push({ line: ev.line, body: ev.body });
        if (i === 0) await brainGate;
        return { text: i === 0 ? 'reply-one' : `reply-${ev.body}`, sessionId: `s${i}` };
      },
    };
    const store = { n: 0, async recordThread() { if (this.n++ === 0) await tailGate; } };

    const M1 = 'An@[grp].wa (00:00) #m1: @e uno';
    const M2 = 'An@[grp].wa (00:01) #m2: @e dos';
    const C  = 'Bob@[grp].wa (00:02) #m3: solo chchat';
    const { bridge } = buildSpine({ brain, store, sender: recordingSender() });

    const p1 = bridge.emit(mention('uno', 'm1', M1));   // turn 1 → immediate, holds at brain
    const p2 = bridge.emit(mention('dos', 'm2', M2));   // turn 2 → QUEUED behind it
    await flush();

    releaseBrain();          // turn 1's reply comes → pushed to cycle, then turn 1 pauses at its tail
    await flush();
    await bridge.emit(chatter('solo chchat', 'm3', C));  // arrives mid-wait → joins the cycle
    await flush();
    releaseTail();           // turn 1 finishes → turn 2 drains [reply-one, chatter] and runs
    await Promise.all([p1, p2]);

    // turn 1 ran immediately → its lone dispatch line, no accumulation.
    expect(brain.calls[0].line).toBe(M1);

    // turn 2's prompt = one coherent block: E's own reply, the chatter, ending with its mention.
    const prompt = brain.calls[1].line;
    const parts = prompt.split('\n\n');
    expect(parts[parts.length - 1]).toBe(M2);                         // ends with its own mention
    expect(parts.some((p) => /^\[@e .*reply-one/.test(p))).toBe(true); // E's own past reply, as a line
    expect(parts).toContain(C);                                        // the intervening chatter
    // order: reply-one before chatter before the mention
    const iReply = parts.findIndex((p) => /reply-one/.test(p));
    const iChat = parts.indexOf(C);
    const iMention = parts.indexOf(M2);
    expect(iReply).toBeLessThan(iChat);
    expect(iChat).toBeLessThan(iMention);
  });
});
