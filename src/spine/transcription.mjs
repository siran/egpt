// transcription.mjs — the §2c transcription service: the declarative fallback
// CHAIN (operator: "transcriptions can be done by other nodes, or locally with
// whisper server, falling back to cli"). Wraps the kept buildTranscriptionPipeline
// with its real engines:
//   whisper-server-remote  → transcribeViaEndpoint   (another node's server)
//   whisper-server-local   → startWhisperServer       (a local whisper-server)
//   whisper-cli            → transcribeAudioFile       (the cli fallback)
// The active profile + its fallback_order come from config.transcription_service
// [use_config]. The result `transcribe(audioPath, cfg, log, meta)` is what the
// bridge uses for voice notes and the media service for a video's audio.
import { buildTranscriptionPipeline } from '../transcription-pipeline.mjs';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { transcribeViaEndpoint } from '../tools/transcriptor.mjs';
import { startWhisperServer, makeWhisperServerTranscriber } from '../tools/whisper-server.mjs';
import { DEFAULT_SERVICE } from '../transcription-service.mjs';

export function createTranscription({ getConfig = () => ({}), onLog = () => {}, onTransition = () => {} } = {}) {
  const cfg = getConfig() ?? {};
  const txSvc = cfg.transcription_service;
  const profile = txSvc?.[txSvc?.use_config] ?? cfg.transcription ?? {};

  const { transcribe, stop } = buildTranscriptionPipeline({
    profile,
    transcribeViaEndpoint,
    reachable: async (url, ms) => { try { await fetch(url, { method: 'GET', signal: AbortSignal.timeout(ms) }); return true; } catch { return false; } },
    startWhisperServer,
    makeWhisperServerTranscriber,
    cli: transcribeAudioFile,
    onTransition,
    onLog,
  });

  // The cli profile carries ffmpeg_command (used by the media video path) + serves
  // as the default cfg the bridge hands the transcriber.
  const cliCfg = profile?.cli ?? cfg.transcription?.cli ?? cfg.whatsapp?.media?.audio_transcribe ?? {};
  // How long after a burst goes quiet before the 👂 transcript echoes to the chat.
  const postsBackDelayMs = txSvc?.posts_back_delay_ms ?? cfg.transcription?.posts_back_delay_ms ?? cfg.posts_back_delay_ms;

  return {
    transcribe,
    stop,
    cliCfg,
    postsBackDelayMs,
    // per-chat HEARD/SPOKEN verdict — default: transcribe AND echo back (with the
    // delay above). Per-conversation config overrides land later.
    resolveTranscriptionService: async () => ({ ...DEFAULT_SERVICE }),
  };
}
