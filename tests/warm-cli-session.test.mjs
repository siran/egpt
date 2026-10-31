// Locks the Unit 4 warm-CLI primitive (operator 2026-06-13): ONE resident
// `claude` process answers many turns (residency = warmth), captures the minted
// session id, streams text deltas, and fails the in-flight turn on an error
// result or a mid-turn process crash. Uses an injectable fake `claude` that
// speaks stream-json — no real CLI / network.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createWarmCliSession, renderToolUse, redactSecrets } from '../src/warm-cli-session.mjs';
import { isDeadSessionError } from '../src/brain-errors.mjs';

function fakeClaude({ failOn = null, hang = false, sessionId = 'sess-123' } = {}) {
  let spawnCount = 0;
  let lastProc = null;
  let turnNo = 0;
  const calls = [];
  const spawn = () => {
    spawnCount++;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    proc.stdin = {
      write: (line) => {
        const text = JSON.parse(line).message.content.map((c) => c.text).join('');
        calls.push(text);
        turnNo++;
        if (hang) return;
        setImmediate(() => {
          if (turnNo === 1) proc.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
          if (failOn && text.includes(failOn)) {
            proc.stderr.emit('data', 'boom\n');
            proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'error_during_execution' }) + '\n');
            return;
          }
          const reply = `echo:${text}`;
          // split the reply across two delta chunks to exercise line buffering
          proc.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(0, 5) } } }) + '\n');
          proc.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(5) } } }) + '\n');
          proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: reply }) + '\n');
        });
      },
      end: () => {},
    };
    lastProc = proc;
    return proc;
  };
  return { spawn, calls, getProc: () => lastProc, spawnCount: () => spawnCount };
}

describe('warm-cli-session — resident multi-turn', () => {
  it('ONE process answers many turns (residency = warmth) + captures the session id', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const r1 = await s.turn('ONE');
    const r2 = await s.turn('TWO');
    expect(r1.text).toBe('echo:ONE');
    expect(r2.text).toBe('echo:TWO');
    expect(r1.sessionId).toBe('sess-123');
    expect(f.calls).toEqual(['ONE', 'TWO']);
    expect(f.spawnCount()).toBe(1);   // not re-spawned per turn — warm
    s.close();
  });

  it('streams text deltas to onUpdate, resolves with the full text', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const updates = [];
    const r = await s.turn('HI', (t) => updates.push(t));
    expect(r.text).toBe('echo:HI');
    expect(updates.length).toBeGreaterThanOrEqual(2);          // split deltas
    expect(updates[updates.length - 1]).toBe('echo:HI');       // last snapshot = full
    s.close();
  });

  it('an error result rejects the in-flight turn (pool then evicts)', async () => {
    const f = fakeClaude({ failOn: 'BAD' });
    const s = createWarmCliSession({ spawn: f.spawn });
    await expect(s.turn('a BAD one')).rejects.toThrow(/error_during_execution/);
    s.close();
  });

  it('a mid-turn process crash rejects the turn (no silent hang)', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    const pr = s.turn('X');
    await new Promise((r) => setImmediate(r));   // let spawn + stdin.write run
    f.getProc().emit('close', 1);
    await expect(pr).rejects.toThrow(/exited 1/);
    s.close();
  });

  it('close() mid-turn rejects the turn, even from a process that never closes (evicted dead)', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    const pr = s.turn('X');
    await new Promise((r) => setImmediate(r));
    s.close();
    await expect(pr).rejects.toThrow(/closed mid-turn/);
  });

  it('close() ends the process and refuses further turns', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('ONE');
    s.close();
    expect(f.getProc().killed).toBe(true);
    await expect(s.turn('TWO')).rejects.toThrow(/closed/);
  });
});

// inject() — STEER THE TURN THAT IS ALREADY STREAMING (operator 2026-08-30, measured against
// the real `claude --input-format stream-json` CLI: an AGENTIC turn absorbs a second user line
// written to its stdin at a tool boundary — one result, answering the new instruction; a
// pure-text turn instead finishes and answers twice. See the module header).
//
// The invariants that matter here: the wire format is BYTE-IDENTICAL to a turn's (the CLI
// cannot tell them apart, and must not), NO second `pending` is created (the live turn's one
// result is the combined reply — a second pending would be a promise nothing can settle), and
// it NEVER throws: every "nothing was handed over" is a plain `false`, because a false NEGATIVE
// only costs a queued turn while a false POSITIVE silently swallows the message.
//
// WHAT A NON-FALSE ANSWER MEANS CHANGED ON 2026-09-09 (operator, after the Joyce fault): it is
// `{ ack }`, not `true` — the bytes are on their way, and `ack` is what later says whether the
// MODEL took them. The evidence itself is covered in tests/steer-ack.test.mjs; the cases below
// only care that something/nothing was handed over, so they assert truthiness.
describe('warm-cli-session — inject (steer the live turn, operator 2026-08-30)', () => {
  it('writes ONE user line to the SAME stdin, in the same wire format a turn uses', async () => {
    const f = fakeClaude({ hang: true });                 // hang: the turn stays in flight
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL').catch(() => {});
    await new Promise((r) => setImmediate(r));
    expect(s.inject('ACTUALLY DO X')).toBeTruthy();
    expect(f.calls).toEqual(['ORIGINAL', 'ACTUALLY DO X']);   // parsed by the fake as a user msg
    expect(f.spawnCount()).toBe(1);                            // the SAME process
    s.close();
  });

  it('creates NO second pending — the live turn resolves ONCE, with the combined reply', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    let settled = 0;
    const pr = s.turn('ORIGINAL').then(() => { settled++; });
    await new Promise((r) => setImmediate(r));
    expect(s.inject('AND ALSO Y')).toBeTruthy();
    // ONE result event, and it settles the ONE pending the turn made.
    f.getProc().stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'combined' }) + '\n');
    await pr;
    expect(settled).toBe(1);
    // A second result would have nothing to settle — no throw, no double-resolve.
    f.getProc().stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'stray' }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(1);
    s.close();
  });

  it('false when there is NO turn in flight (nothing to steer) — and no process is spawned', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    expect(s.inject('too early')).toBe(false);            // never turned: no proc, no pending
    expect(f.spawnCount()).toBe(0);
    await s.turn('ONE');                                   // turn settled → pending is null again
    expect(s.inject('too late')).toBe(false);
    expect(f.calls).toEqual(['ONE']);
    s.close();
  });

  it('false on a CLOSED session', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL').catch(() => {});
    await new Promise((r) => setImmediate(r));
    s.close();
    expect(s.inject('x')).toBe(false);
  });

  it('false — never a throw — when the stdin write itself fails', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL').catch(() => {});
    await new Promise((r) => setImmediate(r));
    f.getProc().stdin.write = () => { throw new Error('EPIPE'); };
    expect(s.inject('x')).toBe(false);                     // swallowed, reported as false
    s.close();
  });
});

// A fake AGENTIC turn: reason+tool_use -> tool_result -> reason again -> stream the final
// text -> a mirrored final assistant text block -> result. Models what a real ccode turn
// actually emits (multiple `assistant` events before `result`), which the plain fakeClaude()
// above (single result, no assistant/thinking/tool_use events) does not exercise.
function fakeClaudeAgentic({ sessionId = 'sess-agentic' } = {}) {
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    proc.stdin = {
      write: () => {
        setImmediate(() => {
          const emit = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
          emit({ type: 'system', subtype: 'init', session_id: sessionId });
          emit({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'THINK1: let me check the directory' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
          ] } });
          emit({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'DIRLISTING-secret-output' },
          ] } });
          emit({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'THINK2: now I can answer' },
          ] } });
          emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
          emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } });
          emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
          emit({ type: 'result', subtype: 'success', result: 'Hello' });
        });
      },
      end: () => {},
    };
    return proc;
  };
  return { spawn };
}

describe('warm-cli-session — verboseThinking (operator 2026-08-29, wren\'s "full chain of thought")', () => {
  it('OFF (default): same text as today on a multi-assistant-event agentic turn (regression lock)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn });
    const r = await s.turn('what is in the dir?');
    expect(r.text).toBe('Hello');
    s.close();
  });

  // Was `Bash()` until 2026-08-30; the operator then asked to "reveal a bit more on what
  // inside the parenthesis". The stub now summarizes the INPUT — the invariant that did NOT
  // change, and is the one that matters, is that the tool RESULT is still never included.
  it('ON: thinking verbatim + ToolName(<input summary>) + final text, in order, never the tool result', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const r = await s.turn('what is in the dir?');
    expect(r.text).toBe(
      'THINK1: let me check the directory\n\nBash(ls -la)\n\nTHINK2: now I can answer\n\nHello'
    );
    expect(r.text).not.toContain('DIRLISTING');    // tool_result content never included
    s.close();
  });

  it('ON: a tool_use carrying a credential reaches the reply REDACTED', async () => {
    const spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = {
        write: () => setImmediate(() => {
          const emit = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
          emit({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -u radio:hunter2 https://station.local/now' } },
          ] } });
          emit({ type: 'result', subtype: 'success', result: 'done' });
        }),
        end: () => {},
      };
      return proc;
    };
    const s = createWarmCliSession({ spawn, verboseThinking: true });
    const r = await s.turn('play something');
    expect(r.text).toBe('Bash(curl -u *** https://station.local/now)');
    expect(r.text).not.toContain('hunter2');
    s.close();
  });

  // Was "identical in both modes" until the progressive-preview fix below: ON mode now ALSO
  // gets a preview per assistant event, so the two can no longer match exactly. What must
  // still hold is that OFF stays byte-identical (regression lock), and ON's text-delta-driven
  // updates are the SAME ones OFF gets — verbose previews are additive, not a replacement.
  // Was "ON gets the SAME text-delta updates PLUS progressive verbose previews" — that
  // assertion was itself checking the bug (operator 2026-08-30): branch 2's bare pending.acc
  // updates and branch 1's THINK1-prefixed updates diverged, which made sender.mjs's absorb()
  // seal one behind RETAINED_SEAM and start a new tail, producing visible duplicate text in
  // WhatsApp. Fix: branch 2's onUpdate is suppressed when verboseThinking is on, so ON mode's
  // updates are fed by the verbose-block branch only.
  it('OFF is unchanged; ON only gets verbose-block previews (plain-delta updates suppressed to avoid a divergence/duplicate in sender.mjs)', async () => {
    const updatesOff = [];
    const sOff = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn });
    await sOff.turn('x', (t, use) => use || updatesOff.push(t));   // text updates only, not the tool signal
    sOff.close();

    const updatesOn = [];
    const sOn = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    await sOn.turn('x', (t) => updatesOn.push(t));
    sOn.close();

    expect(updatesOff).toEqual(['Hel', 'Hello']);            // regression lock: OFF path byte-identical
    expect(updatesOn.length).toBeGreaterThan(0);
    for (const u of updatesOn) {
      expect(u.startsWith('THINK1')).toBe(true);              // every ON update is a verbose-block preview
    }
    for (const off of updatesOff) {
      expect(updatesOn).not.toContain(off);                   // bare delta strings never reach onUpdate in ON mode
    }
  });

  // Reproduces the production duplicate-text bug (operator 2026-08-30, live WhatsApp
  // screenshot: "ListAgents()\n\nI'll start by reading...\n\n— ↓ reply —\n\nI'll start by
  // reading..."). Before the fix, branch 1 (verbose-block preview) and branch 2 (bare
  // text-delta / pending.acc preview) both called onUpdate for the same turn, feeding
  // sender.mjs's absorb() two independently-growing strings. absorb() seals the current tail
  // behind RETAINED_SEAM and starts a new one whenever the next value does NOT start with the
  // current one — so any such interruption here would reproduce the visible duplicate. Post-fix
  // there must be exactly ONE growing sequence, fed only by the verbose-block branch.
  it('ON: every onUpdate value monotonically extends the previous one (no divergence for sender.mjs to duplicate)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const updates = [];
    await s.turn('what is in the dir?', (t) => updates.push(t));
    s.close();
    expect(updates.length).toBeGreaterThan(1);
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i].startsWith(updates[i - 1])).toBe(true);
    }
  });

  // The gap this fix closes: today the verbose transcript is only ever delivered ONCE,
  // at `result`. The operator wants it to grow message-by-message (edited in place in
  // WhatsApp) the same way plain streaming already does via pending.acc. So onUpdate
  // must fire on EVERY assistant event that pushes new verbose blocks, each call
  // carrying the transcript accumulated so far, and the last such call must equal the
  // turn's final resolved text.
  it('ON: onUpdate also fires progressively with the growing verbose transcript (not just once at the end)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const updates = [];
    const r = await s.turn('what is in the dir?', (t) => updates.push(t));
    const verboseUpdates = updates.filter((u) => u.startsWith('THINK1'));
    // fakeClaudeAgentic emits 3 assistant events that each push new verbose blocks
    // (thinking+tool_use, then thinking, then the final text) — expect a preview per event.
    expect(verboseUpdates.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < verboseUpdates.length; i++) {
      expect(verboseUpdates[i].startsWith(verboseUpdates[i - 1])).toBe(true);   // strictly growing
    }
    expect(verboseUpdates[verboseUpdates.length - 1]).toBe(r.text);   // last preview == final resolved text
  });
});

// ── THE MESSAGE BOUNDARY (operator 2026-09-01) ──────────────────────────────────────────
//
// The LIVE failure, twice that morning in the SPOILER chat: a being's reply reached the
// humans as "...a simple affirmation doesn't need a reply from me./react #563 🤝". The model
// put its limb on its own line; the turn's accumulator ran two consecutive assistant messages
// together with NOTHING between, so the line-anchored parse in reply-actions.mjs saw one line
// and no action — and the delivered message being append-only, that frame stayed on screen.
// 51df9d8 repaired it at the PARSER (a '/' welded onto sentence-ending punctuation is read as
// a lost newline) and said explicitly that the accumulator was still welding. This is the cure
// at the seam. Not a ccode quirk: codex-cli-session has the same accumulator-vs-result shape.
//
// `messages` is the turn's assistant messages in order: a STRING is a text message (streamed
// as two deltas, then mirrored by its own `assistant` event — the order a real ccode turn
// uses), an object { tool } is a tool_use-only message (an `assistant` event, a tool_result on
// a `user` event, and no text delta at all). `result` is what the CLI settles with, which for
// a real agentic turn is only the LAST message — the other half of the disagreement.
function fakeClaudeMessages(messages, { result = null, sessionId = 'sess-multi' } = {}) {
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.kill = () => {};
    proc.stdin = {
      write: () => setImmediate(() => {
        const emit = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
        const delta = (text) => emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
        emit({ type: 'system', subtype: 'init', session_id: sessionId });
        let last = '';
        for (const m of messages) {
          if (typeof m !== 'string') {
            emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: m.tool, input: { command: 'ls -la' } }] } });
            emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'DIRLISTING' }] } });
            continue;
          }
          // Split on CODE POINTS, never UTF-16 units — the live case ends in 🤝 and a
          // half-emoji delta would be testing the fake, not the session.
          const cps = Array.from(m);
          const half = Math.ceil(cps.length / 2);
          delta(cps.slice(0, half).join(''));
          delta(cps.slice(half).join(''));
          emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: m }] } });
          last = m;
        }
        emit({ type: 'result', subtype: 'success', result: result ?? last });
      }),
      end: () => {},
    };
    return proc;
  };
  return { spawn };
}

const PROSE = "Un abrazo — a simple affirmation doesn't need a reply from me.";
const LIMB = '/react #563 🤝';

describe('warm-cli-session — consecutive assistant messages carry a boundary, not a weld (operator 2026-09-01)', () => {
  it('THE LIVE CASE: two assistant messages in one turn stream with a newline between them', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeMessages([PROSE, LIMB]).spawn });
    const updates = [];
    const r = await s.turn('gracias', (t) => updates.push(t));
    s.close();
    const streamed = updates[updates.length - 1];
    expect(streamed).toBe(`${PROSE}\n${LIMB}`);
    expect(streamed).not.toContain('me./react');           // the weld the operator read, verbatim
    // The POINT of the boundary: the limb is a LINE again, which is all the line-anchored
    // parse in reply-actions.mjs ever needed to see it (51df9d8's weld repair is now a backstop).
    expect(streamed.split('\n')).toEqual([PROSE, LIMB]);
    // UNCHANGED by this commit, and the other half of the disagreement: ev.result still wins
    // at `result` and still carries only the LAST message.
    expect(r.text).toBe(LIMB);
  });

  it('every onUpdate value still monotonically extends the previous one (acc only ever APPENDS)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeMessages([PROSE, LIMB]).spawn });
    const updates = [];
    await s.turn('gracias', (t) => updates.push(t));
    s.close();
    // What transcript.logStream/streamIncrement reconstructs from, and what sender.mjs's
    // absorb() refuses to seal a seam over: a pure append, separator included.
    expect(updates[0]).toBe(Array.from(PROSE).slice(0, Math.ceil(Array.from(PROSE).length / 2)).join(''));
    for (let i = 1; i < updates.length; i++) expect(updates[i].startsWith(updates[i - 1])).toBe(true);
  });

  it('the FIRST message of a turn gains NO leading separator', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeMessages([PROSE, LIMB]).spawn });
    const updates = [];
    await s.turn('gracias', (t) => updates.push(t));
    s.close();
    for (const u of updates) expect(u.startsWith('\n')).toBe(false);
    expect(updates[updates.length - 1].startsWith('Un abrazo')).toBe(true);
  });

  it('a SINGLE-message turn is byte-identical to before — no separator anywhere', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeMessages([PROSE]).spawn });
    const updates = [];
    const r = await s.turn('hola', (t) => updates.push(t));
    s.close();
    const cps = Array.from(PROSE);
    const head = cps.slice(0, Math.ceil(cps.length / 2)).join('');
    expect(updates).toEqual([head, PROSE]);                // exactly the two deltas' running concat
    expect(updates.join('')).not.toContain('\n');
    expect(r.text).toBe(PROSE);
  });

  it('tool_use-only messages between two runs of text add ONE break, not one per call', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeMessages([PROSE, { tool: 'Bash' }, { tool: 'Read' }, LIMB]).spawn });
    const updates = [];
    await s.turn('what is in the dir?', (t) => updates.push(t));
    s.close();
    expect(updates[updates.length - 1]).toBe(`${PROSE}\n${LIMB}`);   // the flag is a boolean, not a counter
  });

  it('verboseThinking is untouched — its text comes from verboseBlocks, never from acc', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeMessages([PROSE, { tool: 'Bash' }, LIMB]).spawn, verboseThinking: true });
    const updates = [];
    const r = await s.turn('what is in the dir?', (t) => updates.push(t));
    s.close();
    expect(r.text).toBe(`${PROSE}\n\nBash(ls -la)\n\n${LIMB}`);      // the '\n\n' block join, as before
    for (const u of updates) expect(u.startsWith('Un abrazo')).toBe(true);   // verbose-block previews only
    expect(updates).not.toContain(`${PROSE}\n${LIMB}`);              // acc never reaches onUpdate in ON mode
  });
});

// renderToolUse — the pure stub renderer (operator 2026-08-30: "reveal a bit more on what
// inside the parenthesis of 'Bash()'"). Tested directly, not through a fake CLI, because
// the rules that matter (headline field, whitespace, truncation, REDACTION) are per-block.
describe('renderToolUse — headline field per tool', () => {
  const t = (name, input) => renderToolUse({ type: 'tool_use', name, input });

  it('picks the one field that says what the call does', () => {
    expect(t('Bash', { command: 'ls -la', description: 'list' })).toBe('Bash(ls -la)');
    expect(t('Read', { file_path: '/a/b.mjs', offset: 3 })).toBe('Read(/a/b.mjs)');
    expect(t('Write', { file_path: '/a/b.mjs', content: 'x'.repeat(400) })).toBe('Write(/a/b.mjs)');
    expect(t('Edit', { file_path: '/a/b.mjs', old_string: 'x', new_string: 'y' })).toBe('Edit(/a/b.mjs)');
    expect(t('MultiEdit', { file_path: '/a/b.mjs', edits: [] })).toBe('MultiEdit(/a/b.mjs)');
    expect(t('NotebookEdit', { file_path: '/a/n.ipynb' })).toBe('NotebookEdit(/a/n.ipynb)');
    expect(t('Glob', { pattern: '**/*.mjs', path: 'src' })).toBe('Glob(**/*.mjs)');
    expect(t('Grep', { pattern: 'verbose_thinking', path: 'src' })).toBe('Grep(verbose_thinking)');
    expect(t('WebFetch', { url: 'https://x/y', prompt: 'summarize' })).toBe('WebFetch(https://x/y)');
    expect(t('WebSearch', { query: 'vitest snapshot' })).toBe('WebSearch(vitest snapshot)');
    expect(t('Task', { description: 'audit the redactor', prompt: 'long...' })).toBe('Task(audit the redactor)');
    expect(t('Agent', { description: 'audit the redactor', prompt: 'long...' })).toBe('Agent(audit the redactor)');
  });

  it('NotebookEdit also accepts the notebook_path alias', () => {
    expect(t('NotebookEdit', { notebook_path: '/a/n.ipynb' })).toBe('NotebookEdit(/a/n.ipynb)');
  });

  it('the headline field wins over an earlier-declared field', () => {
    // `description` comes first in insertion order but `command` is what Bash DOES.
    expect(t('Bash', { description: 'list the dir', command: 'ls -la' })).toBe('Bash(ls -la)');
  });

  it('unknown tool: first COMPACT string field; a payload blob is skipped', () => {
    expect(t('mcp__thing__do', { big: 'x'.repeat(500), tiny: 'ok' })).toBe('mcp__thing__do(ok)');
    expect(t('Whatever', { name: 'alpha', other: 'beta' })).toBe('Whatever(alpha)');
  });

  it('no usable field -> exactly today\'s bare stub', () => {
    expect(t('Nope', {})).toBe('Nope()');
    expect(t('Nope', { n: 5, ok: true, list: ['a'] })).toBe('Nope()');
    expect(t('Nope', { blob: 'x'.repeat(500) })).toBe('Nope()');   // nothing compact
    expect(t('Nope', undefined)).toBe('Nope()');
    expect(t('Nope', 'not-an-object')).toBe('Nope()');
    expect(t('Bash', { timeout: 5 })).toBe('Bash()');              // known tool, field missing
    expect(t('Bash', { command: '   ' })).toBe('Bash()');          // blank is not a summary
  });

  it('a nameless block renders nothing', () => {
    expect(renderToolUse({ type: 'tool_use', input: { command: 'ls' } })).toBe('');
    expect(renderToolUse(null)).toBe('');
  });
});

describe('renderToolUse — whitespace + truncation', () => {
  const t = (name, input) => renderToolUse({ type: 'tool_use', name, input });

  it('collapses newlines/tabs so a heredoc stays ONE line', () => {
    expect(t('Bash', { command: 'cat <<EOF\n\thello\n  world\nEOF' })).toBe('Bash(cat <<EOF hello world EOF)');
    expect(t('Bash', { command: '  leading and trailing  ' })).toBe('Bash(leading and trailing)');
  });

  it('truncates at the 60-char budget with a trailing ellipsis (boundary exact)', () => {
    expect(t('Bash', { command: 'a'.repeat(60) })).toBe(`Bash(${'a'.repeat(60)})`);   // 60 = untouched
    expect(t('Bash', { command: 'a'.repeat(61) })).toBe(`Bash(${'a'.repeat(59)}…)`);  // 61 = cut
    // the ellipsis lives INSIDE the budget: the rendered field is never longer than 60
    const long = t('Bash', { command: 'b'.repeat(5000) });
    expect(long.slice('Bash('.length, -1)).toHaveLength(60);
  });

  it('collapse happens before the budget, so a wrapped command is measured as one line', () => {
    const cmd = 'curl \\\n  --silent \\\n  https://station.local/api/queue/next-track-please';
    const out = t('Bash', { command: cmd });
    expect(out).not.toContain('\n');
    expect(out.endsWith('…)')).toBe(true);
  });
});

// The part that matters most: this text is posted into a WhatsApp chat.
describe('redactSecrets — every pattern (a leaked stub cannot be unposted)', () => {
  const gone = (raw, secret, expected) => {
    const out = redactSecrets(raw);
    expect(out).toBe(expected);
    expect(out).not.toContain(secret);
  };

  it('curl basic auth: -u / --user, spaced, =-joined, and glued', () => {
    gone('curl -u radio:hunter2 https://station.local/now', 'hunter2', 'curl -u *** https://station.local/now');
    gone('curl --user radio:hunter2 https://x', 'hunter2', 'curl --user *** https://x');
    gone('curl --user=radio:hunter2 https://x', 'hunter2', 'curl --user *** https://x');
    gone('curl -uradio:hunter2 https://x', 'hunter2', 'curl -u *** https://x');
    gone("curl -u 'radio:hunter 2' https://x", 'hunter 2', 'curl -u *** https://x');
  });

  it('Authorization headers (Bearer / Basic), keeping the enclosing quote', () => {
    gone('curl -H "Authorization: Bearer abc.def.ghi" https://api', 'abc.def.ghi',
      'curl -H "Authorization: Bearer ***" https://api');
    gone("curl -H 'Authorization: Basic Zm9vOmJhcg==' https://api", 'Zm9vOmJhcg==',
      "curl -H 'Authorization: Basic ***' https://api");
    gone('curl -H "Authorization: raw-token-value" https://api', 'raw-token-value',
      'curl -H "Authorization: ***" https://api');
  });

  it('a bare Bearer token, but not the English word', () => {
    gone('curl -H "Bearer abcdefghijklmnop" https://api', 'abcdefghijklmnop',
      'curl -H "Bearer ***" https://api');
    expect(redactSecrets('the bearer of bad news')).toBe('the bearer of bad news');
  });

  it('password=/passwd=/token=/api_key=/secret= in query strings AND env assignments', () => {
    gone("curl 'https://x/api?password=hunter2&q=1'", 'hunter2', "curl 'https://x/api?password=***&q=1'");
    gone('curl -d "api_key=abc123&x=1" https://x', 'abc123', 'curl -d "api_key=***&x=1" https://x');
    gone('EGPT_RELAY_PASSWORD=hunter2 node egpt.mjs', 'hunter2', 'EGPT_RELAY_PASSWORD=*** node egpt.mjs');
    gone('BEEPER_TOKEN=bpr_abc123 node x', 'bpr_abc123', 'BEEPER_TOKEN=*** node x');
    gone("SPEAKER_SECRET='s3 cr3t' ./play.sh", 's3 cr3t', 'SPEAKER_SECRET=*** ./play.sh');
    gone('psql "passwd=hunter2"', 'hunter2', 'psql "passwd=***"');
  });

  it('--password <x> / --token <x> flag forms', () => {
    gone('mysqldump --password hunter2 db', 'hunter2', 'mysqldump --password *** db');
    gone('cli --token abc123 --api-key=XYZ789', 'abc123', 'cli --token *** --api-key ***');
    gone('cli -token abc123', 'abc123', 'cli -token ***');
    // the separator is required, so a longer flag that merely STARTS with one is untouched
    expect(redactSecrets('cli --passthrough on')).toBe('cli --passthrough on');
  });

  it('credentials inline in a URL', () => {
    gone('git clone https://an:ghp_ABCDEFGHIJKL@github.com/siran/x.git', 'ghp_ABCDEFGHIJKL',
      'git clone https://***@github.com/siran/x.git');
    gone('curl http://admin:admin@speaker.local/play', 'admin:admin', 'curl http://***@speaker.local/play');
    // a bare username (no ':') is not a credential — keep it readable
    expect(redactSecrets('ssh://an@dolly')).toBe('ssh://an@dolly');
  });

  it('self-identifying key shapes with nothing to anchor on', () => {
    gone('node x.mjs sk-ant-api03-AAAABBBBCCCC', 'sk-ant-api03-AAAABBBBCCCC', 'node x.mjs ***');
    gone('gh auth login --with-token ghp_ABCDEFGHIJKLMNOP', 'ghp_ABCDEFGHIJKLMNOP', 'gh auth login --with-token ***');
    gone('curl -d eyJhbGciOiJIUzI1.cGF5bG9hZA.c2ln https://x', 'eyJhbGciOiJIUzI1.cGF5bG9hZA.c2ln', 'curl -d *** https://x');
  });

  it('leaves an innocent command completely alone', () => {
    const plain = 'git log --oneline -5 && npx vitest run tests/warm-cli-session.test.mjs';
    expect(redactSecrets(plain)).toBe(plain);
  });

  it('redaction runs BEFORE truncation — the ellipsis is never what hides a secret', () => {
    // The credential sits inside the first 60 chars: only the redactor can remove it.
    const cmd = 'curl -u radio:hunter2 https://station.local/api/queue?track=all-the-things';
    const out = renderToolUse({ type: 'tool_use', name: 'Bash', input: { command: cmd } });
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***');
    expect(out.endsWith('…)')).toBe(true);   // still truncated, on the redacted text
  });
});

// A `--resume` WHOSE TARGET THE CLI NO LONGER HAS (operator 2026-09-11). MEASURED against
// claude.exe 2.1.x on this box with a bogus id: exit 1, stderr carries
// "No conversation found with session ID: <id>", and the SAME sentence arrives on STDOUT
// inside the failing result event, as `errors: [...]`:
//   {"type":"result","subtype":"error_during_execution","is_error":true,
//    "session_id":"<id>","errors":["No conversation found with session ID: <id>"], ...}
// Only the stdout copy is ORDERED against that event — stderr is a different pipe, so
// whether its chunk has reached stderrBuf by the time this line is parsed is a scheduler
// race. brainpool.mjs classifies a dead session BY THE THROWN MESSAGE (isDeadSessionError)
// and only then resets the thread and retries fresh, so a message that loses the race
// loses the retry with it and the being fails hard where it should have self-healed.
// These fakes therefore WITHHOLD the stderr copy: the honest worst case.
describe('warm-cli-session — a --resume the CLI cannot honour', () => {
  function deadResumeClaude(id, { alsoOnStderr = false } = {}) {
    let lastProc = null;
    const spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = {
        write: () => {
          setImmediate(() => {
            if (alsoOnStderr) proc.stderr.emit('data', `No conversation found with session ID: ${id}\n`);
            proc.stdout.emit('data', JSON.stringify({
              type: 'result', subtype: 'error_during_execution', is_error: true,
              session_id: id, errors: [`No conversation found with session ID: ${id}`],
            }) + '\n');
          });
        },
        end: () => {},
      };
      lastProc = proc;
      return proc;
    };
    return { spawn, getProc: () => lastProc };
  }

  const DEAD = '00000000-1111-2222-3333-444444444444';

  it('names the missing session from the CLI own stdout errors[], not from a stderr chunk that may not have arrived', async () => {
    const f = deadResumeClaude(DEAD);
    const s = createWarmCliSession({ spawn: f.spawn, sessionId: DEAD });
    const err = await s.turn('hola').then(() => null, (e) => e);
    s.close();
    expect(err).toBeTruthy();
    // THE contract brainpool.mjs depends on to retry fresh instead of failing the being.
    expect(isDeadSessionError(err.message)).toBe(true);
    expect(err.message).toContain(DEAD);
    // …and structurally, so warm-sessions.mjs can report it without sniffing a vendor string.
    expect(err.resumeTargetMissing).toBe(true);
  });

  it('does not duplicate the sentence when stderr DID arrive in time', async () => {
    const f = deadResumeClaude(DEAD, { alsoOnStderr: true });
    const s = createWarmCliSession({ spawn: f.spawn, sessionId: DEAD });
    const err = await s.turn('hola').then(() => null, (e) => e);
    s.close();
    expect(isDeadSessionError(err.message)).toBe(true);
    expect(err.message.match(/No conversation found/g).length).toBe(1);
  });

  it('an ORDINARY failure is not mislabelled a missing resume', async () => {
    const f = fakeClaude({ failOn: 'BAD' });
    const s = createWarmCliSession({ spawn: f.spawn });
    const err = await s.turn('a BAD one').then(() => null, (e) => e);
    s.close();
    expect(err.message).toMatch(/error_during_execution/);
    expect(err.message).toContain('boom');            // the stderr detail is still carried
    expect(err.resumeTargetMissing).toBeFalsy();
  });
});

// /agents stop (operator 2026-10-15). Measured against claude 2.1.301: a stream-json
// `control_request` {subtype:'interrupt'} gets a control_response, the turn then ends with a
// `result` error_during_execution, and the SAME process + session id answer the next turn.
describe('warm-cli-session — interrupt (the CLI own stop)', () => {
  function interruptibleClaude() {
    const lines = [];
    let proc = null;
    const spawn = () => {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.killed = false;
      proc.kill = () => { proc.killed = true; };
      const out = (o) => setImmediate(() => proc.stdout.emit('data', JSON.stringify(o) + '\n'));
      proc.stdin = {
        write: (line) => {
          const o = JSON.parse(line);
          lines.push(o);
          if (o.type === 'control_request') {
            out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { still_queued: [] } } });
            out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
            out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'sess-1' });
            return;
          }
          const text = o.message.content.map((c) => c.text).join('');
          out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
          if (text === 'LONG') return;   // streams forever until interrupted
          out({ type: 'result', subtype: 'success', result: `echo:${text}`, session_id: 'sess-1' });
        },
        end: () => {},
      };
      return proc;
    };
    return { spawn, lines, getProc: () => proc };
  }

  it('writes a control_request interrupt; the turn rejects as INTERRUPTED and the process survives for the next turn', async () => {
    const f = interruptibleClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const turn = s.turn('LONG').then(() => null, (e) => e);
    await new Promise((r) => setImmediate(r));
    const ended = s.interrupt();
    expect(ended).toBeTruthy();
    const err = await turn;
    await ended;
    expect(f.lines.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(err.interrupted).toBe(true);
    expect(f.getProc().killed).toBe(false);
    const next = await s.turn('again');
    expect(next).toEqual({ text: 'echo:again', sessionId: 'sess-1' });
    s.close();
  });

  it('nothing in flight → false, and nothing is written', async () => {
    const f = interruptibleClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    expect(s.interrupt()).toBe(false);
    await s.turn('one');
    const before = f.lines.length;
    expect(s.interrupt()).toBe(false);
    expect(f.lines.length).toBe(before);
    s.close();
  });
});

// A background task finishing after the turn ended (live 2026-10-15: E handed a job to a
// background agent, ended its turn, and the result never reached the chat). Measured on claude
// 2.1.301: background_tasks_changed lists the task while it runs; on completion task_updated,
// task_notification, background_tasks_changed [] — then the CLI STARTS A TURN OF ITS OWN (init …
// result with origin.kind 'task-notification'). With a turn in flight the notification is instead
// absorbed at a tool boundary, replayed as a user line carrying that origin.
// Measured 2026-10-30 on claude 2.1.309 (ED's "every time one reports it finished, the others are
// cut"): an `interrupt` kills every background AGENT still running — task_updated killed, a
// task_notification 'stopped', background_tasks_changed without it — before its control_response.
describe('warm-cli-session — a background task finishes', () => {
  const ORIGIN = { kind: 'task-notification', producer: 'session-task', runId: 'r1' };
  function backgroundClaude() {
    const lines = [];
    const written = [];
    let proc = null;
    let inSelf = false;          // the CLI's own turn is running…
    let owed = false;            // …or queued ahead of any line written now (the CLI keeps FIFO order)
    let running = [];            // the background tasks the CLI lists
    const queued = [];
    const out = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
    const tasks = (list) => { running = list; out({ type: 'system', subtype: 'background_tasks_changed', tasks: list }); };
    const completed = () => {
      out({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } });
      out({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 't1', status: 'completed', output_file: 'b1.output', summary: 'Background command "Run delayed echo" completed (exit code 0)' });
      tasks(running.filter((t) => t.task_id !== 'b1'));
    };
    const answer = (text) => {
      out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
      out({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text }] } });
      if (text === 'START BG') tasks([{ task_id: 'b1', task_type: 'local_bash', description: 'Run delayed echo' }]);
      if (text === 'START TWO') tasks([{ task_id: 'b1', task_type: 'local_bash', description: 'Run delayed echo' }, { task_id: 'b2', task_type: 'local_agent', description: 'Crawl the site' }]);
      if (text === 'ABSORB') {
        completed();
        out({ type: 'user', isReplay: true, origin: ORIGIN, message: { role: 'user', content: '<task-notification>…</task-notification>' } });
      }
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `echo:${text}` } } });
      out({ type: 'result', subtype: 'success', result: `echo:${text}`, session_id: 'sess-1' });
    };
    const endSelf = (result) => { inSelf = false; out(result); for (const t of queued.splice(0)) answer(t); };
    const spawn = () => {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.killed = false;
      proc.kill = () => { proc.killed = true; };
      proc.stdin = {
        write: (line) => {
          const o = JSON.parse(line);
          lines.push(o);
          if (o.type === 'control_request') {
            setImmediate(() => {
              for (const t of running.filter((x) => x.task_type === 'local_agent')) {
                out({ type: 'system', subtype: 'task_updated', task_id: t.task_id, patch: { status: 'killed' } });
                out({ type: 'system', subtype: 'task_notification', task_id: t.task_id, status: 'stopped', summary: t.description });
                tasks(running.filter((x) => x !== t));
              }
              out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { still_queued: queued } } });
              if (!inSelf) return;
              out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
              endSelf({ type: 'result', subtype: 'error_during_execution', is_error: true, origin: ORIGIN, session_id: 'sess-1' });
            });
            return;
          }
          const text = o.message.content.map((c) => c.text).join('');
          written.push(text);
          if (inSelf || owed) queued.push(text); else setImmediate(() => answer(text));
        },
        end: () => {},
      };
      return proc;
    };
    // The task completes with no turn in flight. `initLater`: the CLI's own turn starts a tick
    // after the notification, leaving the gap a new message can land in (measured ~50-100ms).
    // `hold`: that turn runs until the returned function ends it. `text`: its answer ('' — the
    // 0-turn result a notification queued behind another gets, measured 2.1.309).
    const finishBg = ({ initLater = false, hold = false, text = 'self report' } = {}) => {
      completed();
      owed = true;
      let release = null;
      const start = () => {
        owed = false;
        inSelf = true;
        out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
        release = () => {
          if (!inSelf) return;
          if (text) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
          endSelf({ type: 'result', subtype: 'success', result: text, origin: ORIGIN, session_id: 'sess-1' });
        };
        if (!hold) setImmediate(release);
      };
      if (initLater) setImmediate(start); else start();
      return () => release?.();
    };
    // The task completes inside the CLI (its own turn now queued ahead of any new line), but the
    // notification reaches stdout only after the next line is written.
    const finishBgUnseen = () => {
      owed = true;
      return () => {
        completed();
        owed = false;
        inSelf = true;
        out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
        out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'self report' } } });
        endSelf({ type: 'result', subtype: 'success', result: 'self report', origin: ORIGIN, session_id: 'sess-1' });
      };
    };
    return { spawn, lines, written, finishBg, finishBgUnseen, tasks, out };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

  it('THE LIVE FAILURE: no turn in flight — the completion is reported up (not dropped), with the CLI\'s own answer on it', async () => {
    const f = backgroundClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    expect((await s.turn('START BG')).text).toBe('echo:START BG');
    expect(s.background).toBe(1);
    f.finishBg();
    await settle();
    expect(done).toEqual([{ summaries: ['Run delayed echo — completed'], reply: 'self report' }]);
    expect(f.lines.some((o) => o.type === 'control_request')).toBe(false);
    expect(s.background).toBe(0);
    expect(await s.turn('next')).toEqual({ text: 'echo:next', sessionId: 'sess-1' });
    s.close();
  });

  it('ED, live 2026-10-30: one of two background tasks finishes with no turn in flight — nothing is interrupted, the other runs on, the report goes up', async () => {
    const f = backgroundClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    await s.turn('START TWO');
    expect(s.background).toBe(2);
    f.finishBg();
    await settle();
    expect(f.lines.filter((o) => o.type === 'control_request')).toEqual([]);
    expect(s.backgroundTasks.map((t) => t.description)).toEqual(['Crawl the site']);
    expect(s.background).toBe(1);
    expect(done).toEqual([{ summaries: ['Run delayed echo — completed'], reply: 'self report' }]);
    expect(await s.turn('next')).toEqual({ text: 'echo:next', sessionId: 'sess-1' });
    expect(s.backgroundTasks.map((t) => t.description)).toEqual(['Crawl the site']);
    s.close();
  });

  it('a turn asked for WHILE the CLI\'s own turn runs waits for its end, then gets its OWN answer — the report still goes up', async () => {
    const f = backgroundClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    await s.turn('START TWO');
    const release = f.finishBg({ hold: true });
    await settle();
    expect(s.background).toBe(2);                     // the other task, and the CLI's own turn: neither is evictable
    const q = s.turn('Q');
    await settle();
    expect(f.written).toEqual(['START TWO']);          // not written into the CLI's own turn
    expect(done).toEqual([]);
    release();
    expect((await q).text).toBe('echo:Q');
    expect(f.written).toEqual(['START TWO', 'Q']);
    expect(done).toEqual([{ summaries: ['Run delayed echo — completed'], reply: 'self report' }]);
    expect(f.lines.some((o) => o.type === 'control_request')).toBe(false);
    expect(s.background).toBe(1);
    s.close();
  });

  it('the CLI\'s own turn with no answer (an empty result) reports the completion alone', async () => {
    const f = backgroundClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    await s.turn('START BG');
    f.finishBg({ text: '' });
    await settle();
    expect(done).toEqual([{ summaries: ['Run delayed echo — completed'] }]);
    s.close();
  });

  it('names the running background tasks with the time each started (kept across list changes)', async () => {
    const f = backgroundClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const t0 = Date.now();
    await s.turn('START BG');
    expect(s.backgroundTasks).toEqual([{ taskId: 'b1', description: 'Run delayed echo', since: expect.any(Number) }]);
    const since = s.backgroundTasks[0].since;
    expect(since).toBeGreaterThanOrEqual(t0);
    await new Promise((r) => setTimeout(r, 5));
    f.tasks([{ task_id: 'b1', description: 'Run delayed echo' }, { task_id: 'b2', description: 'Crawl' }]);
    expect(s.backgroundTasks.map((t) => t.description)).toEqual(['Run delayed echo', 'Crawl']);
    expect(s.backgroundTasks[0].since).toBe(since);
    expect(s.backgroundTasks[1].since).toBeGreaterThan(since);
    s.close();
  });

  // An #2971, 2026-10-31: "are you listing parent and child process in the same level? in that case why not
  // nest?". claude 2.1.309: parent_task_id — the live background agent that launched the task; ambient — "not
  // activity … hosts should exclude them from activity indicators" (liveness does; this session keeps them).
  it('keeps the agent that launched each task and the CLI\'s ambient mark — an ambient task is still its task: counted, ended with an outcome', async () => {
    const f = backgroundClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('hi');
    f.tasks([
      { task_id: 'a1', task_type: 'local_agent', description: 'Factuwin tests on AWS Windows' },
      { task_id: 'b1', task_type: 'local_bash', description: 'Queue menu calibration job', parent_task_id: 'a1' },
      { task_id: 'w1', task_type: 'monitor_mcp', description: 'Watch the job log', parent_task_id: 'a1', ambient: true },
    ]);
    expect(s.backgroundTasks).toEqual([
      { taskId: 'a1', description: 'Factuwin tests on AWS Windows', since: expect.any(Number) },
      { taskId: 'b1', description: 'Queue menu calibration job', since: expect.any(Number), parentTaskId: 'a1' },
      { taskId: 'w1', description: 'Watch the job log', since: expect.any(Number), parentTaskId: 'a1', ambient: true },
    ]);
    expect(s.background).toBe(3);                     // not evictable while the watcher runs: closing it would kill it
    f.out({ type: 'system', subtype: 'task_updated', task_id: 'w1', patch: { status: 'completed' } });
    f.tasks([{ task_id: 'a1', task_type: 'local_agent', description: 'Factuwin tests on AWS Windows' }, { task_id: 'b1', task_type: 'local_bash', description: 'Queue menu calibration job', parent_task_id: 'a1' }]);
    expect(s.backgroundOutcome('w1')).toMatchObject({ status: 'completed' });
    expect(s.background).toBe(2);
    s.close();
  });

  it('a turn in flight ABSORBS the completion — no report, no stop, the turn answers as usual', async () => {
    const f = backgroundClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    await s.turn('START BG');
    expect((await s.turn('ABSORB')).text).toBe('echo:ABSORB');
    await settle();
    expect(done).toEqual([]);
    expect(f.lines.some((o) => o.type === 'control_request')).toBe(false);
    s.close();
  });

  it('a turn asked for in the gap before the CLI\'s own turn waits behind it, and gets its OWN answer', async () => {
    const f = backgroundClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    await s.turn('START BG');
    f.finishBg({ initLater: true });
    const r = await s.turn('Q');
    expect(r.text).toBe('echo:Q');
    expect(done).toEqual([{ summaries: ['Run delayed echo — completed'], reply: 'self report' }]);
    const types = f.lines.map((o) => (o.type === 'control_request' ? 'interrupt' : o.message.content[0].text));
    expect(types).toEqual(['START BG', 'Q']);
    s.close();
  });

  it('the CLI\'s own turn running ahead of a line already written is never taken as that line\'s answer', async () => {
    const f = backgroundClaude();
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: () => {} });
    await s.turn('START BG');
    const run = f.finishBgUnseen();
    const updates = [];
    const q = s.turn('Q', (t) => updates.push(t));
    await new Promise((r) => setImmediate(r));
    run();
    expect((await q).text).toBe('echo:Q');
    expect(updates.at(-1)).toBe('echo:Q');
    expect((await s.turn('R')).text).toBe('echo:R');
    s.close();
  });

  it('with nobody listening the CLI\'s own turn is left alone — and a turn still waits behind it', async () => {
    const f = backgroundClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('START BG');
    f.finishBg({ initLater: true });
    expect((await s.turn('Q')).text).toBe('echo:Q');
    expect(f.lines.some((o) => o.type === 'control_request')).toBe(false);
    s.close();
  });

  // An #2944, 2026-10-31: "si termina en error (muy raro) debería mostrar una X y el mensaje de error? esto
  // debe ser estructural, no pongas al SI a determinar el error cuando falla el proceso". Shapes from
  // claude 2.1.309: task_notification { status completed|failed|stopped, summary, reason? }; task_updated
  // { patch: { status completed|failed|killed, error? } } just before it.
  it('how a finished task ended is the CLI\'s own verdict: completed bare; failed with its reason, else its summary — one line, redacted, capped', async () => {
    const f = backgroundClaude();
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: () => {} });
    await s.turn('START TWO');
    expect(s.backgroundOutcome('b1')).toBe(null);
    f.finishBg();
    await settle();
    expect(s.backgroundOutcome('b1')).toEqual({ status: 'completed', message: null, at: expect.any(Number) });
    f.tasks([{ task_id: 'b2', task_type: 'local_agent', description: 'Crawl the site' }, { task_id: 'b3', task_type: 'local_bash', description: 'Run the lint' }]);
    f.out({ type: 'system', subtype: 'task_updated', task_id: 'b3', patch: { status: 'failed' } });
    f.out({ type: 'system', subtype: 'task_notification', task_id: 'b3', status: 'failed', summary: `Background command "Run the lint"\n  failed (exit code 1): API_TOKEN=s3cr3t ${'x'.repeat(300)}` });
    f.out({ type: 'system', subtype: 'task_notification', task_id: 'b2', status: 'failed', summary: 'Agent failed', reason: 'API Error: 529 overloaded' });
    f.tasks([]);
    const lint = s.backgroundOutcome('b3');
    expect(lint.status).toBe('failed');
    expect(lint.message).toMatch(/^Background command "Run the lint" failed \(exit code 1\): API_TOKEN=\*\*\* x+…$/);
    expect(lint.message).toHaveLength(200);
    expect(lint.message).not.toContain('s3cr3t');
    expect(s.backgroundOutcome('b2')).toMatchObject({ status: 'failed', message: 'API Error: 529 overloaded' });
    expect(s.backgroundTasks).toEqual([]);
    s.close();
  });

  it('no notification follows: the task_updated status stands — killed is stopped, failed keeps its error; the last 50 are kept', async () => {
    const f = backgroundClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('START TWO');
    f.out({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'failed', error: 'spawn ENOENT' } });
    f.out({ type: 'system', subtype: 'task_updated', task_id: 'b2', patch: { status: 'killed' } });
    f.tasks([]);
    expect(s.backgroundOutcome('b1')).toMatchObject({ status: 'failed', message: 'spawn ENOENT' });
    expect(s.backgroundOutcome('b2')).toMatchObject({ status: 'stopped', message: null });
    const many = Array.from({ length: 50 }, (_, i) => ({ task_id: `m${i}`, task_type: 'local_bash', description: `job ${i}` }));
    f.tasks(many);
    for (const t of many) f.out({ type: 'system', subtype: 'task_updated', task_id: t.task_id, patch: { status: 'completed' } });
    f.tasks([]);
    expect(s.backgroundOutcome('b1')).toBe(null);
    expect(s.backgroundOutcome('b2')).toBe(null);
    expect(s.backgroundOutcome('m0')).toMatchObject({ status: 'completed' });
    expect(s.backgroundOutcome('m49')).toMatchObject({ status: 'completed' });
    s.close();
  });
});

// A background subagent's output is not the being's reply (live 2026-10-16/17, wren). Shapes recorded
// from claude 2.1.301: a subagent's events carry parent_tool_use_id = its Agent call's id (plus
// agent_id); the being's own carry parent_tool_use_id null. Recorded order: subagent text interleaves
// a top-level turn before that turn's own text streams.
describe('warm-cli-session — a background subagent\'s text never reaches the reply', () => {
  const AGENT = 'toolu_01KKNHY19qtXLKgQzS7RzR5e';
  const ORIGIN = { kind: 'task-notification', producer: 'session-task', runId: 'r1' };
  const sub = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: AGENT, agent_id: 'a1', subagent_type: 'general-purpose', task_description: 'counter' });
  const top = (content) => ({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null });
  const delta = (text, ptu = null) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }, parent_tool_use_id: ptu });
  const LEAKS = ['I\'ll start by orienting in the worktree.', 'Noted the refined config shape', 'SUBAGENT_ACK', 'SUBAGENT_DELTA', 'SUBAGENT_LATE'];
  function subagentClaude() {
    const lines = [];
    let proc = null;
    const out = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
    const opener = (text) => { out({ type: 'system', subtype: 'init', session_id: 'sess-1' }); out({ type: 'user', isReplay: true, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }); };
    const finish = (text) => { out(delta(text.slice(0, 6))); out(delta(text.slice(6))); out(top([{ type: 'text', text }])); out({ type: 'result', subtype: 'success', result: text, session_id: 'sess-1' }); };
    const turns = {
      START: () => {
        opener('START');
        out(top([{ type: 'tool_use', id: AGENT, name: 'Agent', input: { description: 'counter', run_in_background: true, prompt: 'p' } }]));
        out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'counter' }] });
        out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT, content: 'launched' }] } });
        out(sub(LEAKS[0]));
        finish('TOP_REPLY_1');
      },
      SEND: () => {
        opener('SEND');
        out({ type: 'user', parent_tool_use_id: AGENT, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'x' }] } });
        out(top([{ type: 'tool_use', id: 'ts', name: 'ToolSearch', input: { query: 'select:SendMessage' } }]));
        out(sub(`${LEAKS[1]} (\`superchats\` block). Continuing the outbreak investigation first.`));
        out(top([{ type: 'tool_use', id: 'sm', name: 'SendMessage', input: { to: 'a1', message: 'refined shape' } }]));
        out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sm', content: 'sent' }] } });
        out(sub(LEAKS[2]));
        out(delta(LEAKS[3], AGENT));   // not seen on 2.1.301 (subagents send whole messages); same rule
        finish('TOP_REPLY_2');
      },
    };
    const spawn = () => {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.killed = false;
      proc.kill = () => { proc.killed = true; };
      proc.stdin = {
        write: (line) => {
          const o = JSON.parse(line);
          lines.push(o);
          if (o.type === 'control_request') {
            setImmediate(() => {
              out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id } });
              out({ type: 'result', subtype: 'error_during_execution', is_error: true, origin: ORIGIN, session_id: 'sess-1' });
            });
            return;
          }
          const text = o.message.content.map((c) => c.text).join('');
          setImmediate(() => (turns[text] ?? (() => { opener(text); finish(`echo:${text}`); }))());
        },
        end: () => {},
      };
      return proc;
    };
    // The subagent's last words with no turn in flight, then its completion: the CLI's own turn.
    const subagentDone = () => {
      out(sub(LEAKS[4]));
      out({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: AGENT, status: 'completed', summary: LEAKS[4] });
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
      out(sub('SUBAGENT_IN_SELF_TURN'));
      setImmediate(() => { out(top([{ type: 'text', text: 'SELF_REPORT' }])); out({ type: 'result', subtype: 'success', result: 'SELF_REPORT', origin: ORIGIN, session_id: 'sess-1' }); });
    };
    return { spawn, lines, subagentDone };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const leaked = (texts) => texts.filter((t) => LEAKS.some((l) => t.includes(l)));

  it('THE LIVE CASE: streamed previews and the final text carry only the being\'s own words', async () => {
    const s = createWarmCliSession({ spawn: subagentClaude().spawn });
    const u1 = [];
    const r1 = await s.turn('START', (t, use) => use || u1.push(t));   // text updates only, not the tool signal
    expect(u1).toEqual(['TOP_RE', 'TOP_REPLY_1']);
    expect(r1.text).toBe('TOP_REPLY_1');
    const u2 = [];
    const r2 = await s.turn('SEND', (t, use) => use || u2.push(t));
    expect(u2).toEqual(['TOP_RE', 'TOP_REPLY_2']);
    expect(r2.text).toBe('TOP_REPLY_2');
    s.close();
  });

  it('verboseThinking ON: the being\'s own tool stubs and text, none of the subagent\'s', async () => {
    const s = createWarmCliSession({ spawn: subagentClaude().spawn, verboseThinking: true });
    const u = [];
    expect((await s.turn('START', (t) => u.push(t))).text).toBe('Agent(counter)\n\nTOP_REPLY_1');
    expect((await s.turn('SEND', (t) => u.push(t))).text).toBe('ToolSearch(select:SendMessage)\n\nSendMessage(a1)\n\nTOP_REPLY_2');
    expect(leaked(u)).toEqual([]);
    s.close();
  });

  it('background bookkeeping is unchanged: the task is tracked, its completion wakes the being, the next turn is clean', async () => {
    const f = subagentClaude();
    const done = [];
    const s = createWarmCliSession({ spawn: f.spawn, onBackgroundDone: (i) => done.push(i) });
    const r1 = await s.turn('START');
    expect(r1.bgStarted).toBe(1);
    expect(s.backgroundTasks).toEqual([{ taskId: 'a1', description: 'counter', since: expect.any(Number) }]);
    await s.turn('SEND');
    expect(s.background).toBe(1);
    f.subagentDone();
    await settle();
    expect(done).toEqual([{ summaries: ['counter — completed'], reply: 'SELF_REPORT' }]);
    expect(f.lines.some((o) => o.type === 'control_request')).toBe(false);
    expect(s.background).toBe(0);
    const u = [];
    expect(await s.turn('NEXT', (t) => u.push(t))).toEqual({ text: 'echo:NEXT', sessionId: 'sess-1' });
    expect(leaked(u)).toEqual([]);
    s.close();
  });
});

// THE CLI'S OWN VERDICT (operator 2026-10-16: failure is structural, never the reply text). An API
// error ends a turn as subtype "success" with is_error:true. MEASURED on claude 2.1.301 with an
// invalid token: {"type":"result","subtype":"success","is_error":true,"api_error_status":401,
// "terminal_reason":"api_error","result":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}.
// The other texts are what the CLI's own transcripts record as isApiErrorMessage (529, 403, 429, safeguards).
describe('warm-cli-session — is_error marks the turn failed', () => {
  function fakeResult(result) {
    const spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = { write: () => { setImmediate(() => proc.stdout.emit('data', JSON.stringify({ type: 'result', session_id: 's1', ...result }) + '\n')); }, end: () => {} };
      return proc;
    };
    return createWarmCliSession({ spawn });
  }

  it('the measured 401 result resolves failed, with the CLI\'s reason', async () => {
    const s = fakeResult({ subtype: 'success', is_error: true, api_error_status: 401, terminal_reason: 'api_error', result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' });
    const r = await s.turn('hi');
    expect(r).toMatchObject({ failed: true, failReason: 'is_error api_error 401', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' });
    s.close();
  });

  it('every real API-error text the CLI records is failed through the flag', async () => {
    for (const [status, text] of [
      [529, 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'],
      [403, 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead'],
      [429, "You've hit your session limit · resets 6:30pm (America/New_York)"],
      [undefined, "API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup)."],
      [undefined, 'Login expired · Please run /login'],
    ]) {
      const s = fakeResult({ subtype: 'success', is_error: true, api_error_status: status, terminal_reason: 'api_error', result: text });
      expect((await s.turn('hi')).failed, text).toBe(true);
      s.close();
    }
  });

  it('is_error with normal-looking text is still failed; a reply about a 403 without it is not', async () => {
    const a = fakeResult({ subtype: 'success', is_error: true, result: 'Listo, ya está.' });
    expect((await a.turn('hi')).failed).toBe(true);
    a.close();
    const b = fakeResult({ subtype: 'success', is_error: false, result: 'Ahora responde 403.\nRequire all denied' });
    const r = await b.turn('hi');
    expect(r.text).toBe('Ahora responde 403.\nRequire all denied');
    expect(r).not.toHaveProperty('failed');
    b.close();
  });
});
