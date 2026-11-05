import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundAgentEnvOf } from '../src/background-agents.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { createSandboxCliSession } from '../src/sandbox-cli-session.mjs';

function fakeSpawn() {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.kill = () => {};
    proc.stdin = { write: () => setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n');
      proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\n');
    }), end: () => {} };
    return proc;
  };
  return { spawn, calls };
}

describe('backgroundAgentEnvOf', () => {
  it('the node default sets both vars', () => {
    expect(backgroundAgentEnvOf({ model: 'sonnet', effort: 'medium' }, undefined)).toEqual([
      'CLAUDE_CODE_SUBAGENT_MODEL=sonnet', 'CLAUDE_CODE_SUBAGENT_EFFORT=medium']);
  });
  it('a per-agent override wins, key by key', () => {
    expect(backgroundAgentEnvOf({ model: 'sonnet', effort: 'medium' }, { effort: 'high' })).toEqual([
      'CLAUDE_CODE_SUBAGENT_MODEL=sonnet', 'CLAUDE_CODE_SUBAGENT_EFFORT=high']);
  });
  it('unset means no vars', () => {
    expect(backgroundAgentEnvOf(undefined, undefined)).toEqual([]);
    expect(backgroundAgentEnvOf({}, null)).toEqual([]);
  });
  it('an invalid value is ignored and logged once, never throws', () => {
    const logs = [];
    const run = () => backgroundAgentEnvOf({ model: 'gpt-9', effort: 'low' }, 'junk', (l) => logs.push(l));
    expect(run()).toEqual(['CLAUDE_CODE_SUBAGENT_EFFORT=low']);
    run();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/background_agents\.model.*gpt-9/);
  });
  it('an invalid per-agent value falls back to the node default', () => {
    expect(backgroundAgentEnvOf({ effort: 'low' }, { effort: 'ultra-bad' })).toEqual(['CLAUDE_CODE_SUBAGENT_EFFORT=low']);
  });
});

describe('spawn env', () => {
  const ENV = ['CLAUDE_CODE_SUBAGENT_MODEL=haiku', 'CLAUDE_CODE_SUBAGENT_EFFORT=low'];
  it('an unboxed spawn carries the vars', async () => {
    const f = fakeSpawn();
    const s = createWarmCliSession({ spawn: f.spawn, backgroundAgentEnv: ENV });
    await s.turn('hi'); s.close();
    expect(f.calls[0].opts.env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_EFFORT: 'low' });
  });
  it('an unboxed spawn without them passes no env override', async () => {
    const f = fakeSpawn();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('hi'); s.close();
    expect(f.calls[0].opts.env).toBeUndefined();
  });
  it('a boxed spawn gets them in -SetEnv', async () => {
    const f = fakeSpawn();
    const s = createSandboxCliSession({ spawn: f.spawn, cwd: process.cwd(), platform: 'win32', sandboxOauthToken: 'tok', jsonlStoreRoot: mkdtempSync(join(tmpdir(), 'bga-')), backgroundAgentEnv: ENV });
    await s.turn('hi'); s.close();
    const a = f.calls[0].args;
    expect(JSON.parse(a[a.indexOf('-SetEnv') + 1])).toEqual(expect.arrayContaining(ENV));
    expect(f.calls[0].opts.env).toBeUndefined();
  });
});
