// transcription-ack.mjs — the policy for the 👂 voice-transcription ack.
//
// Operator 2026-06-15: "transcription service is not E, so it is not 'lurking';
// transcription is a fundamental tool of a room — egpt power." The 👂 ack is a
// ROOM DEFAULT SERVICE (GENOME §2.5), NOT E's persona participation. So it is
// deliberately DECOUPLED from E's enrollment (whatsapp.auto_e_chats /
// auto_e_modes): a chat does not have to enroll E to get its voice notes
// surfaced. That coupling was the bug — with auto_e_chats empty, the 👂 only
// showed in the self-DM.
//
// Roster model — auto-enroll, opt-out (operator: "default should be auto-enroll
// if not present in roster … unless explicitly disabled for conversation"):
//   whatsapp.transcription_ack        'on' | 'off' (or bool)  global default; default 'on'
//   whatsapp.transcription_ack_modes  { <chatId>: 'on' | 'off' (or bool) }  per-conversation override
// Resolution: per-conversation override > global default > ON.
//
// Keyed on the STABLE chatId ONLY, never a display name — same authorization
// discipline as every other gate (GENOME I6). No id → fail closed.
//
// This is the host-side POLICY. The transport bridge keeps a generic,
// fail-closed verdict slot (`isEnrolledChat`, default DENY); the host fills it
// with this. The transport mute flag is a SEPARATE suppression handled in
// src/incoming-media.mjs (a muted chat never acks even when enrolled).

const norm = (v) => {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === 'string') return v.trim().toLowerCase() !== 'off';
  return null; // unset / unrecognized → defer to the next level
};

/**
 * May the 👂 transcription ack be posted to this chat?
 * @param {string} chatId       STABLE chat id (Beeper room id / WA jid / TG chat id)
 * @param {object} [waConfig]   EGPT_CONFIG.whatsapp (the media/transcription root)
 * @returns {boolean}
 */
export function mayAckTranscript(chatId, waConfig = {}) {
  if (!chatId) return false; // never key on a name; no id → fail closed
  const overrides =
    waConfig && typeof waConfig.transcription_ack_modes === 'object' && waConfig.transcription_ack_modes
      ? waConfig.transcription_ack_modes
      : {};
  const perChat = norm(overrides[chatId]);
  if (perChat !== null) return perChat; // explicit per-conversation opt-out/in wins
  const global = norm(waConfig?.transcription_ack);
  if (global !== null) return global; // operator flipped the global default
  return true; // auto-enroll: a room transcribes by default
}
