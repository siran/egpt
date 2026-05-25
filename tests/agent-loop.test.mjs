// The ReAct loop: with the model mocked, verify it executes tool_calls through
// the (real, gated) registry, feeds results back, loops, and terminates on a
// plain reply or the iteration cap.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatWithTools = vi.fn();
vi.mock('../config/brains/llama.mjs', () => ({ chatWithTools: (...a) => chatWithTools(...a) }));

const { runAgentLoop } = await import('../src/tools/agent-loop.mjs');

const toolCall = (name, args) => ({ id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } });

beforeEach(() => { chatWithTools.mockReset(); });

describe('runAgentLoop', () => {
  it('returns a plain reply with no tool calls', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'just chatting', toolCalls: [] });
    const out = await runAgentLoop({ userText: 'hi', toolsCfg: { default: 'allow' } });
    expect(out).toBe('just chatting');
    expect(chatWithTools).toHaveBeenCalledTimes(1);
  });

  it('executes an allowed tool, feeds the result back, then returns the reply', async () => {
    let sentTo = null;
    chatWithTools
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('send_message', { chat: 'jidX', text: 'yo' })] })
      .mockResolvedValueOnce({ content: 'done, told them', toolCalls: [] });
    const out = await runAgentLoop({
      userText: 'tell jidX yo',
      toolsCfg: { send_message: 'allow' },
      sendMessage: async (c) => { sentTo = c; },
    });
    expect(sentTo).toBe('jidX');
    expect(out).toBe('done, told them');
    // 2nd model call must include the tool result in the conversation.
    const secondCallMsgs = chatWithTools.mock.calls[1][0].messages;
    expect(secondCallMsgs.some(m => m.role === 'tool' && /sent to jidX/.test(m.content))).toBe(true);
  });

  it('a denied tool returns a gate error to the model (does not run)', async () => {
    let ran = false;
    chatWithTools
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('send_message', { chat: 'x', text: 'hi' })] })
      .mockResolvedValueOnce({ content: 'ok, blocked', toolCalls: [] });
    await runAgentLoop({
      userText: 'send', toolsCfg: { send_message: 'deny' },
      sendMessage: async () => { ran = true; },
    });
    expect(ran).toBe(false);
    const fedBack = chatWithTools.mock.calls[1][0].messages.find(m => m.role === 'tool');
    expect(fedBack.content).toMatch(/denied/);
  });

  it('terminates at the iteration cap when the model keeps calling tools', async () => {
    chatWithTools.mockResolvedValue({ content: 'thinking', toolCalls: [toolCall('list_dir', { path: '.' })] });
    const out = await runAgentLoop({
      userText: 'loop forever', toolsCfg: { list_dir: 'allow' },
      sandboxRoot: '/nonexistent-sandbox', maxIters: 3,
    });
    expect(chatWithTools).toHaveBeenCalledTimes(3);   // capped
    expect(typeof out).toBe('string');
  });
});
