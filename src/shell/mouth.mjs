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
// ── TWO WAYS TO SAY A REPLY, AND WHY BOTH EXIST ────────────────────────────────────────────────
// `say: 'post'` says a FINISHED sentence: one frame, one message, one answer. It shipped first and
// it is still the floor — every degraded path in src/shell/peer-mouth.mjs lands on it.
//
// `say: 'open'` / `'update'` / `'finish'` say a reply the way a LOCAL one is said: a "⏳ Thinking…"
// placeholder appears at once and is EDITED IN PLACE as the turn streams (the reply train,
// src/spine/sender.mjs over beeper-port.startStreamVerbatim). The first cut of this file refused
// to carry that, on the grounds that it means relaying a message IDENTITY across two accounts —
// the mouth handing back the id of the message it posted and the brain addressing every later edit
// to it. That reasoning was right about the danger and wrong about the only possible shape.
//
// NO MESSAGE ID EVER CROSSES THIS WIRE. The RECEIVER keeps the live stream object; the brain holds
// only an opaque, RECEIVER-MINTED stream id — a handle into the receiver's own map, meaningless
// anywhere else, and never a Beeper id. So the brain cannot address an edit to a message even in
// principle: it can only say "update the stream you opened for me". Two of the three hard parts
// (relaying identity, addressing edits) do not arise; the third — what happens if the link dies
// mid-stream — is answered in peer-mouth.mjs's THE MID-STREAM DROP section, by the ONLY party that
// can answer it, which is the one holding the handle.
//
// THE ORDER ON THE WIRE, one dial per REPLY (never per frame — the socket is held for the life of
// the stream and closed when it settles):
//
//   brain → mouth   say:'open'    { chatKey, init }        "open a live reply here; post `init`"
//   mouth → brain   say:'opened'  { ok, stream, chatId }   the minted handle, or a refusal
//   brain → mouth   say:'update'  { stream, text }         edit it; NOT answered (fire and forget)
//   brain → mouth   say:'finish'  { stream, text }         settle it
//   mouth → brain   say:'result'  { ok, chatId }           the SAME answer `post` gets, for the
//                                                          same reason: the brain must know
//                                                          whether the line is said before it
//                                                          decides to say it itself.
//
// A frame whose verb this end does not serve is refused, never ignored — an OLD peer (one running
// the pre-streaming code) answers `bad-frame` to `open`, and the brain then falls back to `post`,
// which that peer does serve. That is what makes the two spines upgradable one at a time.

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

/**
 * THE STREAM REQUEST — "open a live reply in the chat this key identifies".
 * @param {object} o
 * @param {string} o.chatKey  the same CROSS-ACCOUNT key sayFrame carries, meaning the same thing.
 * @param {string} o.init     the PLACEHOLDER text, posted verbatim — the message every later
 *   update edits in place. The brain owns its wording ("⏳ Thinking…" / "⏳ Queued (N ahead)…",
 *   src/spine/sender.mjs), because the brain is what will later replace it with the answer.
 */
export function sayOpenFrame({ chatKey, init }) {
  return JSON.stringify({ say: 'open', chatKey: String(chatKey ?? ''), init: String(init ?? '') });
}

/**
 * THE STREAM ANSWER — the receiver-minted handle, or a refusal in the same vocabulary as
 * sayResultFrame's. `stream` is OPAQUE to the brain: a key into the receiver's own map of live
 * stream objects, NOT a Beeper message id and not usable as one anywhere (module header).
 */
export function sayOpenedFrame({ ok, stream = '', chatId = '', reason = '', detail = '' }) {
  const f = { say: 'opened', ok: !!ok };
  if (stream) f.stream = String(stream);
  if (chatId) f.chatId = String(chatId);
  if (reason) f.reason = String(reason);
  if (detail) f.detail = String(detail);
  return JSON.stringify(f);
}

/** AN IN-PLACE EDIT of an open stream. Not answered: a dropped edit costs one stale frame, and
 *  the next one supersedes it whole (every frame carries the WHOLE text, never a delta). */
export function sayUpdateFrame({ stream, text }) {
  return JSON.stringify({ say: 'update', stream: String(stream ?? ''), text: String(text ?? '') });
}

/** SETTLE an open stream on its final text. Answered with sayResultFrame — same shape, same
 *  meaning, and the same reason as `post`'s: the brain must learn whether it was said. */
export function sayFinishFrame({ stream, text }) {
  return JSON.stringify({ say: 'finish', stream: String(stream ?? ''), text: String(text ?? '') });
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
    // The STREAMING verbs. `init` and `text` are strings — the very shape the console parse would
    // read as "a human typed this" — which is why every one of them carries `say` and why this
    // function runs BEFORE that parse on both ends (header). Nothing below changes that; it only
    // gives the frames structure once they have already been recognised as NOT console input.
    if (j.say === 'open') {
      return { say: 'open', chatKey: String(j.chatKey ?? ''), init: typeof j.init === 'string' ? j.init : '' };
    }
    if (j.say === 'opened') {
      return {
        say: 'opened',
        ok: !!j.ok,
        stream: j.stream ? String(j.stream) : '',
        chatId: j.chatId ? String(j.chatId) : '',
        reason: j.reason ? String(j.reason) : '',
        detail: j.detail ? String(j.detail) : '',
      };
    }
    if (j.say === 'update' || j.say === 'finish') {
      return { say: j.say, stream: String(j.stream ?? ''), text: typeof j.text === 'string' ? j.text : '' };
    }
    return { say: j.say };
  } catch { /* not JSON → not a mouth frame */ }
  return null;
}
