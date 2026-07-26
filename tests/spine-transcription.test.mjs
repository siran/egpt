// transcription service: pulls the active profile + posts-back delay from config
// and exposes the fallback-chain transcriber. (The chain logic itself is locked by
// tests/transcription-pipeline.test.mjs; this covers the config wiring.)
import { describe, it, expect } from 'vitest';
import { createTranscription } from '../src/spine/transcription.mjs';

const config = {
  transcription_service: {
    use_config: 'reve',
    posts_back_delay_ms: 12345,
    reve: {
      fallback_order: ['local', 'cli'],
      local: { type: 'whisper-server-local', command: 'ws', model: 'm', host: '127.0.0.1', port: 8089, language: 'es' },
      cli: { type: 'whisper-cli', command: 'wc', model_path: 'mp', ffmpeg_command: 'C:/ff/ffmpeg.exe', language: 'es' },
    },
  },
};

describe('createTranscription', () => {
  it('exposes the chain transcriber + posts-back delay + cli profile from config', () => {
    const tx = createTranscription({ getConfig: () => config });
    expect(typeof tx.transcribe).toBe('function');     // the fallback-chain transcriber
    expect(typeof tx.stop).toBe('function');
    expect(tx.postsBackDelayMs).toBe(12345);
    expect(tx.cliCfg.ffmpeg_command).toBe('C:/ff/ffmpeg.exe');
  });

  it('defaults the per-chat verdict to transcribe AND echo back (with the global delay)', async () => {
    const tx = createTranscription({ getConfig: () => config });
    expect(await tx.resolveTranscriptionService()).toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 12345 });
  });

  // Per-conversation policy: resolve chatId → contact slug (loadState) → folder
  // dir → its config.yaml verdict (readConfig). In-memory fakes only — the real
  // profile is never read.
  const stateWith = (surface, jid, slug) => ({ contacts: { [surface]: { [jid]: { slug } } } });

  it('honors a folder config that disables posts_back (HEARD but not SPOKEN)', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!room:beeper.local', 'quiet-chat-2606010101'),
      resolveConfig: (dir) => {
        expect(dir).toContain('quiet-chat-2606010101');   // resolved to the contact's folder
        return { transcription_service: { posts_back: false } };
      },
    });
    expect(await tx.resolveTranscriptionService('!room:beeper.local')).toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 12345 });
  });

  it('honors enabled:false (never transcribe) — scanning past empty surfaces to the hit', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('telegram', 'tg:user:9', 'muted-chat-2606010101'),
      resolveConfig: () => ({ transcription_service: { enabled: false } }),
    });
    // postsBack now folds enabled (postsBack = enabled && …) — behaviorally inert since
    // enabled:false already short-circuits transcription (the note is never even HEARD).
    expect(await tx.resolveTranscriptionService('tg:user:9')).toEqual({ enabled: false, postsBack: false, postsBackDelayMs: 12345 });
  });

  it('falls back to the default service for an unregistered chat (registration is on the text pipe)', async () => {
    let readCalled = false;
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => ({ contacts: {} }),
      resolveConfig: () => { readCalled = true; return { transcription_service: { enabled: false, posts_back: false } }; },
    });
    expect(await tx.resolveTranscriptionService('!unknown:beeper.local')).toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 12345 });
    expect(readCalled).toBe(false);   // no contact → no entity lookup
  });

  it('ONE key: the post-back delay is read from transcription_service ONLY — the legacy transcription.posts_back_delay_ms is not a name any more', () => {
    const tx = createTranscription({ getConfig: () => ({ transcription: { cli: { ffmpeg_command: 'ff2' }, posts_back_delay_ms: 999 } }) });
    expect(tx.postsBackDelayMs).toBeUndefined();
    // the ENGINE block (transcription.cli) is a different legacy, still read by the
    // transcriptor worker + the beeper bridge — untouched by the key collapse
    expect(tx.cliCfg.ffmpeg_command).toBe('ff2');
  });

  // cliCfg resolution — the whisper-cli binary/model, canonical `transcription.cli`
  // with a legacy fallback to `whatsapp.media.audio_transcribe` (the DOLLY-worker
  // relocation, operator 2026-07-10). Deploying onto a legacy-shaped config is a NO-OP.
  it('cliCfg: reads the legacy whatsapp.media.audio_transcribe block when transcription.cli is absent (back-compat)', () => {
    const tx = createTranscription({ getConfig: () => ({ whatsapp: { media: { audio_transcribe: { model_path: '/legacy/large-v3.bin', ffmpeg_command: 'ffL' } } } }) });
    expect(tx.cliCfg.model_path).toBe('/legacy/large-v3.bin');
    expect(tx.cliCfg.ffmpeg_command).toBe('ffL');
  });

  it('cliCfg: canonical transcription.cli WINS over the legacy whatsapp.media.audio_transcribe', () => {
    const tx = createTranscription({ getConfig: () => ({
      transcription: { cli: { model_path: '/canon/large-v3.bin' } },
      whatsapp: { media: { audio_transcribe: { model_path: '/legacy/large-v3.bin' } } },
    }) });
    expect(tx.cliCfg.model_path).toBe('/canon/large-v3.bin');
  });
});

// The per-conversation 👂 echo delay is `transcription_service.posts_back_delay_ms`, one
// key resolved across the three rungs (config.yaml < the conversations.yaml entry < the
// entity folder). The tests below hand resolveConfig the RESOLVED doc — whichever rung it
// came from is the resolver's business, and that is the point of the collapse.
//   unset → the node rung's delay | -1 (neg) → never echo (still HEARD) | 0 → immediate | N → N ms
// The test config's node-rung posts_back_delay_ms is 12345.
describe('resolveTranscriptionService — posts_back_delay_ms, one key across the rungs', () => {
  const stateWith = (surface, jid, slug) => ({ contacts: { [surface]: { [jid]: { slug } } } });
  const resolvedWith = (tx) => () => ({ transcription_service: tx });

  const mk = (svc) => createTranscription({
    getConfig: () => config,
    loadState: async () => stateWith('whatsapp', '!r:beeper.local', 'chat-2607160101'),
    resolveConfig: resolvedWith(svc),
  });

  it('-1 → NEVER echo (postsBack:false) but still HEARD (enabled:true); delay clamps to 0', async () => {
    expect(await mk({ posts_back_delay_ms: -1 }).resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 0 });
  });

  it('0 → echo immediately (postsBack:true, postsBackDelayMs:0)', async () => {
    expect(await mk({ posts_back_delay_ms: 0 }).resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 0 });
  });

  it('N (8000) → echo after N ms trailing-debounce', async () => {
    expect(await mk({ posts_back_delay_ms: 8000 }).resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 8000 });
  });

  it('unset → the node rung delay stands', async () => {
    expect(await mk({}).resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 12345 });
  });

  // THE PRECEDENCE DISSOLVED (operator ruling 2026-07-26, "do not keep maintaining legacy
  // behavior"). It used to be that a conversations.yaml posts_back_delay_ms forced
  // posts_back TRUE even against a folder's posts_back:false — the registry rung beating
  // the NEARER folder rung, justified in its own comment as back-compat. Now it is plain
  // rung order: whichever rung the resolver says won, wins, and posts_back and the delay
  // are two independent values that no longer imply each other.
  it('a delay does NOT resurrect posts_back:false — the two are independent values now', async () => {
    expect(await mk({ posts_back: false, posts_back_delay_ms: 8000 }).resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 8000 });
  });

  it('posts_back:false with no delay stays quiet at the node-rung delay', async () => {
    expect(await mk({ posts_back: false }).resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 12345 });
  });
});
