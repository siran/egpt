// Per-chat auto mode: how conversation-e (and the other residents) engage with
// a WhatsApp chat. Two axes — does E *receive* the messages, and when does it
// *reply*. One enum captures both. Default (unconfigured chat) is 'mention'.
//
//   on             receive every burst; reply per personality (free-post)
//   accum          buffer; flush to E once per heartbeat; reply ONLY if the
//                  batch was mentioned (mention semantics), and the reply
//                  carries the accumulated messages as context
//   mute           receive every burst; never reply
//   mention-direct receive; reply only when @e is at the START, or it's a reply to E
//   mention        receive; reply only when @e appears anywhere, or a reply to E
//   off            don't receive at all; never reply (even @e is ignored)
export const AUTO_MODES = ['on', 'accum', 'mute', 'mention-direct', 'mention', 'off'];
export const DEFAULT_AUTO_MODE = 'mention';

export function isAutoMode(m) { return AUTO_MODES.includes(String(m)); }

// PER-BEING per-chat mode (generalizes the E-only mode to EVERY being — E,
// Wren, Don, L — across every surface). A being's mode in a chat decides whether
// it RECEIVES that chat's messages and when it REPLIES, exactly like E's mode;
// the emit gate (mayEmitChat) is unchanged — this only resolves WHICH mode
// applies to WHICH being in WHICH chat. This is the missing piece that lets a
// bot's presence in a group = enrollment, tuned per-sibling (operator 2026-06-14).
//
// Config (surface-agnostic): EGPT_CONFIG.auto_modes[<chatId>][<being>] = mode,
// with a per-chat '*' wildcard for "all beings here". Backward-compatible: the
// legacy whatsapp.auto_e_modes[<chatId>] is E's mode when no per-being entry
// exists. Resolution order (first match wins):
//   1. auto_modes[chat][being]        explicit per-being
//   2. auto_modes[chat]['*']          per-chat "all" wildcard (the /e auto … all form)
//   3. auto_eModes[chat]   (being==='e' only)  legacy E mode
//   4. defaultMode                    caller's fallback (E: chat default; sibling: 'mention')
export function resolveBeingMode({ autoModes = {}, autoEModes = {}, chatId, being, defaultMode = DEFAULT_AUTO_MODE } = {}) {
  const b = String(being ?? '').toLowerCase();
  const chat = (autoModes && typeof autoModes === 'object' ? autoModes[chatId] : null) ?? {};
  if (isAutoMode(chat[b]))   return chat[b];
  if (isAutoMode(chat['*'])) return chat['*'];
  if (b === 'e' && autoEModes && isAutoMode(autoEModes[chatId])) return autoEModes[chatId];
  return isAutoMode(defaultMode) ? defaultMode : DEFAULT_AUTO_MODE;
}

// E sees the chat at all? (everything except 'off')
export function receives(mode) { return mode !== 'off'; }
// Buffer-and-flush-per-heartbeat instead of dispatching each burst?
export function accumulates(mode) { return mode === 'accum'; }

// Standalone @e / @egpt wake-word detection. Must be a real mention token:
// preceded by start-or-whitespace and followed by a word boundary — so
// "To @e my assistant" counts but "me@e.com" / "hey@egpt" (glued to a word
// char) do NOT. Returns { atEStart, atEAnywhere }.
const RE_ANYWHERE = /(^|\s)@(?:egpt|e)\b/i;
const RE_START    = /^@(?:egpt|e)\b/i;
export function mentionStatus(text) {
  const t = String(text ?? '');
  return {
    atEAnywhere: RE_ANYWHERE.test(t),
    atEStart:    RE_START.test(t.replace(/^\s+/, '')),
  };
}

// Given the chat's mode and the triggering message's mention status
// ({ atEStart, atEAnywhere, replyToBot }), should E's reply be SENT to the
// chat? (E may still be invoked for context even when this is false.) For
// 'accum' the status is the COMBINED status of the flushed batch (did any
// buffered message mention @e?), so accum uses the same gate as 'mention'.
export function replyAllowed(mode, status = {}) {
  const { atEStart = false, atEAnywhere = false, replyToBot = false } = status;
  switch (mode) {
    case 'on':             return true;            // personality decides ('…' still dropped downstream)
    case 'mute':
    case 'off':            return false;
    case 'mention-direct': return atEStart   || replyToBot;
    case 'accum':
    case 'mention':        return atEAnywhere || replyToBot;
    default:               return atEAnywhere || replyToBot;   // unknown → treat as 'mention'
  }
}

// Outbound EMIT gate — the single backstop every E reply must pass before it
// reaches a chat, regardless of which dispatch path produced it (text, voice,
// emitted-command, future paths). E *receives* everything (reception is
// unconditional); this gates only what E SENDS. Two layers:
//   1. HARD: 'mute'/'off' can NEVER emit — independent of `replyAllowed`, so a
//      path that forgot to thread the flag (the voice-note bug) still can't
//      message a muted chat.
//   2. mention / mention-direct / accum: emit only when the per-turn
//      `replyAllowed` gate already passed. Fail-closed when the flag is absent.
// `mode` is the chat's resolved auto-mode; `replyAllowed` is the per-turn flag.
export function mayEmit(mode, { replyAllowed = undefined, isReaction = false } = {}) {
  // A reaction is never a turn that warrants a reply — in ANY mode, including
  // 'on'. WhatsApp/Beeper render a reaction as "<who> reacted <emoji> to …";
  // letting @e answer it produced the "no reaccioné, boludo" embarrassment
  // (operator 2026-06-03). Hard-block here so no mode can leak a reply to one.
  if (isReaction) return false;
  if (mode === 'mute' || mode === 'off') return false;
  if (mode === 'on') return true;
  return replyAllowed === true;
}

// The COMPLETE outbound gate for a chat reply: the operator's global pause kill
// layered OVER the per-chat mode gate. `paused` is `whatsapp.auto_e_paused` —
// when true NOTHING emits, overriding mode, mention, even 'on' and an explicit
// '@e …' (operator 2026-06-03: a PAUSED @e still answered '@e estas?' before
// this backstop). This is the pure, testable form of egpt.mjs
// `_eMayReplyToChat`; that wrapper only resolves chatId→mode + reads the config
// flag, then delegates here — so a test on this function locks the REAL gate,
// pause-kill included, instead of a parallel copy.
export function mayEmitChat({ paused = false, mode, replyAllowed = undefined, isReaction = false } = {}) {
  if (paused) return false;                                  // absolute kill — overrides everything
  return mayEmit(mode, { replyAllowed, isReaction });
}

// A reply that is ONLY ellipsis (ASCII '...' or unicode '…') or empty. This is
// the ONE place a reply's BODY is consulted, and ONLY for the 'on'-mode cosmetic
// below — E declining to add noise to a chat it's free to post in. It is NEVER
// a gating input for mute / mention / mention-direct (operator 2026-06-02:
// "it doesn't matter what the reply of E is … if E is muted the replies don't
// fan out"). See [[egpt-emit-gate-bridge-controlled]].
export function isSilenceReply(reply) {
  const t = String(reply ?? '').trim();
  return t === '' || /^(\.{3,}|…+)$/.test(t);
}

// THE single fan-out + record decision for a resident/persona reply. The reply
// is ALWAYS written to the chat transcript (operator 2026-06-02: "don't drop
// any message from E or from anyone"); this only decides whether it is ALSO
// pushed to the surface, and — when it is not — the annotation the transcript
// carries.
//
// Fan-out is decided by `mode` + the per-turn `replyAllowed` (which itself was
// derived from the INCOMING message's mention status), NEVER from `reply` —
// except the 'on'-mode silence cosmetic. Fails CLOSED for mention modes when
// `replyAllowed` is absent, so any dispatch path that forgets to thread it
// records-but-doesn't-send rather than leaking.
//
// Returns { sent, annotation }:
//   sent=true  → push to surface; transcript records it plainly.
//   sent=false → DO NOT push; transcript records `<reply> (annotation)`.
export function fanOutDecision(mode, { replyAllowed = undefined, reply = '' } = {}) {
  let sent = mayEmit(mode, { replyAllowed });
  if (sent && mode === 'on' && isSilenceReply(reply)) sent = false;   // E opts out, still recorded
  return { sent, annotation: sent ? null : `(not sent to group. auto: ${mode})` };
}
