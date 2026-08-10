import { describe, it, expect } from 'vitest';
import { buildSynthesisPipeline } from '../src/synthesis-pipeline.mjs';

const FULL = {
  fallback_order: ['remote', 'remote2'],
  remote: { type: 'piper-server-remote', endpoint: 'http://x', token: 'k', timeout_ms: 100, cooldown_ms: 1000 },
  remote2: { type: 'piper-server-remote', endpoint: 'http://y', token: 'k2', cooldown_ms: 1000 },
};

function mk({ profile = FULL, ...overrides } = {}) {
  let clock = 0;
  const calls = { remote: 0, remote2: 0 };
  const deps = {
    profile,
    now: () => clock,
    synthesizeViaEndpoint: async (text, voice, { endpoint }) => {
      if (endpoint === 'http://x') { calls.remote++; return Buffer.from('REMOTE'); }
      calls.remote2++; return Buffer.from('REMOTE2');
    },
    reachable: async () => true,
    ...overrides,
  };
  return { pipe: buildSynthesisPipeline(deps), calls, advance: (d) => { clock += d; } };
}

describe('synthesis pipeline (declarative TTS fallback chain)', () => {
  it('returns the first engine in fallback_order that yields audio', async () => {
    const { pipe, calls } = mk();
    const audio = await pipe.synthesize('hola', 'voiceA');
    expect(audio.toString()).toBe('REMOTE');
    expect(calls.remote).toBe(1);
    expect(calls.remote2).toBe(0);
  });

  it('a failing first engine falls through to the next', async () => {
    let first = true;
    const { pipe, calls } = mk({
      synthesizeViaEndpoint: async (text, voice, { endpoint }) => {
        if (endpoint === 'http://x') { calls.remote++; throw new Error('down'); }
        calls.remote2++; return Buffer.from('REMOTE2');
      },
    });
    const audio = await pipe.synthesize('hola', 'voiceA');
    expect(audio.toString()).toBe('REMOTE2');
    expect(calls.remote).toBe(1);
    expect(calls.remote2).toBe(1);
  });

  it('circuit-breaker: a failed engine is SKIPPED (not re-called) until cooldown elapses', async () => {
    let calls = 0;
    const { pipe, advance } = mk({
      profile: { fallback_order: ['remote'], remote: { type: 'piper-server-remote', endpoint: 'http://x', token: 'k', cooldown_ms: 1000 } },
      synthesizeViaEndpoint: async () => { calls++; throw new Error('down'); },
    });
    await pipe.synthesize('a'); expect(calls).toBe(1);   // fails → cooldown
    await pipe.synthesize('b'); expect(calls).toBe(1);   // within cooldown → skipped fast
    advance(1001);
    await pipe.synthesize('c'); expect(calls).toBe(2);   // cooldown elapsed → retried
  });

  it('a probe-unreachable remote is skipped fast (no POST) and put in cooldown', async () => {
    let posts = 0;
    const { pipe } = mk({
      profile: { fallback_order: ['remote'], remote: { type: 'piper-server-remote', endpoint: 'http://x', token: 'k', cooldown_ms: 1000 } },
      reachable: async () => false,
      synthesizeViaEndpoint: async () => { posts++; return Buffer.from('X'); },
    });
    expect(await pipe.synthesize('a', 'v')).toBe(null);
    expect(posts).toBe(0);
  });

  it('every engine declines → returns null, never throws', async () => {
    const { pipe } = mk({
      profile: { fallback_order: ['remote'], remote: { type: 'piper-server-remote', endpoint: 'http://x', token: 'k' } },
      synthesizeViaEndpoint: async () => { throw new Error('down'); },
    });
    await expect(pipe.synthesize('a', 'v')).resolves.toBe(null);
  });

  it('an unknown engine type is skipped, not thrown', async () => {
    const { pipe } = mk({
      profile: { fallback_order: ['weird'], weird: { type: 'something-else' } },
    });
    expect(await pipe.synthesize('a', 'v')).toBe(null);
  });
});
