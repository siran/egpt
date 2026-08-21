import { describe, it, expect, vi } from 'vitest';
import { createLlamaHttpSession } from '../src/llama-http-session.mjs';

// The llama brain is HTTP + SESSIONLESS, so this session is the odd one out
// among engines: no child process to spawn, no stdio framing, no server-side
// thread id. What it must still honour is the pool's contract —
// turn(message, onUpdate) -> { text, sessionId } · close() · sessionId.

// config/brains/llama.mjs resolves { text, optionsPatch } — NOT a bare string.
// An earlier double here returned a string, so String(result) silently produced
// "[object Object]" in the live node while every test stayed green.
const okStream = (text) => vi.fn(async (_payload, onUpdate) => {
  onUpdate?.(text);
  return { text, optionsPatch: null };
});

describe('llama http session', () => {
  it('satisfies the pool contract', () => {
    const s = createLlamaHttpSession({ stream: okStream('hi') });
    expect(s).toHaveProperty('turn');
    expect(s).toHaveProperty('close');
    expect(s).toHaveProperty('sessionId');
  });

  it('returns the streamed text and a null sessionId (no server-side thread)', async () => {
    const s = createLlamaHttpSession({ stream: okStream('hola') });
    expect(await s.turn('hi')).toEqual({ text: 'hola', sessionId: null });
  });

  it('forwards url and model to the brain, and streams partials to onUpdate', async () => {
    const stream = okStream('partial');
    const s = createLlamaHttpSession({ stream, url: 'http://127.0.0.1:8080', model: 'gemma' });
    const seen = [];
    await s.turn('hey', (t) => seen.push(t));
    expect(seen).toEqual(['partial']);
    const [payload, , opts] = stream.mock.calls[0];
    expect(payload.message).toBe('hey');
    expect(opts.url).toBe('http://127.0.0.1:8080');
    expect(opts.model).toBe('gemma');
  });

  it('leaves history UNDEFINED when unset, so the brain falls back to message', async () => {
    // Regression lock: `history: []` is not nullish, so the brain's
    // `String(history ?? message)` yielded '' and every prompt went out empty.
    const stream = okStream('ok');
    const s = createLlamaHttpSession({ stream });
    await s.turn('the actual question');
    const [payload] = stream.mock.calls[0];
    expect(payload.history).toBeUndefined();
    expect(payload.message).toBe('the actual question');
  });

  it('refuses a second concurrent turn — the pool serializes per key', async () => {
    let release;
    const pending = new Promise((r) => { release = () => r({ text: 'done', optionsPatch: null }); });
    const stream = vi.fn().mockReturnValueOnce(pending)
                          .mockResolvedValue({ text: 'later', optionsPatch: null });
    const s = createLlamaHttpSession({ stream });
    const first = s.turn('one');
    await expect(s.turn('two')).rejects.toThrow(/already in flight/);
    release();
    await expect(first).resolves.toEqual({ text: 'done', sessionId: null });
    // guard released -> the next turn runs normally
    await expect(s.turn('three')).resolves.toEqual({ text: 'later', sessionId: null });
  });

  it('refuses a turn after close', async () => {
    const s = createLlamaHttpSession({ stream: okStream('x') });
    s.close();
    await expect(s.turn('hi')).rejects.toThrow(/closed/);
  });

  it('releases the in-flight guard when the brain throws', async () => {
    const stream = vi.fn().mockRejectedValueOnce(new Error('llama-server HTTP 500'))
                          .mockResolvedValueOnce({ text: 'recovered', optionsPatch: null });
    const s = createLlamaHttpSession({ stream });
    await expect(s.turn('boom')).rejects.toThrow(/HTTP 500/);
    await expect(s.turn('again')).resolves.toEqual({ text: 'recovered', sessionId: null });
  });
});

// AGENTIC mode: @l stops being a chatter and runs eGPT's own ReAct loop
// (src/tools/agent-loop.mjs) against the permission-gated tool registry.
// Gated by config local_llm.agentic; OFF keeps it a pure chatter.
describe('llama http session — agentic mode', () => {
  it('uses the chat stream when agentic is off', async () => {
    const stream = vi.fn(async () => ({ text: 'chatted', optionsPatch: null }));
    const agentLoop = vi.fn(async () => 'looped');   // the LOOP returns a plain string
    const s = createLlamaHttpSession({ stream, agentLoop, agentic: false });
    expect(await s.turn('hi')).toEqual({ text: 'chatted', sessionId: null });
    expect(agentLoop).not.toHaveBeenCalled();
  });

  it('routes through the agent loop when agentic is on', async () => {
    const stream = vi.fn(async () => ({ text: 'chatted', optionsPatch: null }));
    const agentLoop = vi.fn(async () => 'looped');
    const s = createLlamaHttpSession({
      stream, agentLoop, agentic: true,
      toolsCfg: { read_file: 'allow' }, sandboxRoot: '/tmp/sbx',
      url: 'http://127.0.0.1:8080', model: 'gemma', agenticMaxIters: 5,
    });
    expect(await s.turn('read a file')).toEqual({ text: 'looped', sessionId: null });
    expect(stream).not.toHaveBeenCalled();
    const [args] = agentLoop.mock.calls[0];
    expect(args.userText).toBe('read a file');
    expect(args.toolsCfg).toEqual({ read_file: 'allow' });
    expect(args.sandboxRoot).toBe('/tmp/sbx');
    expect(args.url).toBe('http://127.0.0.1:8080');
    expect(args.model).toBe('gemma');
    expect(args.maxIters).toBe(5);
  });

  it('keeps the in-flight and closed guards in agentic mode', async () => {
    const agentLoop = vi.fn(async () => 'ok');
    const s = createLlamaHttpSession({ agentLoop, agentic: true });
    s.close();
    await expect(s.turn('hi')).rejects.toThrow(/closed/);
  });
});
