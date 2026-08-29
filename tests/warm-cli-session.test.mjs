// Locks the Unit 4 warm-CLI primitive (operator 2026-06-13): ONE resident
// `claude` process answers many turns (residency = warmth), captures the minted
// session id, streams text deltas, and fails the in-flight turn on an error
// result or a mid-turn process crash. Uses an injectable fake `claude` that
// speaks stream-json — no real CLI / network.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';

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

  it('close() ends the process and refuses further turns', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('ONE');
    s.close();
    expect(f.getProc().killed).toBe(true);
    await expect(s.turn('TWO')).rejects.toThrow(/closed/);
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

  it('ON: thinking verbatim + ToolName() stubs + final text, in order, no tool input/output', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const r = await s.turn('what is in the dir?');
    expect(r.text).toBe(
      'THINK1: let me check the directory\n\nBash()\n\nTHINK2: now I can answer\n\nHello'
    );
    expect(r.text).not.toContain('ls -la');       // tool_use input never included
    expect(r.text).not.toContain('DIRLISTING');    // tool_result content never included
    s.close();
  });

  it('the live onUpdate preview is identical in both modes (text-delta-only, unchanged)', async () => {
    const updatesOff = [];
    const sOff = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn });
    await sOff.turn('x', (t) => updatesOff.push(t));
    sOff.close();

    const updatesOn = [];
    const sOn = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    await sOn.turn('x', (t) => updatesOn.push(t));
    sOn.close();

    expect(updatesOff).toEqual(['Hel', 'Hello']);
    expect(updatesOn).toEqual(updatesOff);
  });
});
