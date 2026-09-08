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
// configured AND the peer's account is a participant of the chat being replied in, the reply is
// opened through startPeerStream instead of on this account's own bridge. boot.mjs builds both
// halves (makePeerMouth for the speaker, createMouthReceiver handed to the shell-port limb as its
// onPeerSay). Every refusal below falls back — to a finished line through the peer, then to a
// LOCAL post on the caller's own account: a reply from the wrong mouth is cosmetic, a reply that
// never arrives is not.
//
// ── THE HARD PART IS NOT THE SOCKET, IT IS FINDING THE CHAT ────────────────────────────────────
// The two accounts see the SAME real group as DIFFERENT Matrix rooms, and NOTHING in the two
// payloads is shared — measured live on one machine, one underlying group:
//
//   primary   sees it as  !6ljZ…:beeper.local   localChatID 211
//   secondary sees it as  !HuXF…:beeper.local   localChatID 3
//
// So a chatId cannot cross the link. beeper.crossAccountChatKey() is the primitive that can: the
// chat's TYPE plus the sorted set of participant PHONE NUMBERS, digits-normalised, excluding the
// identities the caller holds — byte-identical across both accounts' views of one group when BOTH
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
//                too few phone identities left after the exclusions (a group needs one, anything
//                else two). The key would not be EVIDENCE, and a non-evidence key matches
//                everything to everything. Refused BEFORE any dial: the frame is never sent.
//   unreachable  the peer did not answer, refused the dial, dropped the connection, or timed out.
//                Also what a peer that offers no mouth at all looks like (it closes the dial
//                without a byte, because a stranger is told nothing before it authenticates).
//   no-match     the receiver has NO chat with that key. It does not guess and does not post.
//   ambiguous    the receiver has MORE THAN ONE. Same: it does not guess and does not post.
//   unavailable  the receiver could not read its own chat list to look.
//   send-failed  the receiver found the one chat and the post itself failed.
//   bad-frame    the receiver got a frame it does not serve on the mouth link.
//   no-stream    the receiver's own bridge cannot edit a message in place, so it cannot hold a
//                reply train. Only `say: 'open'` can produce it, and the speaker answers it by
//                degrading to `say: 'post'`, which every version of this file has always served.
//   no-react     the receiver's own bridge cannot list its messages or cannot place a reaction, so
//                it cannot serve `say: 'react'` at all. Only that verb can produce it.
//
// `no-key`, `no-match` and `ambiguous` mean the same three things for a MESSAGE as they already
// mean for a chat, and are answered the same way (findMessageByKey below). One vocabulary, not two.
//
// ── THE REPLY TRAIN ACROSS THE LINK (operator 2026-09-05, "let's recover the thinking train") ──
// A LOCAL reply posts "⏳ Thinking…" the instant the turn starts and EDITS that one message in
// place until it is the answer. The first cut of the link could not carry that, so a peer-routed
// reply arrived as silence followed by the whole answer at once. It carries it now, and the shape
// is the one thing worth remembering about this file: THE RECEIVER KEEPS THE LIVE STREAM OBJECT.
// The brain gets back an opaque, receiver-minted id — a key into `live` below — and every later
// frame says "update the stream you opened for me". No Beeper message id crosses the wire, in
// either direction, so the brain cannot address an edit to a message even by accident.
//
// ── THE MID-STREAM DROP, and the decision (this is the hard part) ──────────────────────────────
// If the link dies after the placeholder is posted, the peer's account is holding a "⏳ Thinking…"
// message that only the receiver can finish — the brain has no id for it and, by the paragraph
// above, never will. A message stranded mid-thought on the OTHER account is the worst outcome
// available here, worse than never streaming at all, so this is decided rather than left to luck:
//
//   THE RECEIVER FINISHES ITS OWN ORPHANS, ON SOCKET CLOSE, WITH A VISIBLE MARKER.
//
// Why close and not a timeout: close is the fact itself, delivered by the OS, with no window in
// which the message sits stranded and no timer per stream. Why not the brain re-dialling: a drop
// is most often the brain DYING, and a rule that needs the dead party to act is not a rule. Why
// no timeout as a backstop either — the case a timeout would add is a link that stays open while
// the brain wedges and never finishes, and that is EXACTLY what a hung local turn already looks
// like today (a local "⏳ Thinking…" that never resolves). Parity with the local path is the
// right ceiling here; inventing a deadline the local path does not have would make a peer-routed
// reply MORE fragile than a local one, which is the opposite of the point.
//
// HOW A NORMAL COMPLETION IS TOLD APART FROM A DROP — the one bug this design could have. The
// socket is opened per REPLY and closed the moment the reply settles, so "the link dropped" and
// "the reply ended" arrive as the same 'close' event. They are distinguished by PRESENCE, not by
// timing: `finish` deletes the entry from `live` BEFORE it awaits the underlying edit, so the
// close that follows a completed reply finds nothing to finish and does nothing. Only an entry
// still in `live` when its connection goes is an orphan. (beeper.mjs's own handle is idempotent —
// its `finished` flag makes a second finish a no-op — so even a lost race cannot double-write.)
//
// WHAT THE ORPHAN SAYS: the last text the brain sent, plus INTERRUPTED below. Not the bare partial
// (that would pass a truncated answer off as the finished one) and never a delete (operator
// 2026-08-24, "nothing is ever deleted" — a vanished message teaches nobody what went wrong).
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
import { MOUTH_PATH, sayFrame, sayOpenFrame, sayUpdateFrame, sayFinishFrame, sayReactFrame, parseMouthFrame } from './mouth.mjs';
// The cross-account primitives this whole feature is built on — one for the CHAT, one for the
// MESSAGE inside it — and the id normalizer every other caller past the bridge boundary uses. Both
// keys are minted in the bridge, where the payloads and the crypto live; nothing is re-derived here.
import { crossAccountChatKey, crossAccountMsgKey, _msgTimestampMs } from '../bridges/beeper.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';

// How long the speaker waits for the peer's answer before calling it unreachable. Generous for a
// loopback round trip (measured: dial→open 8ms, open→challenge 1ms) but bounded, because the
// caller is holding a reply it still has to place SOMEWHERE.
const SAY_TIMEOUT_MS = 10_000;
// Both accounts must be excluded for two views of one chat to key alike (header). One identity
// cannot express that, so a block naming fewer is unusable rather than half-working.
const MIN_ACCOUNTS = 2;
// What an ORPHANED reply train settles on when its connection goes (header, THE MID-STREAM DROP).
// It is appended to whatever had already been streamed, so a human reading the chat sees exactly
// what was written and then, unmistakably, that it stopped there — never a truncated answer
// wearing the shape of a finished one. It is posted VERBATIM like every other frame on this link,
// so it carries no persona stamp and no node signature: the receiver is not speaking as a being
// here, it is closing a message the other spine abandoned.
const INTERRUPTED = '⚠️ interrupted — the link to the spine writing this reply dropped.';

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
 * THE SAME MAPPING ONE LEVEL DOWN, pure: which of MY messages is the one that key names?
 *
 * Deliberately shaped like findChatByKey above, refusal vocabulary included, because it is the
 * same question about a smaller thing — and because a REACTION on the wrong message is the
 * message-sized version of a reply in the wrong chat: public, and unnoticed until it is.
 *
 * THE TIMESTAMP IS A TIE-BREAK, NOT A FILTER, and the distinction is the whole design. One match
 * is answered whatever its timestamp says, because the two accounts' clocks are not the question —
 * the CONTENT already identified the message. The timestamp is consulted only when the content did
 * NOT identify it, i.e. when a chat holds two messages with the same body. That is not exotic
 * ("ok", "👍", "jaja"), which is exactly why the frame carries it.
 *
 * AND IT STILL FAILS CLOSED. Zero matches: nothing. Several matches and none of them at that
 * timestamp: nothing. Several matches AT that timestamp: nothing. Never a guess, never "the newest
 * one" — the caller's fallback is to place no reaction at all, which is a strictly better outcome
 * than one on the wrong message.
 *
 * @param {object[]} messages   RAW Beeper message payloads — the /v1/chats/{c}/messages shape
 *   (bridge.listMessagesRaw). Not normalized: crossAccountMsgKey reads `text` itself, exactly as
 *   findChatByKey's crossAccountChatKey reads the roster itself.
 * @param {string} msgKey       the cross-account message key off the frame.
 * @param {number} [timestamp]  the message's own timestamp in epoch ms, off the same frame. 0 or
 *   absent ⇒ no tie-break available ⇒ several matches stay ambiguous.
 */
export function findMessageByKey(messages, msgKey, timestamp = 0) {
  const want = String(msgKey ?? '').trim();
  if (!want) return { ok: false, reason: 'no-key', detail: 'the frame carried no message key' };
  const hits = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.id == null) continue;
    if (crossAccountMsgKey(m) !== want) continue;
    hits.set(String(m.id), m);                       // the same id listed twice is ONE message
  }
  let ids = [...hits.keys()];
  if (ids.length === 0) return { ok: false, reason: 'no-match', detail: 'no message on this account keys to that body' };
  if (ids.length > 1) {
    const ts = Number(timestamp) || 0;
    const same = ts ? ids.filter((id) => _msgTimestampMs(hits.get(id)) === ts) : [];
    if (same.length !== 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        detail: `${ids.length} messages key alike (${ids.join(', ')})${ts ? ` and ${same.length} of them at ${new Date(ts).toISOString()}` : ' and the frame carried no timestamp'} — refusing to pick`,
      };
    }
    ids = same;
  }
  return { ok: true, msgId: ids[0] };
}

/**
 * THE RECEIVING HALF — the VERB TABLE src/bridges/shell-port.mjs dispatches an AUTHENTICATED peer
 * connection's frames into. One entry per wire verb (mouth.mjs), plus `gone`, which is not a verb
 * at all: it is the limb telling this table that a connection went away, and it is the whole
 * answer to the mid-stream drop (header).
 *
 * Every entry resolves the cross-account key against THIS account's own chats and then posts or
 * edits VERBATIM. None of them ever runs a turn, wraps, or signs: the text arrived finished.
 *
 * Absent (no table passed to the limb) ⇒ the limb refuses peer dials outright, which is what a
 * node with no peer_spine does. A table whose `startStream` is missing serves `post` alone and
 * refuses `open` with `no-stream`, which the speaker answers by degrading to `post` — so a node
 * whose bridge cannot edit in place still says its peer's replies, just without the train.
 *
 * @param {object} o
 * @param {(opts?: {full?: boolean}) => Promise<object[]>} o.listChats  RAW chat payloads with
 *   rosters (see findChatByKey). Called with no argument first (the recently-active page) and,
 *   only if nothing keys alike, once more with `{ full: true }` — see the two-step below.
 * @param {(chatId: string, text: string) => Promise<any>} o.post  post verbatim; falsy or a throw
 *   is a failure. boot's wiring is `(chatId, text) => bridge.postVerbatim(chatId, text)`.
 * @param {((chatId: string, init: string) => {update: Function, finish: Function, delivered: boolean})} [o.startStream]
 *   open a live, edit-in-place message on THIS account, posting `init` verbatim as its
 *   placeholder. boot's wiring is `bridge.startStreamVerbatim` — the UNWRAPPED stream, for the
 *   same reason `post` is postVerbatim and not send (beeper-port.mjs). Absent ⇒ no `open`.
 * @param {((chatId: string) => Promise<object[]>)} [o.listMessages]  RAW message payloads for ONE
 *   of this account's chats (boot's wiring is `bridge.listMessagesRaw`). Only `react` reads it —
 *   it is how a message named by CONTENT is found among this account's own copies. Absent ⇒ no
 *   `react`, exactly as an absent `startStream` means no `open`.
 * @param {((chatId: string, msgId: string, emoji: string) => Promise<any>)} [o.react]  place a
 *   reaction on one of this account's own messages (boot's wiring is `bridge.react`, the same
 *   primitive the /react limb and the steer ack already use). Absent ⇒ no `react`.
 * @param {string[]} o.accounts   peer_spine.accounts — the identities excluded when keying.
 * @param {(m: string) => void} [o.onLog]
 */
export function createMouthReceiver({ listChats, post, startStream = null, listMessages = null, react = null, accounts = [], onLog = () => {} }) {
  // THE LIVE STREAMS THIS ACCOUNT IS HOLDING FOR ITS PEER. Keyed by the id this module mints —
  // the only id that ever crosses the wire, and one the brain can do nothing with but name.
  // `conn` is the socket that opened it, which is what makes `gone` below exact.
  const live = new Map();   // streamId -> { handle, chatId, conn, last }
  let minted = 0;

  // WHICH OF MY CHATS IS IT — the two-step both `post` and `open` run, identically, because both
  // must land in the same room and neither may guess.
  //
  // PAGE ONE FIRST, THE WHOLE ACCOUNT ONLY ON A MISS — the same two-step beeper.resolveChatId
  // already makes, for the same reason. `GET /v1/chats` is cursor-paginated by RECENT ACTIVITY
  // (25 a page; the operator's account walks 18 pages to the end), and the chat a line is being
  // said in has just had a message in it, so it is on the first page nearly always. Walking
  // every page per reply would be unacceptable; never walking would silently demote a chat that
  // has been quiet on THIS account to a local post forever. So: one page, and only if nothing
  // keys alike, one walk. The bridge caches both under one 60s entry, so a burst pays once.
  const whichChat = async (chatKey) => {
    if (!String(chatKey ?? '').trim()) { onLog('mouth: a peer sent no chat key — refusing (a reply in the wrong chat is worse than no reply)'); return { ok: false, reason: 'no-key', detail: 'the frame carried no chat key' }; }
    let found;
    try {
      found = findChatByKey(await listChats(), chatKey, accounts);
      if (found.reason === 'no-match') found = findChatByKey(await listChats({ full: true }), chatKey, accounts);
    }
    catch (e) { onLog(`mouth: could not read this account's chat list — refusing: ${e?.message ?? e}`); return { ok: false, reason: 'unavailable', detail: e?.message ?? String(e) }; }
    if (!found.ok) onLog(`mouth: REFUSING to speak — ${found.reason}: ${found.detail}`);
    return found;
  };

  return {
    // `say: 'post'` — ONE finished sentence, one message. The verb this link shipped with, and
    // still the floor every degraded path in the speaker below lands on.
    async post({ chatKey, text } = {}) {
      const body = String(text ?? '');
      if (!body) { onLog('mouth: a peer asked for an EMPTY line to be said — refusing'); return { ok: false, reason: 'no-text', detail: 'nothing to say' }; }
      const found = await whichChat(chatKey);
      if (!found.ok) return found;
      try {
        const r = await post(found.chatId, body);
        if (!r) { onLog(`mouth: the post into ${found.chatId} did not go through`); return { ok: false, reason: 'send-failed', detail: `the post into ${found.chatId} was not accepted` }; }
      } catch (e) { onLog(`mouth: the post into ${found.chatId} threw — ${e?.message ?? e}`); return { ok: false, reason: 'send-failed', detail: e?.message ?? String(e) }; }
      onLog(`mouth: said a peer's line in ${found.chatId}`);
      return { ok: true, chatId: found.chatId };
    },

    // `say: 'open'` — the placeholder. Posted the instant the key resolves, which is the whole
    // point of the feature: the human sees "⏳ Thinking…" while the other spine is still thinking.
    async open({ chatKey, init } = {}, conn = null) {
      if (!startStream) { onLog('mouth: a peer asked for a reply TRAIN but this account\'s bridge cannot edit in place — refusing (it will fall back to a finished line)'); return { ok: false, reason: 'no-stream', detail: 'this bridge cannot edit a message in place' }; }
      const placeholder = String(init ?? '');
      if (!placeholder) { onLog('mouth: a peer asked to open a reply with an EMPTY placeholder — refusing'); return { ok: false, reason: 'no-text', detail: 'nothing to post as the placeholder' }; }
      const found = await whichChat(chatKey);
      if (!found.ok) return found;
      let handle;
      try { handle = startStream(found.chatId, placeholder); }
      catch (e) { onLog(`mouth: could not open a reply train in ${found.chatId} — ${e?.message ?? e}`); return { ok: false, reason: 'send-failed', detail: e?.message ?? String(e) }; }
      if (!handle) { onLog(`mouth: the reply train in ${found.chatId} did not open`); return { ok: false, reason: 'send-failed', detail: `no stream opened in ${found.chatId}` }; }
      const id = `s${++minted}`;
      live.set(id, { handle, chatId: found.chatId, conn, last: '' });
      onLog(`mouth: opened a peer's reply train in ${found.chatId} (${id})`);
      return { ok: true, stream: id, chatId: found.chatId };
    },

    // `say: 'update'` — one in-place edit. NOT answered (mouth.mjs): every frame carries the whole
    // text, so a dropped one is superseded by the next, and an ack per token would double the
    // frames on the link for nothing. An unknown id is logged and dropped, never guessed at:
    // editing SOME OTHER live message because an id went stale is exactly the class of mistake
    // this whole file is built to refuse.
    update({ stream, text } = {}, conn = null) {
      const e = live.get(String(stream ?? ''));
      if (!e || (conn && e.conn !== conn)) { onLog(`mouth: a peer sent an update for a reply train that is not open here (${stream}) — dropped`); return null; }
      e.last = String(text ?? '');
      try { e.handle.update?.(e.last); } catch (err) { onLog(`mouth: an update to ${e.chatId} threw — ${err?.message ?? err}`); }
      return null;
    },

    // `say: 'finish'` — settle the message on its final text and answer, exactly as `post` does,
    // so the brain learns whether the reply is actually said.
    //
    // THE DELETE COMES FIRST, and it is load-bearing (header): dropping the entry BEFORE awaiting
    // the edit is what tells the socket close that follows a completed reply apart from the close
    // of a link that died mid-thought. Only an entry still here when its connection goes is an
    // orphan.
    async finish({ stream, text } = {}, conn = null) {
      const id = String(stream ?? '');
      const e = live.get(id);
      if (!e || (conn && e.conn !== conn)) { onLog(`mouth: a peer asked to finish a reply train that is not open here (${stream}) — refusing`); return { ok: false, reason: 'no-match', detail: 'no such open reply on this account' }; }
      live.delete(id);
      const body = String(text ?? '') || e.last;
      try {
        await e.handle.finish?.(body);
        if (!e.handle.delivered) { onLog(`mouth: the reply train in ${e.chatId} did not settle in place`); return { ok: false, reason: 'send-failed', detail: e.handle.lastError || `the final edit in ${e.chatId} was not accepted` }; }
      } catch (err) { onLog(`mouth: finishing the reply train in ${e.chatId} threw — ${err?.message ?? err}`); return { ok: false, reason: 'send-failed', detail: err?.message ?? String(err) }; }
      onLog(`mouth: settled a peer's reply train in ${e.chatId}`);
      return { ok: true, chatId: e.chatId };
    },

    // `say: 'react'` — the 👀 the brain wants on the message it was steered by, placed by THIS
    // account because this account is the one saying the reply (operator 2026-09-07). It is the
    // only verb that names a MESSAGE, and it names it the way the link names everything: by a key
    // both accounts compute alike, never by an id (mouth.mjs).
    //
    // THE ORDER IS THE CHAT FIRST, ALWAYS. whichChat() is the same two-step `post` and `open` run,
    // unchanged, and the message is looked for ONLY inside the one chat it resolves — so a body
    // that happens to repeat in some other conversation can never be reacted to. Then the message,
    // then the timestamp as the tie-break (findMessageByKey).
    //
    // AND IT REFUSES RATHER THAN GUESSES, which is why the whole thing is safe: the caller's
    // fallback is NO reaction at all (src/spine/turns.mjs) — the behaviour this link had before
    // the verb existed — and no reaction is strictly better than one from the wrong account or on
    // the wrong message. Both were the bug; neither is the fix.
    async react({ chatKey, msgKey, timestamp, emoji } = {}) {
      if (!listMessages || !react) { onLog('mouth: a peer asked for a reaction but this account\'s bridge cannot place one — refusing (nobody will react)'); return { ok: false, reason: 'no-react', detail: 'this bridge cannot list its messages or cannot react' }; }
      const key = String(emoji ?? '');
      if (!key) { onLog('mouth: a peer asked for an EMPTY reaction — refusing'); return { ok: false, reason: 'no-text', detail: 'nothing to react with' }; }
      const found = await whichChat(chatKey);
      if (!found.ok) return found;
      let messages;
      try { messages = await listMessages(found.chatId); }
      catch (e) { onLog(`mouth: could not read the messages of ${found.chatId} — refusing to react: ${e?.message ?? e}`); return { ok: false, reason: 'unavailable', detail: e?.message ?? String(e) }; }
      const hit = findMessageByKey(messages, msgKey, timestamp);
      if (!hit.ok) { onLog(`mouth: REFUSING to react in ${found.chatId} — ${hit.reason}: ${hit.detail}`); return hit; }
      try {
        // `react` here is the INJECTED bridge primitive, not this method: an object-literal method
        // introduces no binding of its own name, so the identifier still resolves to the closure.
        const r = await react(found.chatId, hit.msgId, key);
        if (r === false || r == null) { onLog(`mouth: the reaction on ${found.chatId}/${hit.msgId} did not go through`); return { ok: false, reason: 'send-failed', detail: `the reaction on ${found.chatId}/${hit.msgId} was not accepted` }; }
      } catch (e) { onLog(`mouth: the reaction on ${found.chatId}/${hit.msgId} threw — ${e?.message ?? e}`); return { ok: false, reason: 'send-failed', detail: e?.message ?? String(e) }; }
      onLog(`mouth: placed a peer's ${key} on ${found.chatId}/${hit.msgId}`);
      return { ok: true, chatId: found.chatId };
    },

    // NOT A WIRE VERB — the limb calls it when a peer connection goes away, and shell-port's verb
    // table deliberately does not expose it, so no frame can ever reach it. THE MID-STREAM DROP
    // (header): whatever this connection still had open is an orphan, and this is the only place
    // in the system holding the handle that can close it.
    gone(conn) {
      for (const [id, e] of [...live]) {
        if (e.conn !== conn) continue;
        live.delete(id);
        onLog(`mouth: the peer's link dropped with a reply still open in ${e.chatId} — settling it here rather than leaving it thinking forever`);
        Promise.resolve()
          .then(() => e.handle.finish?.(e.last ? `${e.last}\n\n${INTERRUPTED}` : INTERRUPTED))
          .catch((err) => onLog(`mouth: could not settle the orphaned reply in ${e.chatId} — ${err?.message ?? err}`));
      }
    },
  };
}

// ── THE DIAL, ONCE ─────────────────────────────────────────────────────────────────────────────
// Both speakers below need the same four things — construct the socket, answer the challenge,
// read mouth frames off it, and notice when it goes — so they get them from here rather than from
// two copies that would drift. It is deliberately NOT a connection pool: the socket it opens
// belongs to ONE utterance or ONE reply train and is closed when that settles. Holding the link
// open between replies is a separate change with its own reconnect and liveness questions, and
// entangling it with the wire protocol would make both harder to reason about.
//
// The watchdog is RE-ARMABLE rather than a single deadline, because the two callers need it at
// different moments: a finished-line utterance is one bounded round trip, but a reply TRAIN is
// bounded only while it is opening and while it is settling — the model's own thinking time sits
// in between and may be minutes. So `expire` is armed for a round trip and disarmed once the
// answer that round trip was waiting for arrives.
//
// @returns {{send: (raw: string) => boolean, expire: (ms: number, detail: string) => void,
//            disarm: () => void, close: () => void, alive: boolean}}
function connectPeer({
  peer,
  WebSocket = WS,
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  onFrame = () => {},
  onGone = () => {},
} = {}) {
  let sock = null, timer = null, dead = false, authed = false;
  // Frames pushed before the challenge is answered wait here. The caller pushes its first frame
  // synchronously (that is what keeps the placeholder off a round trip — mouth.mjs), and the
  // handshake has not happened yet at that instant.
  const queue = [];
  const shut = () => {
    if (dead) return;
    dead = true;
    if (timer != null) { clearTimeoutFn(timer); timer = null; }
    try { sock?.close?.(); } catch { /* closing */ }
  };
  const die = (detail) => { if (dead) return; shut(); onGone(detail); };
  const raw = (frame) => {
    try { sock.send(frame); return true; }
    catch (e) { die(`could not write to the peer — ${e?.message ?? e}`); return false; }
  };

  try { sock = new WebSocket(`ws://127.0.0.1:${peer.consolePort}${MOUTH_PATH}`); }
  catch (e) {
    // Deferred by a microtask so the caller has finished wiring its own handlers before it is
    // told the dial failed — a synchronous onGone would fire into a half-built caller.
    queueMicrotask(() => die(`dial threw — ${e?.message ?? e}`));
    return { send: () => false, expire: () => {}, disarm: () => {}, close: () => {}, get alive() { return false; } };
  }

  sock.on('open', () => onLog(`mouth: dialled the peer spine on :${peer.consolePort} — awaiting its auth challenge`));
  sock.on('message', (buf) => {
    // AUTH FIRST, exactly as the editor does: the challenge is transport, never content. Answer
    // it and flush whatever the caller queued in the same breath — the peer processes frames in
    // order, so they land on an already-verified connection.
    const auth = parseAuthFrame(buf);
    if (auth) {
      if (auth.auth !== 'challenge' || !auth.nonce) return;
      if (!raw(responseFrame(peer.consoleToken, auth.nonce))) return;
      authed = true;
      while (queue.length) { if (!raw(queue.shift())) return; }
      return;
    }
    const f = parseMouthFrame(buf);
    if (f) onFrame(f);
  });
  // A close before an answer is the peer refusing the dial (wrong token, no mouth configured, or
  // no spine there at all) — a stranger is told nothing before it authenticates, so a silent
  // close is exactly what those look like from here.
  sock.on('close', () => die('the peer closed the link before answering'));
  sock.on('error', (e) => die(`socket error — ${e?.message ?? e}`));

  return {
    send(frame) { if (dead) return false; if (!authed) { queue.push(frame); return true; } return raw(frame); },
    expire(ms, detail) { if (dead) return; if (timer != null) clearTimeoutFn(timer); timer = setTimeoutFn(() => die(detail), ms); },
    disarm() { if (timer != null) { clearTimeoutFn(timer); timer = null; } },
    close: shut,
    get alive() { return !dead; },
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
 * STILL LOAD-BEARING now that startPeerStream exists: it is the FLOOR every degraded path lands
 * on. A peer running the pre-streaming code refuses `open` and serves this; a link that dies
 * mid-train is retried through this on a fresh socket. One finished sentence, one message.
 *
 * Every failure path returns rather than throws, with a `reason` the caller can act on: the point
 * of reporting a refusal is so the caller can fall back to speaking on its OWN account, and a
 * throw would just become a swallowed log somewhere up the stack.
 *
 * @param {object} o
 * @param {{consolePort: number, consoleToken: string, accounts: string[]}|null} o.peer  peerSpineFrom(cfg)
 * @param {object} o.chat   the RAW Beeper chat payload for the chat being replied in (roster
 *   included — see findChatByKey). The key is computed here, from this, and never guessed.
 * @param {string} o.text   the FINISHED reply.
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
    onLog('mouth: this chat cannot be keyed across accounts (no roster, or too few phone identities after the exclusions — a group needs one, anything else two) — NOT speaking through the peer');
    return { ok: false, reason: 'no-key', detail: 'crossAccountChatKey refused this chat' };
  }

  return await new Promise((resolve) => {
    let done = false;
    let link = null;
    const settle = (r) => { if (done) return; done = true; link?.close(); resolve(r); };
    link = connectPeer({
      peer,
      WebSocket,
      onLog,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      onFrame: (f) => {
        if (f.say !== 'result') return;    // nothing else is expected on this link; ignore, don't guess
        if (f.ok) return settle({ ok: true, chatId: f.chatId });
        onLog(`mouth: the peer REFUSED to say it — ${f.reason}${f.detail ? `: ${f.detail}` : ''}`);
        settle({ ok: false, reason: f.reason || 'send-failed', detail: f.detail });
      },
      onGone: (detail) => settle({ ok: false, reason: 'unreachable', detail }),
    });
    link.expire(timeoutMs, `the peer did not answer within ${timeoutMs}ms`);
    link.send(sayFrame({ chatKey, text: body }));
  });
}

/**
 * THE SPEAKING HALF, FOR A REACTION — have the peer place the 👀 on the message it is answering.
 *
 * SHAPED EXACTLY LIKE speakThroughPeer, deliberately: same dial, same one-utterance socket, same
 * `result` frame, same refusal vocabulary, same "return, never throw" contract. The only
 * difference is what the frame names — a message inside the chat rather than the chat alone — so
 * there is nothing here to keep in sync with the finished-line path.
 *
 * AND NO TIERS. speakThroughPeer's caller degrades to this account's own mouth because a reply
 * MUST arrive; a 👀 must not. Placing it here is precisely the fault being fixed (the read receipt
 * comes from the account that is not answering), so every refusal below ends with NO REACTION
 * ANYWHERE, which is the behaviour this link had before the verb existed. The caller logs why.
 *
 * @param {object} o
 * @param {{consolePort: number, consoleToken: string, accounts: string[]}|null} o.peer
 * @param {object} o.chat        the RAW Beeper chat payload for the chat the message is in — the
 *   same one speakThroughPeer takes, keyed here for the same reason and by the same primitive.
 * @param {string} o.msgKey      the cross-account message key (beeper.crossAccountMsgKey), minted
 *   in the bridge and carried on the inbound event as `msgHash`.
 * @param {number} o.timestamp   that message's own timestamp in epoch ms (`ev.msgTs`).
 * @param {string} o.emoji       the reaction key (👀 for the steer ack).
 * @param {typeof WS} [o.WebSocket]
 * @param {number} [o.timeoutMs]
 * @param {(m: string) => void} [o.onLog]
 * @param {typeof globalThis.setTimeout} [o.setTimeout]
 * @param {typeof globalThis.clearTimeout} [o.clearTimeout]
 * @returns {Promise<{ok: true, chatId: string}|{ok: false, reason: string, detail: string}>}
 */
export async function reactThroughPeer({
  peer,
  chat,
  msgKey,
  timestamp = 0,
  emoji,
  WebSocket = WS,
  timeoutMs = SAY_TIMEOUT_MS,
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  // THE FOUR REFUSALS THAT NEVER TOUCH THE NETWORK, the same three speakThroughPeer makes plus the
  // one this verb adds: a message this node could not key (a voice note, an attachment with no
  // caption) can never be named on the other account, so there is nothing to dial for.
  if (!peer) return { ok: false, reason: 'no-peer', detail: 'no peer spine configured' };
  const key = String(emoji ?? '');
  if (!key) return { ok: false, reason: 'no-text', detail: 'nothing to react with' };
  const wantMsg = String(msgKey ?? '').trim();
  if (!wantMsg) {
    onLog('mouth: this message cannot be keyed across accounts (no body to hash) — the peer cannot be told which message, so NOBODY reacts');
    return { ok: false, reason: 'no-key', detail: 'the message carries no cross-account key' };
  }
  const chatKey = crossAccountChatKey(chat, peer.accounts);
  if (!chatKey) {
    onLog('mouth: this chat cannot be keyed across accounts (no roster, or too few phone identities after the exclusions) — NOT reacting through the peer');
    return { ok: false, reason: 'no-key', detail: 'crossAccountChatKey refused this chat' };
  }

  return await new Promise((resolve) => {
    let done = false;
    let link = null;
    const settle = (r) => { if (done) return; done = true; link?.close(); resolve(r); };
    link = connectPeer({
      peer,
      WebSocket,
      onLog,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      onFrame: (f) => {
        if (f.say !== 'result') return;    // nothing else is expected on this link; ignore, don't guess
        if (f.ok) return settle({ ok: true, chatId: f.chatId });
        onLog(`mouth: the peer REFUSED to place the ${key} — ${f.reason}${f.detail ? `: ${f.detail}` : ''}`);
        settle({ ok: false, reason: f.reason || 'send-failed', detail: f.detail });
      },
      onGone: (detail) => settle({ ok: false, reason: 'unreachable', detail }),
    });
    link.expire(timeoutMs, `the peer did not answer within ${timeoutMs}ms`);
    link.send(sayReactFrame({ chatKey, msgKey: wantMsg, timestamp, emoji: key }));
  });
}

/**
 * THE SPEAKING HALF, LIVE — a reply TRAIN said on the other account: a "⏳ Thinking…" placeholder
 * that appears at once and is edited in place until it is the answer.
 *
 * IT IMPLEMENTS THE SAME SURFACE A LOCAL STREAM DOES — `update(text)`, awaited `finish(text)`,
 * `delivered`, `confirmedId` — which is the whole reason src/spine/sender.mjs needs no second
 * copy of its finish/fallback logic for the peer route. The sender's decision reduces to WHICH
 * FACTORY IT CALLS; everything downstream of that is the code it already had, including the §7
 * fallback that fires on `delivered === false`.
 *
 * ONE DIAL PER REPLY, never per frame: the socket is opened here, held for the life of the train,
 * and closed when it settles. Holding it open BETWEEN replies is a separate question — it brings
 * reconnect and liveness with it — and is deliberately not entangled with this protocol.
 *
 * WHAT THE PLACEHOLDER COSTS, honestly. The open frame is queued the instant the socket exists and
 * goes out with the first byte the handshake allows, so before the "⏳" appears on the other
 * account there is: the dial, ONE challenge/response exchange (the peer challenges, this end
 * answers — measured on this machine at dial→open 8ms, open→challenge 1ms), the peer's own
 * cross-account chat lookup, and its post. The lookup is the one that can be slow on a cold cache,
 * and it is not new: it is the same lookup `say: post` has always done, moved from the END of the
 * turn to the start, where it overlaps the model's thinking instead of following it.
 *
 * WHAT IT DOES NOT WAIT FOR is the open ANSWER. Updates pushed before the stream id comes back are
 * BUFFERED, not blocked (every frame carries the whole text, so only the newest matters) and
 * flushed the instant it arrives — so the round trip never delays a token either.
 *
 * ── THREE TIERS, EACH ONE THE NEXT-MOST-DEGRADED, AND ALL THREE ALREADY EXISTED ────────────────
 * The reply must arrive. Refusing to post into the WRONG CHAT is fail-closed; refusing to reply at
 * all is not the same trade, so every failure below ends with the reply somewhere:
 *
 *   1. the train  — `finish` settles the message the peer has been editing. The good path.
 *   2. `speakThroughPeer` on a FRESH dial — the finished line, posted whole, on the peer's
 *      account. This is what an OLD peer (which refuses `open`) gets, and what a train whose link
 *      died mid-thought falls back to. Still the RIGHT account, which is why it comes before 3.
 *   3. `fallback()` — a local stream on THIS account, if the caller supplied a factory. Reached
 *      only when the peer cannot be spoken to at all. Left undelivered if there is none, which
 *      hands the decision back to the sender's §7 fresh send.
 *
 * A LOST ACK CAN THEREFORE DOUBLE-POST, and that is the deliberate side the trade falls on. If the
 * peer settles the reply and the link dies before its `result` gets back, this end cannot tell
 * that from a reply that was never said, so tier 2 says it again. The window is one loopback hop
 * wide, the same one `say: post` has always had, and the alternative — treating "no answer" as
 * "probably said" — loses replies silently. A second copy is visible and fixable; a missing one is
 * neither.
 *
 * @param {object} o
 * @param {{consolePort: number, consoleToken: string, accounts: string[]}|null} o.peer
 * @param {object} o.chat   the RAW Beeper chat payload for the chat being replied in.
 * @param {string} o.init   the PLACEHOLDER text ("⏳ Thinking…"), posted verbatim by the peer.
 * @param {(t: string) => string} [o.render]  THE BRAIN'S OWN WRAP — its persona stamp, its bridge
 *   signature and its node id (src/bridges/beeper-port.mjs renderFrame, handed down by
 *   src/spine/sender.mjs). Applied to every frame that CROSSES THE WIRE and to nothing else; see
 *   the note above `wire` below for why that boundary is exactly the right one. Default identity ⇒
 *   the peer is sent the caller's raw text, exactly as before.
 * @param {(() => object|null)|null} [o.fallback]  open a LOCAL stream on the caller's own account
 *   (sender.mjs's openLocal). Tier 3 above. Absent ⇒ tier 3 is skipped.
 * @param {typeof speakThroughPeer} [o.say]   INJECTION SEAM for tier 2.
 * @param {typeof WS} [o.WebSocket]
 * @param {number} [o.timeoutMs]
 * @param {(m: string) => void} [o.onLog]
 * @param {typeof globalThis.setTimeout} [o.setTimeout]
 * @param {typeof globalThis.clearTimeout} [o.clearTimeout]
 * @param {() => number} [o.now]   clock seam — only ever used to LOG how long the dial took.
 */
export function startPeerStream({
  peer,
  chat,
  init,
  render = (t) => t,
  fallback = null,
  say = speakThroughPeer,
  WebSocket = WS,
  timeoutMs = SAY_TIMEOUT_MS,
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  now = () => Date.now(),
} = {}) {
  let streamId = '';      // the peer's own handle for this train — opaque here, never a message id
  let last = '';          // the newest frame the sender has pushed (whole text, never a delta)
  let local = null;       // tier 3, once taken
  let delivered = false;
  let lastError = null;
  let link = null;
  let settleOpen = null;
  let settleFinish = null;   // set only while a finish frame is in flight (the `result` it awaits)
  // Resolves ONCE, with the peer's `opened` answer or with the reason there will never be one.
  // finish() awaits it; update() does not (it buffers instead), which is what keeps the first
  // token off the round trip.
  const opened = new Promise((r) => { settleOpen = (v) => { if (settleOpen.done) return; settleOpen.done = true; r(v); }; });

  // THE BRAIN'S WRAP, APPLIED AT THE WIRE AND NOWHERE ELSE (operator 2026-09-05). The peer posts
  // VERBATIM and adds nothing — that is its whole contract (beeper-port.postVerbatim /
  // startStreamVerbatim) — so a frame is signed on this side or it is not signed at all, and a
  // peer-routed reply used to go out bare while the same being's local reply carried its stamp.
  //
  // EVERY frame, the ⏳ placeholder included: signing is a property of the SEND, therefore of each
  // one (persona-wrap.mjs's header), and the placeholder is a real message living on the other
  // account for the whole turn. IDEMPOTENT BY CONSTRUCTION, because `last` and `body` stay the RAW
  // core and each wire frame is built from that core rather than from the frame before it — the
  // same property beeper-port's own stream relies on, so replacing one signed frame with the next
  // can never stack "🏰 🏰".
  //
  // AND THE BOUNDARY IS THE POINT. Tier 3 hands the LOCAL stream the raw text instead, because
  // that stream is beeper-port.startStream, which wraps for itself: wrapping before it would be
  // the one way to sign a frame twice. So the rule is simply "rendered on the way out of this
  // process, raw everywhere else" — which is also why tier 2's finished line is rendered at its
  // own call site below rather than inside speakThroughPeer.
  const wire = (t) => render(String(t ?? ''));

  // Tier 3, and the ONE place it is taken. Replays whatever has already streamed into the fresh
  // local placeholder, exactly as sender.mjs's own late openLocal does, so nothing a human should
  // have seen is lost by the switch.
  const goLocal = () => {
    if (local || !fallback) return local;
    try { local = fallback(); } catch (e) { lastError = e?.message ?? String(e); onLog(`mouth: could not open a local placeholder to fall back to — ${lastError}`); return null; }
    if (local && last) { try { local.update?.(last); } catch { /* the finish below carries the text anyway */ } }
    return local;
  };

  // THE REFUSAL THAT NEVER TOUCHES THE NETWORK. A chat that cannot be keyed can never be found on
  // the other account, so there is nothing to dial for — and unlike every other refusal, this one
  // is known SYNCHRONOUSLY, so the local placeholder can be opened right now instead of after a
  // silent wait. speakThroughPeer refuses the same case with the same reason.
  const chatKey = peer ? crossAccountChatKey(chat, peer.accounts) : null;
  if (!chatKey) {
    onLog('mouth: this chat cannot be keyed across accounts — NOT streaming through the peer, this account will say it');
    lastError = 'no-key';
    settleOpen({ ok: false, reason: 'no-key', detail: 'crossAccountChatKey refused this chat' });
    goLocal();
  } else {
    const dialledAt = now();
    link = connectPeer({
      peer,
      WebSocket,
      onLog,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      onFrame: (f) => {
        if (f.say === 'opened') {
          link?.disarm();                      // the train may now take as long as the model does
          if (!f.ok) {
            onLog(`mouth: the peer would not open a reply train — ${f.reason}${f.detail ? `: ${f.detail}` : ''}; this reply will go out as one finished line`);
            lastError = f.reason || 'send-failed';
            return settleOpen(f);
          }
          streamId = f.stream;
          onLog(`mouth: the peer opened the reply train in ${f.chatId} after ${now() - dialledAt}ms (dial + handshake + its own chat lookup)`);
          settleOpen(f);
          if (last) link.send(sayUpdateFrame({ stream: streamId, text: wire(last) }));   // flush what streamed while it was opening
          return;
        }
        if (f.say === 'result') {
          if (settleFinish) {
            if (!f.ok) onLog(`mouth: the peer could not settle the reply train — ${f.reason}${f.detail ? `: ${f.detail}` : ''}`);
            settleFinish(f);
            return;
          }
          // A `post`-shaped answer to an `open` frame: an OLD PEER, one running the code from
          // before the streaming verbs existed, which refuses anything but `say: post` with
          // `bad-frame`. Taken as the open refusal RIGHT HERE rather than left to the open
          // watchdog, because a ten-second stall on every reply is exactly the shape of bug that
          // makes upgrading two spines one at a time unpleasant. Tier 2 says the line instead.
          link?.disarm();
          onLog(`mouth: the peer does not serve reply trains (${f.reason || 'bad-frame'}) — this reply will go out as one finished line`);
          lastError = f.reason || 'bad-frame';
          settleOpen({ ok: false, reason: f.reason || 'bad-frame', detail: f.detail });
        }
      },
      onGone: (detail) => {
        // A drop BEFORE the train opened and a drop MID-TRAIN both land here. Either way the peer
        // is now the only one that can close whatever it posted (it does — see the receiver's
        // `gone`), and this end's job is simply to make sure the reply still arrives: the open
        // promise settles so finish() stops waiting, and finish() then walks the tiers.
        streamId = '';
        lastError = detail;
        settleOpen({ ok: false, reason: 'unreachable', detail });
        settleFinish?.({ ok: false, reason: 'unreachable', detail });
      },
    });
    link.expire(timeoutMs, `the peer did not open the reply within ${timeoutMs}ms`);
    link.send(sayOpenFrame({ chatKey, init: wire(init) }));
  }

  return {
    update(text) {
      last = String(text ?? '');
      if (local) { try { local.update?.(last); } catch { /* an edit that fails is not fatal to the reply */ } return; }
      if (streamId && link?.alive) link.send(sayUpdateFrame({ stream: streamId, text: wire(last) }));
      // else: buffered in `last` — flushed when `opened` arrives, or replayed into tier 2/3.
    },

    async finish(text) {
      const body = String(text ?? '') || last;
      // Tier 3 already taken (a chat that could not be keyed): this is an ordinary local stream.
      if (local) { await local.finish?.(body); delivered = !!local.delivered; return; }
      await opened;
      // TIER 1 — settle the message the peer has been editing all along.
      if (streamId && link?.alive) {
        const r = await new Promise((resolve) => {
          settleFinish = (v) => { settleFinish = null; resolve(v); };
          link.expire(timeoutMs, `the peer did not confirm the reply within ${timeoutMs}ms`);
          if (!link.send(sayFinishFrame({ stream: streamId, text: wire(body) }))) settleFinish?.({ ok: false, reason: 'unreachable', detail: 'the link went before the reply could be settled' });
        });
        link.close();
        if (r?.ok) { delivered = true; onLog(`mouth: the PEER said this reply (its chat ${r.chatId}) — nothing posted on this account`); return; }
        lastError = r?.detail || r?.reason || 'the peer did not settle the reply';
      } else {
        link?.close();
      }
      // TIER 2 — a fresh dial and one finished line, on the PEER's account still. This is what an
      // old peer gets, and what a train whose link died falls back to. The peer's own `gone` has
      // already closed whatever half-written message it was holding, so this posts beside a
      // message that says, in as many words, that it was interrupted.
      const r2 = await Promise.resolve()
        .then(() => say({ peer, chat, text: wire(body), WebSocket, timeoutMs, onLog, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn }))
        .catch((e) => ({ ok: false, reason: 'send-failed', detail: e?.message ?? String(e) }));
      if (r2?.ok) { delivered = true; onLog(`mouth: the reply train could not be settled, so the PEER said this reply whole instead (its chat ${r2.chatId})`); return; }
      onLog(`mouth: FALLING BACK TO THIS ACCOUNT — the peer neither streamed nor said this reply (${r2?.reason || 'no answer'}${r2?.detail ? `: ${r2.detail}` : ''})`);
      lastError = r2?.detail || r2?.reason || lastError;
      // TIER 3 — a local placeholder on this account, if the caller gave us one to open. With no
      // factory `delivered` stays false, which is the sender's signal to send the reply fresh.
      const h = goLocal();
      if (!h) return;
      await h.finish?.(body);
      delivered = !!h.delivered;
    },

    get delivered() { return delivered; },
    get lastError() { return lastError; },
    // NULL after a PEER-said reply, always: the delivered message lives on the other account, in
    // the other spine's id namespace, and an id from there means nothing here (mouth.mjs). Only a
    // tier-3 local fallback has an id this node can use.
    get confirmedId() { return local?.confirmedId ?? null; },
  };
}
