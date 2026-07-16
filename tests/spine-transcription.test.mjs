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
      readConfig: async (dir) => {
        expect(dir).toContain('quiet-chat-2606010101');   // resolved to the contact's folder
        return { enabled: true, postsBack: false };
      },
    });
    expect(await tx.resolveTranscriptionService('!room:beeper.local')).toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 12345 });
  });

  it('honors enabled:false (never transcribe) — scanning past empty surfaces to the hit', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('telegram', 'tg:user:9', 'muted-chat-2606010101'),
      readConfig: async () => ({ enabled: false, postsBack: true }),
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
      readConfig: async () => { readCalled = true; return { enabled: false, postsBack: false }; },
    });
    expect(await tx.resolveTranscriptionService('!unknown:beeper.local')).toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 12345 });
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

// Per-CONVERSATION 👂 echo override (operator 2026-07-16): conversations.yaml carries a
// single key `posts_back_delay_ms` on the chat's own record (sibling of `mode`). It REPLACES
// the folder-config.yaml approach FOR CONVERSATIONS; the folder mechanism stays for rooms.
//   unset/null → global default   | -1 (neg) → never echo (still HEARD) | 0 → immediate | N → N ms debounce
// resolveTranscriptionService now also returns the per-chat postsBackDelayMs so the bridge
// debounces per conversation. The test config's global posts_back_delay_ms is 12345.
describe('resolveTranscriptionService — per-conversation posts_back_delay_ms override', () => {
  // record = the chat's OWN conversations.yaml entry (getContact → entry): slug + the override.
  const stateWith = (surface, jid, rec) => ({ contacts: { [surface]: { [jid]: rec } } });
  const folderDefault = async () => ({ enabled: true, postsBack: true });   // folder config.yaml: both ON

  it('-1 → NEVER echo (postsBack:false) but still HEARD (enabled:true); delay clamps to 0', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!r:beeper.local', { slug: 'silent-2607160101', posts_back_delay_ms: -1 }),
      readConfig: folderDefault,
    });
    expect(await tx.resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 0 });
  });

  it('0 → echo immediately (postsBack:true, postsBackDelayMs:0)', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!r:beeper.local', { slug: 'instant-2607160101', posts_back_delay_ms: 0 }),
      readConfig: folderDefault,
    });
    expect(await tx.resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 0 });
  });

  it('N (8000) → echo after N ms trailing-debounce (postsBack:true, postsBackDelayMs:8000)', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!r:beeper.local', { slug: 'slow-2607160101', posts_back_delay_ms: 8000 }),
      readConfig: folderDefault,
    });
    expect(await tx.resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 8000 });
  });

  it('unset → falls back to the global default delay + the prior folder postsBack behavior', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!r:beeper.local', { slug: 'plain-2607160101' }),   // no posts_back_delay_ms
      readConfig: folderDefault,
    });
    expect(await tx.resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 12345 });
  });

  it('the conversations.yaml override WINS over a folder config.yaml posts_back:false', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!r:beeper.local', { slug: 'q-2607160101', posts_back_delay_ms: 8000 }),
      readConfig: async () => ({ enabled: true, postsBack: false }),   // folder says quiet …
    });
    // … but the conversation's explicit override wins → it echoes (after 8s).
    expect(await tx.resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 8000 });
  });

  it('back-compat: with NO override, a folder posts_back:false stays quiet (no silent re-echo)', async () => {
    const tx = createTranscription({
      getConfig: () => config,
      loadState: async () => stateWith('whatsapp', '!r:beeper.local', { slug: 'q-2607160101' }),   // no override
      readConfig: async () => ({ enabled: true, postsBack: false }),
    });
    expect(await tx.resolveTranscriptionService('!r:beeper.local'))
      .toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 12345 });
  });
});
