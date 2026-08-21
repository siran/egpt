import { describe, it, expect, vi } from 'vitest';
import { createLlamaHttpSession } from '../src/llama-http-session.mjs';

// The llama brain is HTTP + SESSIONLESS, so this session is the odd one out
// among engines: no child process to spawn, no stdio framing, no server-side
// thread id. What it must still honour is the pool's contract —
// turn(message, onUpdate) -> { text, sessionId } · close() · sessionId.

const okStream = (text) => vi.fn(async (_payload, onUpdate) => { onUpdate?.(text); return text; });

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

  it('refuses a second concurrent turn — the pool serializes per key', async () => {
    let release;
    const pending = new Promise((r) => { release = () => r('done'); });
    const stream = vi.fn().mockReturnValueOnce(pending).mockResolvedValue('later');
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
                          .mockResolvedValueOnce('recovered');
    const s = createLlamaHttpSession({ stream });
    await expect(s.turn('boom')).rejects.toThrow(/HTTP 500/);
    await expect(s.turn('again')).resolves.toEqual({ text: 'recovered', sessionId: null });
  });
});
