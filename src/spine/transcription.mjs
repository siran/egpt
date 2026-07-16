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
import { DEFAULT_SERVICE, readTranscriptionConfig } from '../transcription-service.mjs';
import { POSTS_BACK_DELAY_MS } from '../incoming-media.mjs';
import { readState, CONV_YAML_PATH, KNOWN_SURFACES, getContact, slugDir } from '../conversations-state.mjs';

export function createTranscription({
  getConfig = () => ({}),
  onLog = () => {},
  onTransition = () => {},
  // conv-state IO — DEFAULTS to a self-contained reader of CONV_YAML_PATH
  // (readState: parse file, missing → emptyState — same fallback boot's
  // _loadState uses). Boot calls createTranscription({ getConfig, onLog })
  // WITHOUT a loadState, so this default makes the per-conversation verdict
  // live-correct with no boot edit; boot can pass its own _loadState in a
  // later cleanup. Tests inject a fake so they never touch the real profile.
  loadState = () => readState(CONV_YAML_PATH),
  // Per-entity config reader (a conversation FOLDER's config.yaml →
  // { enabled, postsBack }; src/transcription-service.mjs). Injectable so tests
  // read canned verdicts instead of the profile.
  readConfig = readTranscriptionConfig,
} = {}) {
  const cfg = getConfig() ?? {};
  const txSvc = cfg.transcription_service;
  const profile = txSvc?.[txSvc?.use_config] ?? {};   // transcription_service is canonical (operator 2026-07-02)

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
  const postsBackDelayMs = txSvc?.posts_back_delay_ms ?? cfg.transcription?.posts_back_delay_ms;

  // The GLOBAL 👂 posts-back delay — the module-level postsBackDelayMs (from
  // transcription_service / the legacy transcription.* block), falling back to the
  // shared POSTS_BACK_DELAY_MS floor when the config sets neither. It is the default
  // a conversation with no per-chat override inherits.
  const globalDelayMs = postsBackDelayMs ?? POSTS_BACK_DELAY_MS;

  // per-chat HEARD/SPOKEN verdict + 👂 echo delay. enabled/postsBack come from the
  // conversation FOLDER's own config.yaml (src/transcription-service.mjs): enabled =
  // transcribe at all (HEARD), postsBack = surface the 👂 echo (SPOKEN). Both default
  // ON; only an explicit false disables. postsBackDelayMs is the per-CONVERSATION echo
  // delay (see the override below). Cost: one state read + one small file read per
  // VOICE NOTE (not per message) — cheap enough to skip any caching.
  async function resolveTranscriptionService(chatId) {
    if (!chatId) return { ...DEFAULT_SERVICE, postsBackDelayMs: Math.max(0, globalDelayMs) };
    let hit = null, surface = null;
    try {
      const state = await loadState();
      // The bridge's chatID is surface-agnostic here. A Beeper room id is
      // globally unique across surfaces, so scanning KNOWN_SURFACES and taking
      // the first hit can't cross-match a different chat — it only finds which
      // surface bucket registered this room.
      for (const s of KNOWN_SURFACES) {
        const c = getContact(state, s, chatId);
        if (c?.slug) { hit = c; surface = s; break; }
      }
    } catch (e) { onLog(`resolveTranscriptionService(${chatId}): ${e?.message ?? e}`); }
    // No contact yet (first-ever voice note from a brand-new chat) → default
    // service. Registration happens on the text pipe (ensureContact), so by the
    // next message this resolves to the folder's real config.
    if (!hit) return { ...DEFAULT_SERVICE, postsBackDelayMs: Math.max(0, globalDelayMs) };
    const folder = await readConfig(slugDir(surface, hit.slug));   // { enabled, postsBack } — the folder config.yaml (rooms keep this)

    // Per-CONVERSATION 👂 echo override — conversations.yaml, on the chat's OWN record
    // (the getContact entry, sibling of `mode`), ONE key: posts_back_delay_ms. This
    // REPLACES the folder-config.yaml approach FOR CONVERSATIONS; rooms keep the folder
    // mechanism above. Semantics:
    //   unset / null  → use the global default (current behavior).
    //   -1 (any negative) → NEVER echo the 👂 (transcription still HEARD — model +
    //                       transcript.md still get it — just not SPOKEN into the chat).
    //   0             → echo immediately (no debounce).
    //   N (positive)  → echo after N ms trailing-debounce.
    const rec = hit.entry ?? {};
    const override = Number.isFinite(rec.posts_back_delay_ms) ? rec.posts_back_delay_ms : null;
    const effectiveDelay = override ?? globalDelayMs;
    // postsBack: a negative override is a hard mute (effectiveDelay < 0). Otherwise the
    // conversations.yaml override WINS for the conversation; with NO override the folder
    // config.yaml's posts_back:false is still honored (back-compat — don't silently start
    // echoing a room/chat that had posts_back:false). enabled is always the folder verdict.
    const postsBack = folder.enabled && effectiveDelay >= 0 && (override != null ? true : folder.postsBack);
    // A negative disable maps the delay to 0 (postsBack:false already prevents any post).
    return { enabled: folder.enabled, postsBack, postsBackDelayMs: Math.max(0, effectiveDelay) };
  }

  return {
    transcribe,
    stop,
    cliCfg,
    postsBackDelayMs,
    resolveTranscriptionService,
  };
}
