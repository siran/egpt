// Agent-tool registry: the SAFETY logic (permission resolution, sandbox path
// confinement, deny/ask/allow gating) — the parts that must be right because
// an unleashed local model won't self-refuse. Executors that hit fs/network
// are exercised only through the gate with mocked ctx.
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toolMode, confinePath, agentToolSchemas, runAgentTool, AGENT_TOOLS,
} from '../src/tools/agent-tools.mjs';

describe('toolMode resolution', () => {
  it('explicit entry wins', () => {
    expect(toolMode({ read_file: 'allow', default: 'deny' }, 'read_file')).toBe('allow');
  });
  it('falls back to default', () => {
    expect(toolMode({ default: 'deny' }, 'bash')).toBe('deny');
  });
  it('defaults to ask when nothing set', () => {
    expect(toolMode({}, 'whatever')).toBe('ask');
    expect(toolMode(undefined, 'whatever')).toBe('ask');
  });
  it('invalid mode falls back to ask', () => {
    expect(toolMode({ bash: 'yolo' }, 'bash')).toBe('ask');
  });
});

describe('confinePath', () => {
  const root = join(tmpdir(), 'egpt-sandbox-test');
  it('allows paths inside the sandbox', () => {
    expect(confinePath(root, 'notes.md')).toBe(join(root, 'notes.md'));
    expect(confinePath(root, 'sub/dir/f.txt')).toBe(join(root, 'sub', 'dir', 'f.txt'));
    expect(confinePath(root, '.')).toBe(root);
  });
  it('rejects .. escapes', () => {
    expect(() => confinePath(root, '../secret')).toThrow(/escapes sandbox/);
    expect(() => confinePath(root, '../../etc/passwd')).toThrow(/escapes sandbox/);
    expect(() => confinePath(root, 'a/../../b')).toThrow(/escapes sandbox/);
  });
  it('rejects absolute paths outside the root', () => {
    expect(() => confinePath(root, '/etc/passwd')).toThrow(/escapes sandbox/);
  });
});

describe('agentToolSchemas', () => {
  it('hides denied tools from the model', () => {
    const names = agentToolSchemas({ default: 'allow', bash: 'deny', send_message: 'deny' })
      .map(s => s.function.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('send_message');
  });
  it('all-deny default hides everything', () => {
    expect(agentToolSchemas({ default: 'deny' })).toHaveLength(0);
  });
});

describe('runAgentTool gating', () => {
  it('blocks denied tools without running', async () => {
    const r = await runAgentTool('send_message', { chat: 'x', text: 'hi' },
      { toolsCfg: { send_message: 'deny' }, sendMessage: () => { throw new Error('should not run'); } });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/denied/);
  });
  it('ask mode requires approval', async () => {
    let sent = false;
    const ctx = { toolsCfg: { send_message: 'ask' }, sendMessage: async () => { sent = true; }, confirm: async () => false };
    const r = await runAgentTool('send_message', { chat: 'x', text: 'hi' }, ctx);
    expect(r.ok).toBe(false);
    expect(sent).toBe(false);
    expect(r.result).toMatch(/not approved/);
  });
  it('ask mode runs when approved', async () => {
    let sentTo = null;
    const ctx = { toolsCfg: { send_message: 'ask' }, sendMessage: async (c) => { sentTo = c; }, confirm: async () => true };
    const r = await runAgentTool('send_message', { chat: 'jid1', text: 'hi' }, ctx);
    expect(r.ok).toBe(true);
    expect(sentTo).toBe('jid1');
  });
  it('allow mode runs directly', async () => {
    let sentTo = null;
    const r = await runAgentTool('send_message', { chat: 'jid2', text: 'yo' },
      { toolsCfg: { send_message: 'allow' }, sendMessage: async (c) => { sentTo = c; } });
    expect(r.ok).toBe(true);
    expect(sentTo).toBe('jid2');
  });
  it('unknown tool is rejected', async () => {
    const r = await runAgentTool('rm_rf', { path: '/' }, { toolsCfg: { default: 'allow' } });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/unknown tool/);
  });
  it('sandbox escape surfaces as an error result, not a throw', async () => {
    const r = await runAgentTool('read_file', { path: '../../../etc/passwd' },
      { toolsCfg: { read_file: 'allow' }, sandboxRoot: join(tmpdir(), 'egpt-sandbox-test') });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/escapes sandbox/);
  });
});

describe('registry shape', () => {
  it('Phase-1 tools all carry an OpenAI function schema', () => {
    for (const [name, t] of Object.entries(AGENT_TOOLS)) {
      expect(t.schema.type).toBe('function');
      expect(t.schema.function.name).toBe(name);
      expect(typeof t.run).toBe('function');
    }
  });
});
