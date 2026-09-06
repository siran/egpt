// THE DEFERRED STAND-DOWN (chunk 1b of plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md).
//
// /restart, /upgrade and /rewind exit IMMEDIATELY. /standdown must not. The operator's ruling:
// "the departing spine finishes the turn it is writing, then stands down. The arriving spine
// says only THAT, never WHEN." The failure this prevents was observed live on 2026-09-05 — a
// spine dying mid-reply leaves the other end of the chat reading `interrupted — the link to the
// spine writing this reply dropped` — and a logon must not reproduce it for every conversation.
//
// So the token sets a PENDING state at the spine's ONE inbound chokepoint (handleFast): stop
// admitting new turns, let the ones in flight finish, and only then exit. These four tests are
// the ones that justify the chunk.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSpine } from '../src/spine/spine.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

// Same fakes as tests/spine-turn-queue.test.mjs (the per-conversation queue suite) — a bridge
// whose emit() drives one inbound message, a sender that records every placeholder, and a brain
// whose FIRST turn is held open so "a turn in flight" is a state the test can stand in.
function fakeBridge() {
  let cb = null;
  return { onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, send() {}, stop() {} };
}
function recordingSender() {
  const placeholders = [];
  return {
    placeholders,
    open(chatId, opts = {}) {
      const ph = { chatId, opts, updates: [], finished: null };
      placeholders.push(ph);
      return {
        activate() {}, update(p) { ph.updates.push(p); },
        async finish(reply) { ph.finished = typeof reply === 'string' ? reply : reply?.text; },
        async fail() {},
      };
    },
  };
}
function gatedBrain() {
  const calls = [];
  let releaseFirst = null;
  return {
    calls,
    releaseFirst: () => releaseFirst?.(),
    async turn(being, ev) {
      const idx = calls.length;
      calls.push({ being, body: ev.body });
      if (idx === 0) await new Promise((res) => { releaseFirst = res; });   // hold turn 1 open
      return { text: `reply-${ev.body}`, sessionId: `s${idx}` };
    },
  };
}
const fakeIdentity = { build: (m) => ({ ...m, mention: m.mention ?? { atEStart: true, atEAnywhere: true, replyToBot: false }, line: m.body }) };
const fakeRouter = { resolve: () => ({ being: 'e', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) };
const fakeGating = { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
const fakeHeartbeats = { runDue() {} };

function build({ commands = null } = {}) {
  const bridge = fakeBridge();
  const sender = recordingSender();
  const brain = gatedBrain();
  const logged = [];
  const transcript = { async log(ev) { logged.push(ev.body); } };
  const spine = createSpine({
    bridge, brain, commands,
    identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
    sender, transcript, heartbeats: fakeHeartbeats,
    clock: { now: () => 1000 },
  });
  spine.start();
  return { spine, bridge, sender, brain, logged };
}

const CHAT = 'chat-A@g.us';
const mention = (body, msgId, extra = {}) => ({ surface: 'wa', node: 'wa', chatId: CHAT, chatName: 'fam', senderId: 'u', senderName: 'An', msgId, ts: 1000, body, kind: 'text', raw: {}, ...extra });

describe('spine — the deferred stand-down', () => {
  it('(a) a turn IN FLIGHT: the token does NOT exit until that turn completes', async () => {
    const { spine, bridge, brain } = build();
    const p1 = bridge.emit(mention('one', 'm1'));
    await flush();
    expect(brain.calls).toHaveLength(1);          // turn 1 is running, and held open

    const exits = [];
    spine.standdown(() => exits.push('exit'));
    await flush();
    await flush();
    expect(exits).toEqual([]);                    // ← the whole point: still writing, so still here

    brain.releaseFirst();
    await p1;
    await flush();
    expect(exits).toEqual(['exit']);              // …and it leaves the moment the turn lands
  });

  it('(b) nothing in flight: the token exits PROMPTLY (synchronously — the successor is waiting)', () => {
    const { spine } = build();
    const exits = [];
    spine.standdown(() => exits.push('exit'));
    expect(exits).toEqual(['exit']);
  });

  it('(c) a turn arriving AFTER the token is REFUSED — never admitted-then-orphaned', async () => {
    const { spine, bridge, brain, sender, logged } = build();
    const p1 = bridge.emit(mention('one', 'm1'));
    await flush();
    const exits = [];
    spine.standdown(() => exits.push('exit'));

    const p2 = bridge.emit(mention('two', 'm2'));   // arrives during the drain
    await flush();
    expect(brain.calls.map((c) => c.body)).toEqual(['one']);   // no second turn admitted
    expect(sender.placeholders).toHaveLength(1);               // and NO orphan "⏳ Thinking…" left behind
    expect(logged).toEqual(['one', 'two']);                    // refused ≠ dropped: it is on the record
    expect(exits).toEqual([]);                                 // the refusal did not end the drain early

    brain.releaseFirst();
    await Promise.all([p1, p2]);
    await flush();
    expect(exits).toEqual(['exit']);
    expect(brain.calls).toHaveLength(1);                       // the refused message never woke a turn later either
  });

  it('(c2) the operator\'s recovery path still lands while standing down — a /restart is not refused', async () => {
    const ran = [];
    const commands = { isCommand: (ev) => String(ev.body ?? '').startsWith('/'), run: async (ev) => { ran.push(ev.body); } };
    const { spine, bridge } = build({ commands });
    spine.standdown(() => {});                      // nothing in flight — pending fires at once, but the flag stands
    await bridge.emit(mention('/restart', 'm1'));
    await bridge.emit(mention('/status', 'm2'));    // an ORDINARY command is refused like any other turn
    await flush();
    expect(ran).toEqual(['/restart']);
  });

  it('(d) a second token while one is pending is ignored (the successor retries the PORT, it does not re-announce)', async () => {
    const { spine, bridge, brain } = build();
    const p1 = bridge.emit(mention('one', 'm1'));
    await flush();
    const exits = [];
    spine.standdown(() => exits.push('first'));
    spine.standdown(() => exits.push('second'));
    brain.releaseFirst();
    await p1;
    await flush();
    expect(exits).toEqual(['first']);               // exactly one exit, and it is the first caller's
  });
});

// boot.mjs is the ONE place the deferral is wired: every lifecycle code goes down through goDown,
// and 45 alone is routed through spine.standdown() first. This exercises that composition against
// fakes — the same technique tests/spine-ingest.test.mjs uses for boot's ingest `handle`, since
// boot() itself wires no override seam for it — plus a source lock that boot really has the shape
// being modelled here.
describe('boot announceAndExit — 45 defers, the other three leave immediately', () => {
  function makeAnnounceAndExit({ spine, goDown }) {
    return async (code) => {
      if (code === 45) { spine.standdown(() => { goDown(code); }); return; }
      await goDown(code);
    };
  }

  it('43 / 42 / 44 exit immediately, unchanged — the spine is never consulted', async () => {
    const down = []; const consulted = [];
    const announceAndExit = makeAnnounceAndExit({ spine: { standdown: () => consulted.push(true) }, goDown: (c) => down.push(c) });
    await announceAndExit(43);
    await announceAndExit(42);
    await announceAndExit(44);
    expect(down).toEqual([43, 42, 44]);
    expect(consulted).toEqual([]);
  });

  it('45 goes through the spine and only goes down when the spine says it has drained', async () => {
    const down = []; let drain = null;
    const announceAndExit = makeAnnounceAndExit({ spine: { standdown: (done) => { drain = done; } }, goDown: (c) => down.push(c) });
    await announceAndExit(45);
    expect(down).toEqual([]);      // pending — the turn in flight is still being written
    drain();
    expect(down).toEqual([45]);
  });

  it('boot.mjs really is wired that way (source lock)', () => {
    const BOOT_SRC = readFileSync(new URL('../src/spine/boot.mjs', import.meta.url), 'utf8');
    expect(BOOT_SRC).toContain('if (code === 45) { spine.standdown(');
    expect(BOOT_SRC).toContain("writeStanddownTarget: (port) => writeFile(join(EGPT_HOME, 'standdown-target.txt'), port, 'utf8')");
  });
});
