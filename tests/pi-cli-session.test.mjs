import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPiCliSession } from '../src/pi-cli-session.mjs';

// A fake `pi --mode rpc` process: JSONL commands in on stdin, JSONL events out.
function fakePi() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.sent = [];
  proc.stdin = { write: (s) => { proc.sent.push(s); return true; }, end() {} };
  proc.kill = vi.fn();
  proc.emitEvent = (o) => proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  proc.textDelta = (delta) => proc.emitEvent({
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
  });
  return proc;
}
const spawnFake = (proc) => vi.fn(() => proc);

describe('pi cli session (rpc mode)', () => {
  it('satisfies the pool contract', () => {
    const s = createPiCliSession({ spawn: spawnFake(fakePi()) });
    expect(s).toHaveProperty('turn');
    expect(s).toHaveProperty('close');
    expect(s).toHaveProperty('sessionId');
  });

  it('sends a prompt command as one JSONL line', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('hola');
    const line = proc.sent.join('');
    expect(line.endsWith('\n')).toBe(true);
    const cmd = JSON.parse(line.trim());
    expect(cmd.type).toBe('prompt');
    expect(cmd.message).toBe('hola');
    proc.textDelta('hi'); proc.emitEvent({ type: 'agent_settled' });
    await p;
  });

  it('accumulates text_delta and resolves on agent_settled', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    proc.textDelta('Hello '); proc.textDelta('world');
    proc.emitEvent({ type: 'agent_end' });        // NOT terminal — retry/compaction may follow
    proc.emitEvent({ type: 'agent_settled' });
    expect(await p).toEqual({ text: 'Hello world', sessionId: null });
  });

  it('does not resolve on agent_end alone', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    let done = false;
    const p = s.turn('go').then((r) => { done = true; return r; });
    proc.textDelta('partial');
    proc.emitEvent({ type: 'agent_end' });
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);                      // still waiting — agent_end is not settled
    proc.textDelta(' more');
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('partial more');
  });

  it('streams partials to onUpdate cumulatively', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const seen = [];
    const p = s.turn('go', (t) => seen.push(t));
    proc.textDelta('a'); proc.textDelta('b');
    proc.emitEvent({ type: 'agent_settled' });
    await p;
    expect(seen).toEqual(['a', 'ab']);
  });

  it('splits records on LF ONLY — U+2028 inside a JSON string is not a delimiter', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    // Node readline would split this line at U+2028 and corrupt the record.
    proc.textDelta('line break');
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('line break');
  });

  it('tolerates CRLF and split/coalesced chunks', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    const ev = JSON.stringify({ type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'chunked' } });
    proc.stdout.emit('data', Buffer.from(ev.slice(0, 20)));         // partial record
    proc.stdout.emit('data', Buffer.from(ev.slice(20) + '\r\n'));   // rest, CRLF terminated
    proc.emitEvent({ type: 'agent_settled' });
    expect((await p).text).toBe('chunked');
  });

  it('refuses a concurrent turn and a turn after close', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('one');
    await expect(s.turn('two')).rejects.toThrow(/already in flight/);
    proc.emitEvent({ type: 'agent_settled' });
    await p;
    s.close();
    expect(proc.kill).toHaveBeenCalled();
    await expect(s.turn('three')).rejects.toThrow(/closed/);
  });

  it('rejects the in-flight turn when pi dies', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const p = s.turn('go');
    proc.stderr.emit('data', Buffer.from('boom'));
    proc.emit('exit', 1);
    await expect(p).rejects.toThrow(/pi-cli/);
  });

  it('is WARM: one resident process serves many turns', async () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    const s = createPiCliSession({ spawn });

    const t1 = s.turn('first');
    proc.textDelta('one'); proc.emitEvent({ type: 'agent_settled' });
    expect((await t1).text).toBe('one');

    const t2 = s.turn('second');
    proc.textDelta('two'); proc.emitEvent({ type: 'agent_settled' });
    expect((await t2).text).toBe('two');

    // ONE spawn for both turns — the process, and with it pi's conversation
    // state and llama-server's prompt prefix, stay warm between turns.
    expect(spawn).toHaveBeenCalledTimes(1);
    // Both prompts went down the same stdin, with distinct correlation ids.
    const cmds = proc.sent.map((l) => JSON.parse(l.trim()));
    expect(cmds.map((c) => c.message)).toEqual(['first', 'second']);
    expect(new Set(cmds.map((c) => c.id)).size).toBe(2);
  });

  it('accumulator resets between turns — no bleed from the previous reply', async () => {
    const proc = fakePi();
    const s = createPiCliSession({ spawn: spawnFake(proc) });
    const t1 = s.turn('a');
    proc.textDelta('AAA'); proc.emitEvent({ type: 'agent_settled' });
    await t1;
    const t2 = s.turn('b');
    proc.textDelta('BBB'); proc.emitEvent({ type: 'agent_settled' });
    expect((await t2).text).toBe('BBB');
  });

  it('passes provider and model through to the spawn', () => {
    const proc = fakePi();
    const spawn = spawnFake(proc);
    createPiCliSession({ spawn, provider: 'reve', model: 'local', bin: 'pi-test' }).turn('x');
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('pi-test');
    expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--provider', 'reve', '--model', 'local']));
  });
});
