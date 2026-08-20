import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createCodexCliSession, codexThreadParams, codexTurnParams } from '../src/codex-cli-session.mjs';

function fakeAppServer() {
  const messages = [];
  let spawnArgs = [];
  let spawnCount = 0;
  let proc;
  const emit = (msg) => setImmediate(() => proc.stdout.emit('data', `${JSON.stringify(msg)}\n`));
  const spawn = (_bin, args) => {
    spawnCount++;
    spawnArgs = args;
    proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; };
    proc.stdin = { write(line) {
      const msg = JSON.parse(line); messages.push(msg);
      if (msg.method === 'initialize') emit({ id: msg.id, result: { userAgent: 'test' } });
      if (msg.method === 'thread/start') emit({ id: msg.id, result: { thread: { id: 'codex-thread-1' } } });
      if (msg.method === 'thread/resume') emit({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      if (msg.method === 'turn/start') {
        emit({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        emit({ method: 'item/started', params: { item: { id: 'a1', type: 'agentMessage', phase: 'final_answer' } } });
        emit({ method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'reply:' } });
        emit({ method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: msg.params.input[0].text } });
        emit({ method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: `reply:${msg.params.input[0].text}` } } });
        emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
      }
      return true;
    }, end() {} };
    return proc;
  };
  return { spawn, messages, getProc: () => proc, getSpawnArgs: () => spawnArgs, spawnCount: () => spawnCount };
}

describe('codex-cli-session — resident app-server', () => {
  it('keeps one Codex process warm across turns and captures its thread id', async () => {
    const f = fakeAppServer();
    const s = createCodexCliSession({ spawn: f.spawn, bin: 'codex-test', model: 'gpt-5.6-luna', effort: 'low' });
    const updates = [];
    const one = await s.turn('ONE', (t) => updates.push(t));
    const two = await s.turn('TWO');
    expect(one).toEqual({ text: 'reply:ONE', sessionId: 'codex-thread-1' });
    expect(two.text).toBe('reply:TWO');
    expect(f.spawnCount()).toBe(1);
    expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(1);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(2);
    expect(updates.at(-1)).toBe('reply:ONE');
    s.close();
  });

  it('resumes a recorded thread when a new resident process opens', async () => {
    const f = fakeAppServer();
    const s = createCodexCliSession({ spawn: f.spawn, bin: 'codex-test', sessionId: 'existing-thread' });
    await s.turn('hello');
    expect(f.messages.find((m) => m.method === 'thread/resume')?.params.threadId).toBe('existing-thread');
    s.close();
  });

  it('maps regular to workspace-write and all to danger-full-access', () => {
    expect(codexThreadParams({}).sandbox).toBe('workspace-write');
    expect(codexTurnParams({}, 't', 'x').sandboxPolicy.type).toBe('workspaceWrite');
    expect(codexThreadParams({ dangerouslySkipPermissions: true }).sandbox).toBe('danger-full-access');
    expect(codexTurnParams({ dangerouslySkipPermissions: true }, 't', 'x').sandboxPolicy.type).toBe('dangerFullAccess');
  });

  it('installs developer instructions on the resident process and close stops it', async () => {
    const f = fakeAppServer();
    const s = createCodexCliSession({ spawn: f.spawn, bin: 'codex-test', appendSystemPrompt: 'SYSTEM' });
    await s.turn('hello');
    const turn = f.messages.find((m) => m.method === 'turn/start');
    expect(turn.params.input[0].text).toBe('hello');
    expect(f.getSpawnArgs().join(' ')).toContain('developer_instructions="SYSTEM"');
    s.close();
    expect(f.getProc().killed).toBe(true);
    await expect(s.turn('again')).rejects.toThrow(/closed/);
  });
});
