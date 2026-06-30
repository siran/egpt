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

  it('falls back to the legacy transcription.* block when no transcription_service', () => {
    const tx = createTranscription({ getConfig: () => ({ transcription: { cli: { ffmpeg_command: 'ff2' }, posts_back_delay_ms: 999 } }) });
    expect(tx.postsBackDelayMs).toBe(999);
    expect(tx.cliCfg.ffmpeg_command).toBe('ff2');
  });
});
