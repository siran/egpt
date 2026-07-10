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

  it('defaults the per-chat verdict to transcribe AND echo back', async () => {
    const tx = createTranscription({ getConfig: () => config });
    expect(await tx.resolveTranscriptionService()).toEqual({ enabled: true, postsBack: true });
  });

  // Per-conversation policy: resolve chatId → contact slug (loadState) → folder
  // dir → its config.yaml verdict (readConfig). In-memory fakes only — the real
  // profile is never read.
  const stateWith = (surface, jid, slug) => ({ contacts: { [surface]: { [jid]: { slug } } } });

  it('honors a folder config that disables posts_back (HEARD but not SPOKEN)', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!room:beeper.local', 'quiet-chat-2606010101'),
      readConfig: async (dir) => {
        expect(dir).toContain('quiet-chat-2606010101');   // resolved to the contact's folder
        return { enabled: true, postsBack: false };
      },
    });
    expect(await tx.resolveTranscriptionService('!room:beeper.local')).toEqual({ enabled: true, postsBack: false });
  });

  it('honors enabled:false (never transcribe) — scanning past empty surfaces to the hit', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('telegram', 'tg:user:9', 'muted-chat-2606010101'),
      readConfig: async () => ({ enabled: false, postsBack: true }),
    });
    expect(await tx.resolveTranscriptionService('tg:user:9')).toEqual({ enabled: false, postsBack: true });
  });

  it('falls back to the default service for an unregistered chat (registration is on the text pipe)', async () => {
    let readCalled = false;
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => ({ contacts: {} }),
      readConfig: async () => { readCalled = true; return { enabled: false, postsBack: false }; },
    });
    expect(await tx.resolveTranscriptionService('!unknown:beeper.local')).toEqual({ enabled: true, postsBack: true });
    expect(readCalled).toBe(false);   // no contact → no folder read
  });

  it('falls back to the legacy transcription.* block when no transcription_service', () => {
    const tx = createTranscription({ getConfig: () => ({ transcription: { cli: { ffmpeg_command: 'ff2' }, posts_back_delay_ms: 999 } }) });
    expect(tx.postsBackDelayMs).toBe(999);
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
