// THE JOYCE SHAPE — a steer that reported success into a session that had stopped consuming
// (operator 2026-09-09, live 1:1 `Joyce Vicente-2606301852`).
//
// WHAT HAPPENED. Four messages arrived while a turn was "running"; each was steered, each got a
// 👀, and no reply ever came. Measured on the box afterwards: the sandboxed claude.exe had NO
// CHILDREN and ~350s of CPU over 21 hours — idle, not hung. The turn had ended as far as the CLI
// was concerned; the pool's `busy` flag never cleared, so the live-turn register kept admitting
// new input, and every message was folded into a turn that was already over.
//
// WHY EVERY LAYER REPORTED SUCCESS. `inject()` wrote a user line to a LIVE process's stdin and
// returned true. A write to a live pipe succeeds whether or not anything on the other end ever
// reads it — so `true` meant SENT, never RECEIVED, and the 👀 sitting on top of it was a claim
// about the model that nothing had checked. Operator: "nothing in eGPT can be allowed to lie".
//
// THE TWO REACTIONS, AND WHY THEY ARE A PAIR (operator 2026-09-09):
//   📩  the BRIDGE has it. Placed on arrival, for a message destined for an agent. It claims
//       receipt and nothing else, so it is honest by construction.
//   👀  the MODEL took it. Placed only on real evidence of ingestion — never on a write.
// 📩 with no 👀 following is now a VISIBLE SYMPTOM, in the chat, at the time. In the Joyce
// incident that is exactly what the operator would have seen instead of four confident 👀s.
//
// THE EVIDENCE THE 👀 NOW RIDES ON, measured 2026-09-09 against the real
// `claude --input-format stream-json` CLI (claude.exe 2.x, this box):
//   `--replay-user-messages` — "Re-emit user messages from stdin back on stdout for
//   acknowledgment". A line written to a live stdin comes back on stdout as
//   {"type":"user","message":{...},"isReplay":true} AT THE MOMENT THE CLI INGESTS IT, not when
//   it reads the bytes. Both halves were measured:
//     - AGENTIC turn, injected while tool_use #2 was streaming: the replay came back 29ms
//       later, positioned right after that call's tool_result — the message went into the
//       LIVE turn.
//     - PURE-TEXT turn, injected 2423ms into the generation: the replay came back at 5485ms —
//       AFTER the turn's own result (4923ms) and after the CLI opened a second `init` for it.
//       Not absorbed; a separate turn.
//   3062ms apart on the same flag, which is what proves it marks ingestion rather than the read.
// Nothing else in the stream mentions an injected line: with the flag OFF, the injected text
// appears NOWHERE in stdout — 0 occurrences across a full 258-event agentic run.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createTurns } from '../src/spine/turns.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// A fake `claude --input-format stream-json`. `consuming:false` IS the Joyce shape: the process
// is alive and the write to its stdin succeeds, but nothing on the other end ever reads it —
// no replay, no result, no exit.
function fakeClaude({ consuming = true, sessionId = 'sess-1' } = {}) {
  let proc = null;
  const argv = [];
  const written = [];
  const spawn = (bin, args) => {
    argv.push(...args);
    proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.kill = () => {};
    proc.stdin = {
      write: (line) => {
        written.push(JSON.parse(line).message.content.map((c) => c.text).join(''));
        if (written.length === 1 && consuming) {
          setImmediate(() => emit({ type: 'system', subtype: 'init', session_id: sessionId }));
        }
        return true;                                  // a live pipe ALWAYS takes the bytes
      },
      end: () => {},
    };
    return proc;
  };
  const emit = (ev) => proc.stdout.emit('data', JSON.stringify(ev) + '\n');
  // What the CLI emits when it actually ingests a user line (--replay-user-messages).
  const replay = (text) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, isReplay: true });
  const result = (text) => emit({ type: 'result', subtype: 'success', result: text });
  return { spawn, argv, written, emit, replay, result, getProc: () => proc };
}

describe('warm-cli-session — the injection ACK is evidence, not a successful write', () => {
  it('asks the CLI to acknowledge injected lines at all (--replay-user-messages)', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await tick();
    expect(f.argv).toContain('--replay-user-messages');
    // …beside the streaming input format it only works with.
    expect(f.argv.slice(0, 2)).toEqual(['--input-format', 'stream-json']);
    s.close();
  });

  it('THE JOYCE SHAPE: the write lands on a live pipe nothing is reading — and that is NOT an ack', async () => {
    const f = fakeClaude({ consuming: false });        // alive, idle, never consumes
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await tick();

    const handed = s.inject('are you there?');
    expect(f.written).toEqual(['ORIGINAL', 'are you there?']);   // the write really did land

    let acked = null;
    handed.ack.then((r) => { acked = r; });
    await flush();
    expect(acked).toBe(null);            // …and NOTHING has acknowledged it. No 👀 may be placed.
    s.close();
  });

  it('the ack resolves ok ONLY when the CLI replays the line back (ingested into the live turn)', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await tick();

    const handed = s.inject('actually do X');
    let acked = null;
    handed.ack.then((r) => { acked = r; });
    await flush();
    expect(acked).toBe(null);                          // not yet — the write alone proves nothing
    f.replay('actually do X');                         // the CLI ingests it
    await flush();
    expect(acked).toEqual({ ok: true });
    s.close();
  });

  it('the turn ending first is a REFUSAL, not a silence: the pure-text turn that never absorbed it', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const pr = s.turn('count to forty');
    await tick();

    const handed = s.inject('also say BANANA');
    let acked = null;
    handed.ack.then((r) => { acked = r; });
    f.result('One Two Three…');                        // turn 1 answers its ORIGINAL task
    await pr;
    await flush();
    expect(acked?.ok).toBe(false);
    expect(acked?.reason).toMatch(/turn ended/i);
    s.close();
  });

  it("the CLI's own replay of the TURN's opening line never acks an injection that happens to match", async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ok');
    await tick();
    f.replay('ok');                                    // the opener coming back — not an ack
    await flush();

    const handed = s.inject('ok');                     // the SAME text, steered
    let acked = null;
    handed.ack.then((r) => { acked = r; });
    await flush();
    expect(acked).toBe(null);
    f.replay('ok');                                    // …and now the injection's own replay
    await flush();
    expect(acked).toEqual({ ok: true });
    s.close();
  });

  // The turn's own `result` arrives as one of these lines. Dropping one silently is how a turn
  // can stop existing with the CLI alive and idle and NOTHING anywhere saying why — the state
  // the Joyce session was measured in. Whether that is what happened there cannot be recovered;
  // that it would have left no trace can be.
  it('an unreadable stdout line is REPORTED, not silently discarded — and the flood is capped', async () => {
    const logs = [];
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn, onLog: (m) => logs.push(m) });
    s.turn('ORIGINAL');
    await tick();
    for (let i = 0; i < 8; i++) f.getProc().stdout.emit('data', `{"type":"result" TRUNCATED ${i}\n`);
    await flush();
    const said = logs.filter((l) => /DISCARDED an unreadable stdout line/.test(l));
    expect(said).toHaveLength(5);
    expect(said[0]).toMatch(/starts "\{\\"type\\":\\"result\\" TRUNCATED 0"/);
    expect(said[4]).toMatch(/further ones on this session are not logged/);
    s.close();
  });

  // It is still RAW STDOUT, and a truncated tool_use input can carry a credential. Same
  // redaction pass the tool_use stubs already use — not a second one.
  it('…and it redacts, because a broken line is still raw stdout', async () => {
    const logs = [];
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn, onLog: (m) => logs.push(m) });
    s.turn('ORIGINAL');
    await tick();
    f.getProc().stdout.emit('data', '{"input":{"command":"curl -u admin:hunter2 https://radio\n');
    await flush();
    const said = logs.find((l) => /DISCARDED an unreadable stdout line/.test(l));
    expect(said).toContain('-u ***');
    expect(said).not.toContain('hunter2');
    s.close();
  });

  it('closing a session with an un-ingested injection says so instead of leaving it hanging', async () => {
    const f = fakeClaude({ consuming: false });
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await tick();
    const handed = s.inject('swallowed');
    let acked = null;
    handed.ack.then((r) => { acked = r; });
    s.close();
    await flush();
    expect(acked?.ok).toBe(false);
    expect(acked?.reason).toMatch(/closed/i);
  });
});

describe('warm pool — steer refuses loudly, and never on a write alone', () => {
  const poolOn = (opts = {}) => {
    const logs = [];
    const f = fakeClaude(opts);
    const pool = createWarmPool({ makeSession: (o) => createWarmCliSession({ ...o, spawn: f.spawn }), onLog: (s) => logs.push(s) });
    return { pool, logs, f };
  };

  it('a key with NO warm entry is an ERROR that says so — not a quiet false', async () => {
    const { pool, logs } = poolOn();
    expect(await pool.steer('never-opened', 'x')).toBe(false);
    expect(logs.join('\n')).toMatch(/steer FAILED never-opened.*no warm entry/);
  });

  it('the Joyce shape through the pool: handed over, never acknowledged, and it is logged as a failure', async () => {
    const { pool, logs, f } = poolOn({ consuming: false });
    pool.run('k', 'ORIGINAL');
    await flush();

    const handed = await pool.steer('k', 'are you there?');
    expect(handed).toBeTruthy();                       // the write landed…
    expect(f.written).toEqual(['ORIGINAL', 'are you there?']);
    expect(logs.join('\n')).toMatch(/warm: handed to the live turn k — awaiting the model's acknowledgement/);
    expect(logs.join('\n')).not.toMatch(/acknowledged/);   // nothing has confirmed anything yet

    pool.evict('k');                                   // …and the truth arrives when the session goes
    await flush();
    expect(logs.join('\n')).toMatch(/steer NOT INGESTED k/);
  });

  it('a real acknowledgement is logged as one', async () => {
    const { pool, logs, f } = poolOn();
    pool.run('k', 'ORIGINAL');
    await flush();
    await pool.steer('k', 'actually do X');
    f.replay('actually do X');
    await flush();
    expect(logs.join('\n')).toMatch(/warm: the model ACKNOWLEDGED the steered message k/);
  });
});

// ── THE PAIR, WHERE THE CHAT SEES IT ───────────────────────────────────────────────────────────
describe('turns.steerLiveTurn — 📩 is the bridge, 👀 is the model', () => {
  const KEY = 'e:wa:chat-1';
  const EV = { surface: 'wa', chatId: 'chat-1', senderId: 'an', senderName: 'An', body: 'actually do X', msgId: 'm2' };
  const LIVE = { senderId: 'an', chatId: 'chat-1' };

  function harness(steerImpl) {
    const reactions = [];
    const notes = [];
    const bridge = { async react(chatId, msgId, emoji) { reactions.push({ chatId, msgId, emoji }); return true; } };
    const brain = { async allowNewInput() { return 'any'; }, steer: steerImpl };
    const turns = createTurns({ brain, bridge, log: { line: (s) => notes.push(s) } });
    turns.setLive(KEY, LIVE);
    return { turns, reactions, notes };
  }

  it('THE JOYCE SHAPE END TO END: 📩 lands, the steer is never acknowledged, and NO 👀 is placed', async () => {
    let settle;
    const ack = new Promise((r) => { settle = r; });
    const { turns, reactions, notes } = harness(() => ({ ack }));

    expect(await turns.steerLiveTurn({ to: 'e', ev: EV, turnKey: KEY })).toBe(true);
    await flush();
    expect(reactions).toEqual([{ chatId: 'chat-1', msgId: 'm2', emoji: '📩' }]);   // receipt, and ONLY receipt

    // The model never took it. The chat is left showing 📩 with no 👀 — the visible symptom —
    // and the log says it in words rather than reporting a success.
    settle({ ok: false, reason: 'the turn ended before the CLI ingested it' });
    await flush();
    expect(reactions.map((r) => r.emoji)).toEqual(['📩']);
    expect(notes.join('\n')).toMatch(/NEVER INGESTED/);
    expect(notes.join('\n')).toMatch(/the turn ended before the CLI ingested it/);
  });

  it('the healthy shape: 📩 first, then 👀 — in that order, and only after real evidence', async () => {
    let settle;
    const ack = new Promise((r) => { settle = r; });
    const { turns, reactions, notes } = harness(() => ({ ack }));

    expect(await turns.steerLiveTurn({ to: 'e', ev: EV, turnKey: KEY })).toBe(true);
    await flush();
    expect(reactions.map((r) => r.emoji)).toEqual(['📩']);         // the 👀 has NOT been placed yet
    settle({ ok: true });
    await flush();
    expect(reactions.map((r) => r.emoji)).toEqual(['📩', '👀']);
    expect(reactions.every((r) => r.chatId === 'chat-1' && r.msgId === 'm2')).toBe(true);
    expect(notes.join('\n')).toMatch(/the model took the steered message/);
  });

  it('a steer that reports success with NO evidence gets 📩 and never a 👀', async () => {
    const { turns, reactions } = harness(() => true);              // the old contract, bare
    expect(await turns.steerLiveTurn({ to: 'e', ev: EV, turnKey: KEY })).toBe(true);
    await flush();
    expect(reactions.map((r) => r.emoji)).toEqual(['📩']);
  });

  // The 📩 does not depend on the steer, which is the entire reason it is honest. A steer that
  // could not be handed over queues instead (unchanged), and the sender sees 📩 + the ordinary
  // queued placeholder — never a 👀, because nothing took it.
  it('nothing was handed over at all: 📩 still stands, no 👀, the caller queues, and it says why', async () => {
    const { turns, reactions, notes } = harness(() => false);
    expect(await turns.steerLiveTurn({ to: 'e', ev: EV, turnKey: KEY })).toBe(false);
    await flush();
    expect(reactions.map((r) => r.emoji)).toEqual(['📩']);
    expect(notes.join('\n')).toMatch(/steer FAILED/);
    expect(notes.join('\n')).toMatch(/queueing it instead/);
  });

  it('a message that is NOT admitted is not the bridge\'s to ack — it queues with no reaction', async () => {
    const reactions = [];
    const brain = { async allowNewInput() { return 'none'; }, steer: () => ({ ack: Promise.resolve({ ok: true }) }) };
    const turns = createTurns({ brain, bridge: { async react(c, m, e) { reactions.push({ c, m, e }); } } });
    turns.setLive(KEY, LIVE);
    expect(await turns.steerLiveTurn({ to: 'e', ev: EV, turnKey: KEY })).toBe(false);
    await flush();
    expect(reactions).toEqual([]);
  });

  it('ack:false (a relayed turn, no local message to sit on) places NEITHER reaction', async () => {
    const { turns, reactions } = harness(() => ({ ack: Promise.resolve({ ok: true }) }));
    expect(await turns.steerLiveTurn({ to: 'e', ev: EV, turnKey: KEY, ack: false })).toBe(true);
    await flush();
    expect(reactions).toEqual([]);
  });
});
