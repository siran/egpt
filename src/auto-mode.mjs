// Per-chat auto mode: how conversation-e (and the other residents) engage with
// a WhatsApp chat. Two axes — does E *receive* the messages, and when does it
// *reply*. One enum captures both. Default (unconfigured chat) is 'mention'.
//
//   on             receive every burst; reply per personality (free-post)
//   auto           gates EXACTLY like 'on' (reply to every message), but E plays
//                  the OPERATOR's role in that chat — be of service, follow links,
//                  do as told, and consult the operator (via /ask, the advice
//                  channel) when in doubt. The mode value ONLY controls the reply
//                  gate; the operator-role instruction layer is an identity-feed
//                  layer wired in the brainpool (config/skeletons/auto-mode.md),
//                  NOT here. Per-conversation opt-in only (never a default).
//   mute           receive every burst; never reply
//   mention-direct receive; reply only when @e is at the START, or it's a reply to E
//   mention        receive; reply only when @e appears anywhere, or a reply to E
//   off            don't receive at all; never reply (even @e is ignored)
//
// RETIRED — 'accum' (operator 2026-07-01): it buffered a chat's bursts and
// flushed the batch to E once per heartbeat, replying only if the batch was
// mentioned. Dead: "there is no need to 'buffer messages' since there's the
// transcript" — the transcript.md IS the buffer (E reads it for back-context
// when it engages), and send_to_egpt:'always' keeps E current on a busy chat as
// per-message context turns. accum was legacy from when EVERY prompt was sent to
// E even when unmentioned in mention mode; batching prompts serves nothing now.
// A 'mode: accum' still stored in conversations.yaml (live nodes have them)
// degrades cleanly: isAutoMode('accum') is now false, so every reader guarding
// with isAutoMode(...) — createGating.decide() and resolveBeingMode below —
// falls through to its default ('mention' for E). That fallthrough IS the
// migration: a legacy accum chat simply behaves as a mention chat.
export const AUTO_MODES = ['on', 'auto', 'mute', 'mention-direct', 'mention', 'off'];
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

// Standalone wake-word detection. Must be a real mention token: preceded by
// start-or-whitespace and followed by a word boundary — so "To @e my assistant"
// counts but "me@e.com" / "hey@egpt" (glued to a word char) do NOT. Returns
// { atEStart, atEAnywhere }.
//
// WAKE-WORD SET (operator 2026-07-07: the bridge gate must honor configured
// handles). The DEFAULT set is the network-wide persona address e/egpt. A caller
// (the bridge, from boot's persona agent) may pass an explicit `wakeWords` list —
// the persona agent's name + every configured handle (e.g. DOLLY's [ed, egptd]) PLUS
// the network defaults — so an unqualified @e wakes every node AND a node's own @ed
// wakes it too. The bug this fixes: a live `@ed estás?` logged atE=false because the
// gate was hardcoded to e/egpt and never read the agents config.
const _escapeWake = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE_ANYWHERE = /(^|\s)@(?:egpt|e)\b/i;
const RE_START    = /^@(?:egpt|e)\b/i;
function wakeMatchers(wakeWords) {
  if (!Array.isArray(wakeWords) || !wakeWords.length) return { anywhere: RE_ANYWHERE, start: RE_START };
  // longest-first so @egpt matches 'egpt' not 'e' (\b backtracking also handles it, but be explicit)
  const alt = [...new Set(wakeWords.map((w) => String(w).toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length).map(_escapeWake).join('|');
  if (!alt) return { anywhere: RE_ANYWHERE, start: RE_START };
  return { anywhere: new RegExp(`(^|\\s)@(?:${alt})\\b`, 'i'), start: new RegExp(`^@(?:${alt})\\b`, 'i') };
}
// A fenced or inline CODE region must never contribute a live wake match — e.g.
// the /status command emits a fenced ```yaml block whose version line quotes a
// git commit SUBJECT ("...@e voice-note transcript..."), a changelog line, not
// an address. Strip code regions to a single space (so surrounding tokens don't
// glue into — or lose — a word boundary) BEFORE running the wake matchers. An
// unclosed opening ``` strips to end-of-text. (operator 2026-07-24: E replied
// '…' to its own /status output because the raw text was matched as-is.)
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')   // paired fenced blocks
    .replace(/```[\s\S]*$/g, ' ')      // unclosed fence → rest of text
    .replace(/`[^`\n]*`/g, ' ');       // inline code spans
}
export function mentionStatus(text, wakeWords) {
  const t = stripCode(String(text ?? ''));
  const { anywhere, start } = wakeMatchers(wakeWords);
  return {
    atEAnywhere: anywhere.test(t),
    atEStart:    start.test(t.replace(/^\s+/, '')),
  };
}

// Given the chat's mode and the triggering message's mention status
// ({ atEStart, atEAnywhere, replyToBot }), should E's reply be SENT to the
// chat? (E may still be invoked for context even when this is false.) A stored
// legacy 'accum' is no longer a known mode, so it lands on `default:` → mention
// semantics (exactly its retired reply behavior).
export function replyAllowed(mode, status = {}) {
  const { atEStart = false, atEAnywhere = false, replyToBot = false } = status;
  switch (mode) {
    case 'on':
    case 'auto':           return true;            // 'auto' gates like 'on' — personality decides ('…' still dropped downstream)
    case 'mute':
    case 'off':            return false;
    case 'mention-direct': return atEStart   || replyToBot;
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
//   2. mention / mention-direct: emit only when the per-turn `replyAllowed`
//      gate already passed. Fail-closed when the flag is absent.
// `mode` is the chat's resolved auto-mode; `replyAllowed` is the per-turn flag.
export function mayEmit(mode, { replyAllowed = undefined, isReaction = false } = {}) {
  // I5 REVISED (operator 2026-06-16, MESSAGES-FIRST-CLASS-PLAN Phase 2): a reaction
  // is no longer hard-blocked. It flows through the SAME mode gate as any message,
  // because it now arrives as an intelligible stage-direction ("<who> reacted 👍
  // to #<id> \"<snippet>\""), not the raw confusing notification that caused the
  // "no reaccioné, boludo" embarrassment (operator 2026-06-03 — the reason for the
  // old hard-block). So: 'on' → E may answer a reaction; 'mention'/'mention-direct'
  // → only if it @-mentions E (a reaction can't, so it stays silent there);
  // 'mute'/'off' → never. `isReaction` is kept for telemetry (the emit log).
  if (mode === 'mute' || mode === 'off') return false;
  if (mode === 'on' || mode === 'auto') return true;   // 'auto' gates like 'on'
  return replyAllowed === true;
}

// The COMPLETE outbound gate for a chat reply: the operator's global pause kill
// layered OVER the per-chat mode gate. `paused` is `whatsapp.auto_e_paused` —
// when true NOTHING emits, overriding mode, mention, even 'on' and an explicit
// '@e …' (operator 2026-06-03: a PAUSED @e still answered '@e estas?' before
// this backstop). This is the pure, testable form of egpt-spine.mjs
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
  if (sent && (mode === 'on' || mode === 'auto') && isSilenceReply(reply)) sent = false;   // E opts out, still recorded
  return { sent, annotation: sent ? null : `(not sent to group. auto: ${mode})` };
}
