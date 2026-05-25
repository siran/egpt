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
