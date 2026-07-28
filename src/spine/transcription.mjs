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
//
// ONE KEY, THREE RUNGS (operator ruling 2026-07-26). `transcription_service:` is the
// single name for the whole concern — engines, paths, and the post-back variables — and
// it resolves through src/spine/config-resolver.mjs:
//   config/config.yaml  <  config/conversations.yaml (the entry)  <  <entity>/config.yaml
// It replaces the three differently-named homes this used to read: the node's
// `transcription_service:`, the folder's `transcription:`, and a flat
// `posts_back_delay_ms` on the conversations.yaml record.
//
// THE PRECEDENCE DISSOLVED WITH THEM. The old rule was NOT plain nearest-wins: a
// conversations.yaml `posts_back_delay_ms` forced posts_back TRUE even when the folder
// said `posts_back: false`, justified in its own comment as back-compat ("don't silently
// start echoing a room/chat that had posts_back:false"). Operator 2026-07-26: "do not
// concern about live profiles", "do not keep maintaining legacy behavior" — so it is plain
// rung order now, nearest the room wins, and the folder's `posts_back: false` beats a
// registry delay. What SURVIVES is the value semantics, which were never a precedence
// rule: a NEGATIVE delay is a hard mute (HEARD, never SPOKEN).
import { buildTranscriptionPipeline } from '../transcription-pipeline.mjs';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { transcribeViaEndpoint } from '../tools/transcriptor.mjs';
import { startWhisperServer, makeWhisperServerTranscriber } from '../tools/whisper-server.mjs';
import { parseTranscriptionConfig } from '../transcription-service.mjs';
import { POSTS_BACK_DELAY_MS } from '../incoming-media.mjs';
import { readState, CONV_YAML_PATH, getContact, slugDir } from '../conversations-state.mjs';
import { DEFAULT_SERVICE } from '../transcription-service.mjs';

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
  // The RESOLVED config for an entity dir — the config resolver's in-memory set
  // (configFor), already layered node < registry entry < entity folder. No file read
  // happens here any more; tests inject a canned doc instead of touching the profile.
  resolveConfig = () => ({}),
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
  // as the default cfg the bridge hands the transcriber. (The two fallbacks here name the
  // pre-transcription_service ENGINE block — a different legacy from the three names this
  // chunk collapsed, and one src/spine/transcriptor-worker.mjs + the beeper bridge still
  // read. Retiring it is its own chunk, not a silent side effect of this one.)
  const cliCfg = profile?.cli ?? cfg.transcription?.cli ?? cfg.whatsapp?.media?.audio_transcribe ?? {};
  // How long after a burst goes quiet before the 👂 transcript echoes to the chat — the
  // NODE rung of the one key. Per-entity rungs override it in resolveTranscriptionService.
  const postsBackDelayMs = txSvc?.posts_back_delay_ms;

  // The GLOBAL 👂 posts-back delay — the node rung's value, falling back to the shared
  // POSTS_BACK_DELAY_MS floor when it sets none. The default a conversation whose own
  // rungs say nothing inherits.
  const globalDelayMs = postsBackDelayMs ?? POSTS_BACK_DELAY_MS;

  // per-chat HEARD/SPOKEN verdict + 👂 echo delay, from the ONE key resolved across the
  // three rungs. enabled = transcribe at all (HEARD); postsBack = surface the 👂 echo
  // (SPOKEN); posts_back_delay_ms = the trailing debounce, NEGATIVE = never echo. Both
  // flags default ON; only an explicit false disables. Cost: one state read + one in-memory
  // lookup per VOICE NOTE (not per message).
  async function resolveTranscriptionService(chatId) {
    const nodeRung = { ...DEFAULT_SERVICE, postsBackDelayMs: Math.max(0, globalDelayMs) };
    if (!chatId) return nodeRung;
    let hit = null, surface = null;
    try {
      const state = await loadState();
      // The bridge's chatID is surface-agnostic here. A Beeper room id is
      // globally unique across surfaces, so scanning every registered surface and
      // taking the first hit can't cross-match a different chat — it only finds
      // which surface bucket registered this room.
      for (const s of Object.keys(state?.contacts ?? {})) {
        const c = getContact(state, s, chatId);
        if (c?.slug) { hit = c; surface = s; break; }
      }
    } catch (e) { onLog(`resolveTranscriptionService(${chatId}): ${e?.message ?? e}`); }
    // No contact yet (first-ever voice note from a brand-new chat) → the node rung.
    // Registration happens on the text pipe (ensureContact), so by the next message this
    // resolves against the conversation's own rungs.
    if (!hit) return nodeRung;

    const { enabled, postsBack, postsBackDelayMs: entityDelay } = parseTranscriptionConfig(resolveConfig(slugDir(surface, hit.slug)));
    const effectiveDelay = entityDelay ?? globalDelayMs;
    // A negative delay is a hard mute: still HEARD (model + transcript.md get it), never
    // SPOKEN. Mapped to 0 on the way out — postsBack:false already prevents any post.
    return { enabled, postsBack: enabled && postsBack && effectiveDelay >= 0, postsBackDelayMs: Math.max(0, effectiveDelay) };
  }

  return {
    transcribe,
    stop,
    cliCfg,
    postsBackDelayMs,
    resolveTranscriptionService,
  };
}
