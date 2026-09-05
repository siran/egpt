// src/shell/mouth.mjs — THE MOUTH WIRE: the ONE definition of the peer-spine frames, and of the
// dial path that tells a peer apart from the operator's editor. Zero imports on purpose (like
// src/shell/auth.mjs): BOTH ends read this file and neither may grow a second copy of the shape.
//
// WHY IT EXISTS (operator 2026-09-05). One machine now runs TWO spines, one per Beeper account,
// sharing this checkout and differing only by EGPT_HOME. The PRIMARY spine is the ear and the
// brain — it receives, logs, gates and runs the turn exactly as it always has — and the SECONDARY
// is the MOUTH: instead of posting the finished reply on its own Beeper account, the primary
// hands the text over and the secondary says it on the other account.
//
// WHY THE CONSOLE PROTOCOL COULD NOT CARRY IT — the trap this file exists to avoid. The console's
// frames are `{ text, chatId }` and they mean "A HUMAN SAID THIS": src/bridges/shell-port.mjs
// turns one into an inbound event on the `shell` surface and the spine RUNS A TURN on it. The
// mouth needs the exact opposite — "post this text VERBATIM, do not think about it". A mouth frame
// that reached toInbound() would therefore be answered instead of spoken, which is why it carries
// a discriminator of its own, `say`, and why both ends check for it BEFORE the console parse, the
// same way an auth frame is intercepted before it can be rendered as chat text (auth.mjs header).
//
// WHY IT RIDES THE CONSOLE PORT rather than a second listener: everything this link needs is
// already solved there — the nonce/HMAC handshake under the node's shell token, the bind-at-boot-
// and-HOLD property, and the squatter protection that follows from never leaving the port unbound
// (shell-port.mjs header). Opening a second port would re-solve all three, badly.
//
// ROLE IS THE DIAL PATH. A peer spine dials ws://127.0.0.1:<console port>/peer; the operator's
// editor dials the bare root exactly as it always has (src/shell/spine-link.mjs, untouched). The
// path is read off the upgrade request, BEFORE a single frame is exchanged, because the console's
// single-seat rule ("incumbent holds") is decided at connection time: a mouth dial must neither be
// refused because an editor happens to be seated, nor lock the operator out of the console by
// taking the seat itself. Authentication is NOT relaxed by any of this — a peer proves it holds
// the same shell token, with the same challenge, or it is refused (loopback is not an
// authenticator: a sandboxed local account can dial 127.0.0.1 as freely as the peer spine can).
//
// FINAL TEXT ONLY — STREAMING IS OUT OF SCOPE, deliberately. A real reply today posts a "⏳
// thinking" placeholder and EDITS it in place as the turn streams (beeper-port.startStream over
// beeper.startStreamMessage). Relaying that faithfully means relaying a message IDENTITY across
// two accounts — the mouth would have to hand back the id of the message it posted, the brain
// would have to address every later edit to it, and both ends would have to agree on what happens
// when the link drops mid-stream, leaving a half-written placeholder on the OTHER account with
// nobody able to finish or delete it. None of that is needed to say a finished sentence, so this
// slice carries the finished sentence and nothing else. Streaming is its own problem, later.

// The dial path that means "I am a peer spine, not the operator's editor".
export const MOUTH_PATH = '/peer';

// Is this upgrade request a MOUTH dial? Reads `req.url` — the request target, which the `ws`
// server hands the 'connection' handler. A missing/absent req reads as NOT a mouth dial, so every
// existing caller (and every test that fires 'connection' with a socket alone) keeps the console
// role it has always had. Query strings and trailing segments are tolerated; a path that merely
// STARTS with the same letters ('/peerless') is not a mouth dial.
export function isMouthDial(req) {
  const url = String(req?.url ?? '');
  if (!url.startsWith(MOUTH_PATH)) return false;
  const rest = url.slice(MOUTH_PATH.length);
  return rest === '' || rest.startsWith('?') || rest.startsWith('/');
}

/**
 * THE REQUEST — "say this, verbatim, in the chat this key identifies".
 * @param {object} o
 * @param {string} o.chatKey  the CROSS-ACCOUNT chat key (beeper.crossAccountChatKey): the sorted
 *   set of participant phone numbers, digits-normalised, with both accounts' own identities
 *   excluded. NOT a chatId — the two accounts see one real group as two different Matrix rooms
 *   with nothing shared in the payload, so an id from one side means nothing on the other.
 * @param {string} o.text     the FINISHED reply, already wrapped/signed by the brain. The mouth
 *   posts exactly these bytes and adds nothing.
 */
export function sayFrame({ chatKey, text }) {
  return JSON.stringify({ say: 'post', chatKey: String(chatKey ?? ''), text: String(text ?? '') });
}

/**
 * THE ANSWER — always sent, success or refusal, on the same socket the request arrived on, so the
 * caller can fall back to speaking on its own account instead of guessing whether it was said.
 * @param {object} r
 * @param {boolean} r.ok
 * @param {string} [r.chatId]  on success: the chat the receiver posted in, in ITS OWN namespace.
 * @param {string} [r.reason]  on refusal, one of the documented reasons (peer-mouth.mjs header).
 * @param {string} [r.detail]  a human line for the log; never parsed.
 */
export function sayResultFrame({ ok, chatId = '', reason = '', detail = '' }) {
  const f = { say: 'result', ok: !!ok };
  if (chatId) f.chatId = String(chatId);
  if (reason) f.reason = String(reason);
  if (detail) f.detail = String(detail);
  return JSON.stringify(f);
}

// Is this raw frame a MOUTH frame? Returns the normalized frame, or null for anything else (an
// auth frame, a console `{ text, chatId }`, a bare text line, garbage). Both ends call this
// BEFORE the console parse so a mouth frame is never answered as if a human had typed it.
//
// A frame carrying a `say` VERB THIS END DOES NOT SERVE still comes back as `{ say }` rather than
// null — recognised, so it can be refused explicitly instead of falling through to the console
// path and being dispatched as a turn. That fall-through is the whole hazard; nothing with a
// `say` on it may reach it.
export function parseMouthFrame(raw) {
  const s = (typeof raw === 'string') ? raw : (raw?.toString?.() ?? '');
  try {
    const j = JSON.parse(s);
    if (!j || typeof j !== 'object' || typeof j.say !== 'string') return null;
    if (j.say === 'post') {
      return { say: 'post', chatKey: String(j.chatKey ?? ''), text: typeof j.text === 'string' ? j.text : '' };
    }
    if (j.say === 'result') {
      return {
        say: 'result',
        ok: !!j.ok,
        chatId: j.chatId ? String(j.chatId) : '',
        reason: j.reason ? String(j.reason) : '',
        detail: j.detail ? String(j.detail) : '',
      };
    }
    return { say: j.say };
  } catch { /* not JSON → not a mouth frame */ }
  return null;
}
