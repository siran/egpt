// transcription-service.mjs — the per-ENTITY view of the transcription service.
//
// Operator 2026-06-15: "transcription is surface independent … in
// conversations.yaml, or room.yaml for the room: transcription_service_enabled
// and transcription_service_posts_back. transcriptions are always made if
// service enabled (default) in a room or conversation, and surfaced if
// posts_back (default)."
//
// SUPERSEDED IN ONE HALF (operator 2026-09-13): the "surfaced if posts_back (default)"
// clause above is history. posts_back is OPT-IN now — see WHY below. `enabled` is
// unchanged: transcription still runs by default.
//
// So transcription is a ROOM DEFAULT SERVICE (GENOME §2.5), NOT E and NOT a
// transport concern. Surface-independent by construction.
//
// ONE KEY (operator ruling 2026-07-26: "on transcriptions can be joined under the same
// key; the configurations 'remote', 'cli', etc, the paths, the post-back variables, etc").
// The same concern used to live under THREE names — node `transcription_service:`, entity
// folder `transcription:`, and a flat `posts_back_delay_ms` on the conversations.yaml
// record. They are ONE key, `transcription_service:`, resolved across the THREE rungs of
// src/spine/config-resolver.mjs:
//
//   config/config.yaml  <  config/conversations.yaml (the entry)  <  <entity>/config.yaml
//
// `transcription_service` is the name that survived because the node rung already called
// it that in six modules (operator 2026-07-02: "transcription_service is canonical") and
// because the bare name `transcription:` is ALREADY OCCUPIED at the node rung by an
// unrelated legacy shape (transcription.cli / .whisper / .token / .server, still read by
// the transcriptor worker and the beeper bridge) — collapsing onto it would have silently
// merged two different schemas.
//
// Three orthogonal settings — they map onto the GENOME heart (idea #2: everything is
// HEARD and recorded; only some is SPOKEN), and they do NOT default alike:
//   enabled             → HEARD: run the transcription at all (model + transcript.md get it)
//                         DEFAULT ON — opt-OUT, only an explicit `false` disables it.
//   posts_back          → SPOKEN: surface the 👂 <transcript> back into the chat
//                         DEFAULT OFF — opt-IN, only an explicit `true` enables it.
//   posts_back_delay_ms → how long after a burst goes quiet the 👂 echo fires;
//                         negative = never echo (HEARD but never SPOKEN)
// `enabled:true, posts_back:false` = transcribe for the model/log but stay silent — and
// that is exactly what an unconfigured entity now gets.
//
//   <rung> → { transcription_service: { enabled: true, posts_back: true, posts_back_delay_ms: 8000 } }
//
// Block absent / key absent → HEARD BUT SILENT. Keyed off the entity FOLDER, never a
// display name.
//
// WHY posts_back IS OPT-IN (operator ruling 2026-09-13: "postback must default to false,
// `true` is an 'unsafe' default, as we just experienced"). It used to default ON, and the
// SECOND profile on this machine (~/.egpt-secondary), which carried no
// `transcription_service:` block at all, auto-enrolled itself into the operator's REAL
// group chats and spoke there under its own persona — while the profile the operator HAD
// configured stayed silent on its own `posts_back_delay_ms: -1`, so turning transcription
// off there changed nothing. Having no block also meant no `use_config`, no remote worker
// and no fallback_order (and that profile has no ffmpeg on PATH), so what it actually
// posted, over and over, was `[voice note — transcription failed]`. Hearing is invisible
// and can stay default-on; SPEAKING into someone's chat cannot.
//
// The two asymmetric comparisons below are each the FAIL-CLOSED reading of their own flag,
// and both are strict about the type: a non-boolean (`posts_back: yes` parses as the STRING
// "yes" under YAML 1.2) neither enables the echo nor disables hearing.

export const DEFAULT_SERVICE = { enabled: true, postsBack: false };

// Pure: a RESOLVED config doc (the resolver's merge of all three rungs) →
// { enabled, postsBack, postsBackDelayMs }. `enabled` is opt-OUT (an explicit `false` turns
// it off); `postsBack` is opt-IN (an explicit `true` turns it on). postsBackDelayMs is null
// when no rung set one (the caller applies the floor).
export function parseTranscriptionConfig(doc) {
  const t = (doc && typeof doc === 'object' && doc.transcription_service && typeof doc.transcription_service === 'object')
    ? doc.transcription_service : {};
  return {
    enabled: t.enabled !== false,
    postsBack: t.posts_back === true,
    postsBackDelayMs: Number.isFinite(t.posts_back_delay_ms) ? t.posts_back_delay_ms : null,
  };
}
