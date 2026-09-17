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
    residentServing: () => null,   // no resident whisper-server in this process unless a test says so
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
      { from: 'remote', to: 'cli', recovered: false, reason: 'down' },   // surfaces WHY remote fell back
      { from: 'cli', to: 'remote', recovered: true, reason: null },      // a recovery carries no failure reason
    ]);
  });

  it('a probe-unreachable remote is skipped fast (no POST) and put in cooldown', async () => {
    let posts = 0;
    const { pipe } = mk({ profile: REMOTE_CLI, reachable: async () => false, transcribeViaEndpoint: async () => { posts++; return 'REMOTE'; } });
    expect(await pipe.transcribe('a')).toBe('CLI');   // probe fails → straight to cli, no decode attempt
    expect(posts).toBe(0);                            // never POSTed the audio
    await pipe.transcribe('b'); expect(posts).toBe(0);// still in cooldown
  });

  const LOCAL_CLI = {
    fallback_order: ['local', 'cli'],
    local: { type: 'whisper-server-local', command: 'ws', model: 'm', host: '127.0.0.1', port: 8089, timeout_ms: 300000 },
    cli: { type: 'whisper-cli', command: 'wc', model_path: 'm' },
  };

  it('threads the local engine timeout_ms into the server transcriber (was dropped → stuck at 120s)', async () => {
    let seenTimeout;
    const { pipe } = mk({
      profile: LOCAL_CLI,
      makeWhisperServerTranscriber: ({ timeoutMs }) => { seenTimeout = timeoutMs; return async () => 'LOCAL'; },
    });
    await pipe.transcribe('warm');   // kicks the lazy spawn, lands on cli
    await tick();                    // spawn resolves → transcriber built with the timeout
    expect(seenTimeout).toBe(300000);
  });

  it('serializes concurrent notes to the single-threaded local server (no overlapping decodes)', async () => {
    let active = 0, maxActive = 0;
    const { pipe } = mk({
      profile: LOCAL_CLI,
      makeWhisperServerTranscriber: () => async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--; return 'LOCAL';
      },
    });
    await pipe.transcribe('warm'); await tick();                 // local resident
    const out = await Promise.all([pipe.transcribe('a'), pipe.transcribe('b'), pipe.transcribe('c')]);
    expect(out).toEqual(['LOCAL', 'LOCAL', 'LOCAL']);
    expect(maxActive).toBe(1);                                   // never two decodes at once
  });

  it('surfaces the local failure reason (e.g. a timeout) on the fall-back to cli', async () => {
    let failNow = false;
    const { pipe, transitions } = mk({
      profile: LOCAL_CLI,
      makeWhisperServerTranscriber: () => async (audioPath, cfg, log) => {
        if (failNow) { log('whisper-server: transcribe failed — The operation was aborted due to timeout'); return null; }
        return 'LOCAL';
      },
    });
    await pipe.transcribe('warm'); await tick();          // local warming → lands on cli
    expect(await pipe.transcribe('a')).toBe('LOCAL');     // local now resident + winning
    failNow = true;
    expect(await pipe.transcribe('b')).toBe('CLI');       // local times out → cli
    expect(transitions.pop()).toEqual({ from: 'local', to: 'cli', recovered: false, reason: 'The operation was aborted due to timeout' });
  });

  // ── THE CLI RUNG MUST NOT LOAD A SECOND MODEL BESIDE A RESIDENT ONE (dolly, 2026-09-15) ──
  // do's worker rung failed, every note fell through to whisper-cli, and whisper-cli loaded its
  // OWN large-v3 beside the 2.68 GB the resident whisper-server already held: a 15.9 GB box ran
  // out of memory, and do's cli model was hand-switched to base to survive it.
  const DO_PROFILE = {
    fallback_order: ['worker', 'cli'],
    worker: { type: 'whisper-server-remote', endpoint: 'http://127.0.0.1:23390', token: 'k', cooldown_ms: 1000 },
    cli: { type: 'whisper-cli', command: 'wc', model_path: 'ggml-large-v3.bin' },
  };

  it('worker rung down + a resident whisper-server SERVING on this node → cli DECLINES loudly, no second model', async () => {
    const logs = [];
    const { pipe, calls } = mk({
      profile: DO_PROFILE,
      transcribeViaEndpoint: async () => { throw new Error('down'); },
      residentServing: () => ({ url: 'http://127.0.0.1:8089', adopted: true }),
      onLog: (m) => logs.push(m),
    });
    expect(await pipe.transcribe('a')).toBe(null);
    expect(calls.cli).toBe(0);                                  // whisper-cli never spawned
    const said = logs.join('\n');
    expect(said).toMatch(/cli "cli" DECLINED/);
    expect(said).toContain('http://127.0.0.1:8089');
  });

  it('worker rung down + NO resident server serving → cli still runs (the floor is intact)', async () => {
    const { pipe, calls } = mk({
      profile: DO_PROFILE,
      transcribeViaEndpoint: async () => { throw new Error('down'); },
      residentServing: () => null,
    });
    expect(await pipe.transcribe('a')).toBe('CLI');
    expect(calls.cli).toBe(1);
  });

  it('this pipeline\'s own local engine, resident and serving, also blocks a second model on the cli rung', async () => {
    let failNow = false;
    const { pipe, calls } = mk({
      profile: LOCAL_CLI,
      residentServing: () => null,
      startWhisperServer: async () => { await tick(); return { url: 'http://127.0.0.1:8089', isAlive: () => true, stop() {} }; },   // resolves after the warm note, like a real model load
      makeWhisperServerTranscriber: () => async () => (failNow ? null : 'LOCAL'),
    });
    await pipe.transcribe('warm'); await tick();                // warming: not serving yet → cli covers the gap
    expect(calls.cli).toBe(1);
    expect(await pipe.transcribe('a')).toBe('LOCAL');
    failNow = true;
    expect(await pipe.transcribe('b')).toBe(null);              // local failed this note, but its model is loaded
    expect(calls.cli).toBe(1);
  });

  // REGRESSION LOCK: the guard sits on the cli rung only — the order and earlier rungs are untouched.
  it('fallback order is unchanged: the worker rung still wins first even while a resident server serves', async () => {
    let residentAsked = 0;
    const { pipe, calls } = mk({ profile: DO_PROFILE, residentServing: () => { residentAsked++; return { url: 'http://127.0.0.1:8089' }; } });
    expect(await pipe.transcribe('a')).toBe('REMOTE');
    expect(calls.remote).toBe(1);
    expect(calls.cli).toBe(0);
    expect(residentAsked).toBe(0);                              // the guard is not consulted unless cli is reached
  });

  // REGRESSION LOCK: a node with no transcription at all.
  it('a node with no transcription profile at all: nothing runs, nothing is asked, null', async () => {
    let residentAsked = 0;
    const { pipe, calls } = mk({ profile: {}, residentServing: () => { residentAsked++; return null; } });
    expect(await pipe.transcribe('a')).toBe(null);
    expect(calls).toEqual({ remote: 0, cli: 0, spawn: 0, local: 0 });
    expect(residentAsked).toBe(0);
  });

  it('returns null when every engine declines', async () => {
    const { pipe } = mk({
      profile: { fallback_order: ['remote'], remote: { type: 'whisper-server-remote', endpoint: 'x', token: 'k' } },
      transcribeViaEndpoint: async () => { throw new Error('down'); },
    });
    expect(await pipe.transcribe('a')).toBe(null);
  });
});
