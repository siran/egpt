// src/shell/peer-mouth.mjs — THE MOUTH, both halves: the side that SPEAKS through its peer spine
// and the side that is SPOKEN THROUGH. The wire they share is src/shell/mouth.mjs; the handshake
// they share is src/shell/auth.mjs. Neither is re-implemented here.
//
// THE ARRANGEMENT (operator 2026-09-05). Two spines, one machine, one checkout, one Beeper account
// each, differing only by EGPT_HOME. The PRIMARY is the ear and the brain: it receives, logs,
// gates and runs the turn exactly as it always has. The SECONDARY is the mouth: the primary hands
// it the finished text and it posts that text on the OTHER account. A message addressed to the
// secondary alone is answered by the secondary directly, with no link involved — that is the
// ordinary single-account path and nothing here touches it.
//
// WHO CALLS THIS (2026-09-05, the follow-up that made the transport live). The WHEN is decided in
// ONE place: src/spine/sender.mjs, the reply path, at the moment a reply is opened — if a peer is
// configured AND the peer's account is a participant of the chat being replied in, the finished
// text goes through speakThroughPeer instead of being posted here. boot.mjs builds both halves
// (makePeerMouth for the speaker, createMouthReceiver handed to the shell-port limb as its
// onPeerSay). Every refusal below falls back to a LOCAL post on the caller's own account: a reply
// from the wrong mouth is cosmetic, a reply that never arrives is not.
//
// ── THE HARD PART IS NOT THE SOCKET, IT IS FINDING THE CHAT ────────────────────────────────────
// The two accounts see the SAME real group as DIFFERENT Matrix rooms, and NOTHING in the two
// payloads is shared — measured live on one machine, one underlying group:
//
//   primary   sees it as  !6ljZ…:beeper.local   localChatID 211
//   secondary sees it as  !HuXF…:beeper.local   localChatID 3
//
// So a chatId cannot cross the link. beeper.crossAccountChatKey() is the primitive that can: the
// sorted set of participant PHONE NUMBERS, digits-normalised, excluding the identities the caller
// holds — byte-identical across both accounts' views of one group when BOTH account identities
// are excluded (its header carries the measurement and the reasoning). The speaker computes the
// key for its own chat and sends it; the receiver finds ITS chat with the same key and posts there.
//
// ── FAIL CLOSED, LOUDLY, AT EVERY STEP ─────────────────────────────────────────────────────────
// A reply in the WRONG chat is the worst outcome available here — worse than no reply, because
// nobody notices a wrong-chat answer until it is already public. So every ambiguity refuses, and
// every refusal is REPORTED BACK over the same socket so the caller can fall back to speaking on
// its own account. The reasons, exactly:
//
//   no-peer      no peer_spine configured (or the block is unusable). Refused BEFORE any dial.
//   no-text      nothing to say. Refused before any dial.
//   no-key       crossAccountChatKey returned null for this chat — no roster in the payload, or
//                fewer than two phone identities left after the exclusions. The key would not be
//                EVIDENCE, and a non-evidence key matches everything to everything. Refused
//                BEFORE any dial: the frame is never sent.
//   unreachable  the peer did not answer, refused the dial, dropped the connection, or timed out.
//                Also what a peer that offers no mouth at all looks like (it closes the dial
//                without a byte, because a stranger is told nothing before it authenticates).
//   no-match     the receiver has NO chat with that key. It does not guess and does not post.
//   ambiguous    the receiver has MORE THAN ONE. Same: it does not guess and does not post.
//   unavailable  the receiver could not read its own chat list to look.
//   send-failed  the receiver found the one chat and the post itself failed.
//   bad-frame    the receiver got a frame it does not serve on the mouth link.
//
// ── WHERE THE EXCLUSION IDENTITIES COME FROM ───────────────────────────────────────────────────
// Explicit config on BOTH nodes: `peer_spine.accounts`, the phone identities of the two accounts
// (config/config-schema.mjs). NOT guessed, and not derived from the roster. Each account sees the
// OTHER as an ordinary member WITH a phone number and itself as the phone-less self entry, so
// dropping "me" is automatic but dropping the co-account is not — and it is the one difference
// still standing between the two views. Both ends must exclude the SAME pair or the keys they
// compute cannot line up, which is why the field is symmetric, spelled out on each node, and
// refused below when it names fewer than two identities.
import { WebSocket as WS } from 'ws';
// The peer's half of the shell handshake — the SAME module the editor and the limb run. The
// secret never rides the wire; a nonce is good for exactly the connection that issued it.
import { parseAuthFrame, responseFrame } from './auth.mjs';
// The wire: the frames and the dial path, defined once (mouth.mjs), read by both ends.
import { MOUTH_PATH, sayFrame, parseMouthFrame } from './mouth.mjs';
// The cross-account primitive this whole feature is built on, and the id normalizer every other
// caller past the bridge boundary uses.
import { crossAccountChatKey } from '../bridges/beeper.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';

// How long the speaker waits for the peer's answer before calling it unreachable. Generous for a
// loopback round trip (measured: dial→open 8ms, open→challenge 1ms) but bounded, because the
// caller is holding a reply it still has to place SOMEWHERE.
const SAY_TIMEOUT_MS = 10_000;
// Both accounts must be excluded for two views of one chat to key alike (header). One identity
// cannot express that, so a block naming fewer is unusable rather than half-working.
const MIN_ACCOUNTS = 2;

/**
 * READ THE PEER BLOCK. Absent ⇒ null ⇒ no peer, no dialling, no behaviour change — the whole
 * additivity requirement in one function.
 *
 * A block that is PRESENT but unusable also reads as null (fail closed: never dial half-configured
 * at a console port), and says so through onLog, because a silent null there is an operator
 * staring at a feature that does nothing.
 *
 * @param {object} cfg      the node config (boot holds it as `cfg`; nothing here reads a file).
 * @param {(m: string) => void} [onLog]
 * @returns {{consolePort: number, consoleToken: string, accounts: string[]}|null}
 */
export function peerSpineFrom(cfg, onLog = () => {}) {
  const p = cfg?.peer_spine;
  if (p == null) return null;                       // the ordinary single-spine node: nothing to say
  if (typeof p !== 'object' || Array.isArray(p)) { onLog('peer-mouth: peer_spine is not a block — ignoring it (no peer link)'); return null; }
  const port = Number(p.console_port);
  const token = typeof p.console_token === 'string' ? p.console_token.trim() : '';
  const accounts = (Array.isArray(p.accounts) ? p.accounts : [p.accounts])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) { onLog(`peer-mouth: peer_spine.console_port is not a port (${JSON.stringify(p.console_port)}) — no peer link`); return null; }
  if (!token) { onLog('peer-mouth: peer_spine.console_token is unset — the peer would refuse this node, so there is no peer link (it must equal the PEER node\'s shell.token)'); return null; }
  if (accounts.length < MIN_ACCOUNTS) { onLog(`peer-mouth: peer_spine.accounts names ${accounts.length} identity(ies) — BOTH accounts must be listed or the two spines cannot key the same chat alike, so there is no peer link`); return null; }
  return { consolePort: port, consoleToken: token, accounts };
}

/**
 * THE MAPPING, pure: which of MY chats is the one that key identifies?
 *
 * Refuses on zero and refuses on more than one — it never picks. Duplicated payloads for one chat
 * (the same id twice) count once: that is one chat listed twice, not an ambiguity.
 *
 * @param {object[]} chats   RAW Beeper chat payloads — the /v1/chats shape, roster included.
 *   NOT the bridge's listChats() items, which normalize `participants` away, and NOT chatInfo's
 *   cached `participants` (already reduced to keys). crossAccountChatKey needs the roster itself.
 * @param {string} chatKey
 * @param {string|string[]} exclude   peer_spine.accounts — both accounts' identities.
 */
export function findChatByKey(chats, chatKey, exclude = []) {
  const want = String(chatKey ?? '').trim();
  if (!want) return { ok: false, reason: 'no-key', detail: 'the frame carried no chat key' };
  const hits = new Map();
  for (const c of Array.isArray(chats) ? chats : []) {
    if (crossAccountChatKey(c, exclude) !== want) continue;
    const id = shortChatId(c?.id ?? '');
    if (id) hits.set(id, c);
  }
  const ids = [...hits.keys()];
  if (ids.length === 0) return { ok: false, reason: 'no-match', detail: 'no chat on this account keys to that participant set' };
  if (ids.length > 1) return { ok: false, reason: 'ambiguous', detail: `${ids.length} chats key alike (${ids.join(', ')}) — refusing to pick` };
  return { ok: true, chatId: ids[0] };
}

/**
 * THE RECEIVING HALF — the handler src/bridges/shell-port.mjs calls for a `say: 'post'` frame off
 * an AUTHENTICATED peer connection. It resolves the key against this account's own chats and posts
 * the text VERBATIM. It never runs a turn, never wraps, never signs: the text arrived finished.
 *
 * Absent (no handler passed to the limb) ⇒ the limb refuses peer dials outright, which is what a
 * node with no peer_spine does.
 *
 * @param {object} o
 * @param {(opts?: {full?: boolean}) => Promise<object[]>} o.listChats  RAW chat payloads with
 *   rosters (see findChatByKey). Called with no argument first (the recently-active page) and,
 *   only if nothing keys alike, once more with `{ full: true }` — see the two-step below.
 * @param {(chatId: string, text: string) => Promise<any>} o.post  post verbatim; falsy or a throw
 *   is a failure. boot's wiring is `(chatId, text) => bridge.send(text, { chatId })`.
 * @param {string[]} o.accounts   peer_spine.accounts — the identities excluded when keying.
 * @param {(m: string) => void} [o.onLog]
 */
export function createMouthReceiver({ listChats, post, accounts = [], onLog = () => {} }) {
  return async function onPeerSay({ chatKey, text } = {}) {
    const body = String(text ?? '');
    if (!body) { onLog('mouth: a peer asked for an EMPTY line to be said — refusing'); return { ok: false, reason: 'no-text', detail: 'nothing to say' }; }
    if (!String(chatKey ?? '').trim()) { onLog('mouth: a peer sent no chat key — refusing (a reply in the wrong chat is worse than no reply)'); return { ok: false, reason: 'no-key', detail: 'the frame carried no chat key' }; }
    let found;
    // PAGE ONE FIRST, THE WHOLE ACCOUNT ONLY ON A MISS — the same two-step beeper.resolveChatId
    // already makes, for the same reason. `GET /v1/chats` is cursor-paginated by RECENT ACTIVITY
    // (25 a page; the operator's account walks 18 pages to the end), and the chat a line is being
    // said in has just had a message in it, so it is on the first page nearly always. Walking
    // every page per reply would be unacceptable; never walking would silently demote a chat that
    // has been quiet on THIS account to a local post forever. So: one page, and only if nothing
    // keys alike, one walk. The bridge caches both under one 60s entry, so a burst pays once.
    try {
      found = findChatByKey(await listChats(), chatKey, accounts);
      if (found.reason === 'no-match') found = findChatByKey(await listChats({ full: true }), chatKey, accounts);
    }
    catch (e) { onLog(`mouth: could not read this account's chat list — refusing: ${e?.message ?? e}`); return { ok: false, reason: 'unavailable', detail: e?.message ?? String(e) }; }
    if (!found.ok) { onLog(`mouth: REFUSING to speak — ${found.reason}: ${found.detail}`); return found; }
    try {
      const r = await post(found.chatId, body);
      if (!r) { onLog(`mouth: the post into ${found.chatId} did not go through`); return { ok: false, reason: 'send-failed', detail: `the post into ${found.chatId} was not accepted` }; }
    } catch (e) { onLog(`mouth: the post into ${found.chatId} threw — ${e?.message ?? e}`); return { ok: false, reason: 'send-failed', detail: e?.message ?? String(e) }; }
    onLog(`mouth: said a peer's line in ${found.chatId}`);
    return { ok: true, chatId: found.chatId };
  };
}

/**
 * THE SPEAKING HALF — hand the peer spine a finished line and have it said on the other account.
 *
 * ONE DIAL PER UTTERANCE, deliberately. A held connection would be one more thing to supervise
 * (reconnect backoff, liveness, a stale socket surviving a peer restart) for no gain: a loopback
 * dial plus handshake is milliseconds, and a reply is not a high-frequency event. It also means
 * the link owns no state at all between calls — nothing to get out of sync with the peer.
 *
 * Every failure path returns rather than throws, with a `reason` the caller can act on: the point
 * of reporting a refusal is so the caller can fall back to speaking on its OWN account, and a
 * throw would just become a swallowed log somewhere up the stack.
 *
 * @param {object} o
 * @param {{consolePort: number, consoleToken: string, accounts: string[]}|null} o.peer  peerSpineFrom(cfg)
 * @param {object} o.chat   the RAW Beeper chat payload for the chat being replied in (roster
 *   included — see findChatByKey). The key is computed here, from this, and never guessed.
 * @param {string} o.text   the FINISHED reply. Final text only; streaming is out of scope
 *   (src/shell/mouth.mjs header says why).
 * @param {typeof WS} [o.WebSocket]  INJECTION SEAM — the `ws` client constructor (tests pass a
 *   fake so no real socket opens).
 * @param {number} [o.timeoutMs]
 * @param {(m: string) => void} [o.onLog]
 * @param {typeof globalThis.setTimeout} [o.setTimeout]
 * @param {typeof globalThis.clearTimeout} [o.clearTimeout]
 * @returns {Promise<{ok: true, chatId: string}|{ok: false, reason: string, detail: string}>}
 */
export async function speakThroughPeer({
  peer,
  chat,
  text,
  WebSocket = WS,
  timeoutMs = SAY_TIMEOUT_MS,
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  // THE THREE REFUSALS THAT NEVER TOUCH THE NETWORK. Each is checked before a socket is
  // constructed, so a node with no peer — or a chat that cannot be keyed — dials nothing at all.
  if (!peer) return { ok: false, reason: 'no-peer', detail: 'no peer spine configured' };
  const body = String(text ?? '');
  if (!body) return { ok: false, reason: 'no-text', detail: 'nothing to say' };
  const chatKey = crossAccountChatKey(chat, peer.accounts);
  if (!chatKey) {
    onLog('mouth: this chat cannot be keyed across accounts (no roster, or fewer than two phone identities after the exclusions) — NOT speaking through the peer');
    return { ok: false, reason: 'no-key', detail: 'crossAccountChatKey refused this chat' };
  }

  return await new Promise((resolve) => {
    let done = false;
    let sock = null;
    let timer = null;
    const settle = (r) => {
      if (done) return;
      done = true;
      if (timer != null) { clearTimeoutFn(timer); timer = null; }
      try { sock?.close?.(); } catch { /* closing */ }
      resolve(r);
    };
    const unreachable = (detail) => settle({ ok: false, reason: 'unreachable', detail });

    try { sock = new WebSocket(`ws://127.0.0.1:${peer.consolePort}${MOUTH_PATH}`); }
    catch (e) { return unreachable(`dial threw — ${e?.message ?? e}`); }

    timer = setTimeoutFn(() => unreachable(`the peer did not answer within ${timeoutMs}ms`), timeoutMs);

    sock.on('open', () => onLog(`mouth: dialled the peer spine on :${peer.consolePort} — awaiting its auth challenge`));
    sock.on('message', (buf) => {
      // AUTH FIRST, exactly as the editor does: the challenge is transport, never content. Answer
      // it and push the line in the same breath — the peer processes frames in order, so the say
      // frame lands on an already-verified connection.
      const auth = parseAuthFrame(buf);
      if (auth) {
        if (auth.auth !== 'challenge' || !auth.nonce) return;
        try {
          sock.send(responseFrame(peer.consoleToken, auth.nonce));
          sock.send(sayFrame({ chatKey, text: body }));
        } catch (e) { unreachable(`could not answer the challenge — ${e?.message ?? e}`); }
        return;
      }
      const f = parseMouthFrame(buf);
      if (f?.say !== 'result') return;    // nothing else is expected on this link; ignore, don't guess
      if (f.ok) return settle({ ok: true, chatId: f.chatId });
      onLog(`mouth: the peer REFUSED to say it — ${f.reason}${f.detail ? `: ${f.detail}` : ''}`);
      settle({ ok: false, reason: f.reason || 'send-failed', detail: f.detail });
    });
    // A close before a result is the peer refusing the dial (wrong token, no mouth configured, or
    // no spine there at all) — a stranger is told nothing before it authenticates, so a silent
    // close is exactly what those look like from here.
    sock.on('close', () => unreachable('the peer closed the link before answering'));
    sock.on('error', (e) => unreachable(`socket error — ${e?.message ?? e}`));
  });
}
