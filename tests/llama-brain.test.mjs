// llama.mjs talks to a local llama-server over its OpenAI-compatible
// streaming endpoint. These tests mock fetch with a fake SSE body, so the
// delta-parsing + accumulation are covered without a running server.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as llama from '../config/brains/llama.mjs';

function sseBody(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}
const delta = (s) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n`;

afterEach(() => { vi.unstubAllGlobals(); });

describe('llama brain — shape', () => {
  it('is sessionless and addressable as local/llamacpp', () => {
    expect(llama.name).toBe('llama');
    expect(llama.sessionless).toBe(true);
    expect(llama.legacyNames).toContain('local');
  });
});

describe('llama brain — streaming', () => {
  it('accumulates SSE deltas, streams via onUpdate, returns full text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sseBody([delta('Hola'), delta(', '), delta('mundo'), 'data: [DONE]\n']),
    })));
    const seen = [];
    const res = await llama.stream({ history: 'hi', message: 'hi' }, (acc) => seen.push(acc), {});
    expect(res.text).toBe('Hola, mundo');
    expect(res.optionsPatch).toBeNull();
    expect(seen.at(-1)).toBe('Hola, mundo');     // last onUpdate is the full text
    expect(seen.length).toBe(3);                  // one per content delta
  });

  it('POSTs to the configured url + OpenAI chat path, stream:true', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, body: sseBody([delta('ok'), 'data: [DONE]\n']) }));
    vi.stubGlobal('fetch', fetchMock);
    await llama.stream({ history: 'q' }, () => {}, { url: 'http://10.0.0.5:9001', appendSystemPrompt: 'be terse' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://10.0.0.5:9001/v1/chat/completions');
    const sent = JSON.parse(init.body);
    expect(sent.stream).toBe(true);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'q' });
  });

  it('rejects with a clear error on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, statusText: 'unavailable', text: async () => 'model loading' })));
    await expect(llama.stream({ history: 'x' }, () => {}, {})).rejects.toThrow(/HTTP 503/);
  });
});
