import { describe, it, expect } from 'vitest';
import { buildTranscriptionPipeline } from '../src/transcription-pipeline.mjs';

const FULL = {
  fallback_order: ['remote', 'local', 'cli'],
  remote: { type: 'whisper-server-remote', endpoint: 'http://x', token: 'k', timeout_ms: 100, cooldown_ms: 1000 },
  local: { type: 'whisper-server-local', command: 'ws', model: 'm', host: '127.0.0.1', port: 8089 },
  cli: { type: 'whisper-cli', command: 'wc', model_path: 'm' },
};
const REMOTE_CLI = {
  fallback_order: ['remote', 'cli'],
  remote: { type: 'whisper-server-remote', endpoint: 'http://x', token: 'k', cooldown_ms: 1000 },
  cli: { type: 'whisper-cli', command: 'wc', model_path: 'm' },
};

function mk({ profile = FULL, ...overrides } = {}) {
  let clock = 0;
  const calls = { remote: 0, cli: 0, spawn: 0, local: 0 };
  const transitions = [];
  const deps = {
    profile,
    now: () => clock,
    onTransition: (t) => transitions.push(t),
    transcribeViaEndpoint: async () => { calls.remote++; return 'REMOTE'; },
    reachable: async () => true,
    cli: async () => { calls.cli++; return 'CLI'; },
    startWhisperServer: async () => { calls.spawn++; return { url: 'http://local', stop() {} }; },
    makeWhisperServerTranscriber: () => async () => { calls.local++; return 'LOCAL'; },
    ...overrides,
  };
  return { pipe: buildTranscriptionPipeline(deps), calls, transitions, advance: (d) => { clock += d; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('transcription pipeline (declarative fallback chain)', () => {
  it('returns the first engine in fallback_order that yields a transcript', async () => {
    const { pipe, calls } = mk();
    expect(await pipe.transcribe('a')).toBe('REMOTE');
    expect(calls.remote).toBe(1);
    expect(calls.cli).toBe(0);
    expect(calls.spawn).toBe(0);   // local never reached when remote wins
  });

  it('a down remote falls through; lazy local is still warming, so the first note lands on cli', async () => {
    const { pipe, calls } = mk({ transcribeViaEndpoint: async () => { throw new Error('down'); } });
    expect(await pipe.transcribe('a')).toBe('CLI');
    expect(calls.spawn).toBe(1);   // local spawn kicked off, not awaited
  });

  it('once the local server is resident it wins over cli (remote still down), spawned once', async () => {
    const { pipe, calls } = mk({ transcribeViaEndpoint: async () => { throw new Error('down'); } });
    expect(await pipe.transcribe('a')).toBe('CLI');   // warming
    await tick();                                      // spawn resolves
    expect(await pipe.transcribe('b')).toBe('LOCAL');  // remote in cooldown, local ready
    await tick();
    expect(await pipe.transcribe('c')).toBe('LOCAL');
    expect(calls.spawn).toBe(1);                       // spawned once, reused
  });

  it('circuit-breaker: a failed remote is SKIPPED (not re-called) until cooldown elapses', async () => {
    let remoteCalls = 0;
    const { pipe, advance } = mk({ profile: REMOTE_CLI, transcribeViaEndpoint: async () => { remoteCalls++; throw new Error('down'); } });
    await pipe.transcribe('a'); expect(remoteCalls).toBe(1);   // fails → cooldown
    await pipe.transcribe('b'); expect(remoteCalls).toBe(1);   // within cooldown → skipped
    advance(1001);
    await pipe.transcribe('c'); expect(remoteCalls).toBe(2);   // cooldown elapsed → retried
  });

  it('onTransition fires only when the winning engine changes (degrade then recover)', async () => {
    let down = false;
    const { pipe, transitions, advance } = mk({
      profile: REMOTE_CLI,
      transcribeViaEndpoint: async () => { if (down) throw new Error('down'); return 'REMOTE'; },
    });
    await pipe.transcribe('a'); await pipe.transcribe('b');    // remote, remote — no transition
    expect(transitions).toEqual([]);
    down = true;
    await pipe.transcribe('c'); await pipe.transcribe('d');    // cli, cli — one transition
    advance(2000); down = false;
    await pipe.transcribe('e');                                // remote — recover transition
    expect(transitions).toEqual([
      { from: 'remote', to: 'cli', recovered: false },
      { from: 'cli', to: 'remote', recovered: true },
    ]);
  });

  it('a probe-unreachable remote is skipped fast (no POST) and put in cooldown', async () => {
    let posts = 0;
    const { pipe } = mk({ profile: REMOTE_CLI, reachable: async () => false, transcribeViaEndpoint: async () => { posts++; return 'REMOTE'; } });
    expect(await pipe.transcribe('a')).toBe('CLI');   // probe fails → straight to cli, no decode attempt
    expect(posts).toBe(0);                            // never POSTed the audio
    await pipe.transcribe('b'); expect(posts).toBe(0);// still in cooldown
  });

  it('returns null when every engine declines', async () => {
    const { pipe } = mk({
      profile: { fallback_order: ['remote'], remote: { type: 'whisper-server-remote', endpoint: 'x', token: 'k' } },
      transcribeViaEndpoint: async () => { throw new Error('down'); },
    });
    expect(await pipe.transcribe('a')).toBe(null);
  });
});
